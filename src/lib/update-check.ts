import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from './config'
import { VERSION } from './constants'
import { compareVersions, installKind } from './install'

// Without a package manager nothing tells a user their CLI is stale, so the
// binary does it itself. Once a day it asks GitHub for the latest release in
// a detached child (`ellipsis update --check --quiet`) and remembers the answer
// in the config dir. The next run prints one line on stderr when that answer
// is newer than itself. Nothing here may slow down or fail the command in
// progress: the network call never happens in this process, and every error
// is dropped.

export interface UpdateState {
  checkedAt: string
  latest?: string
}

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

function updateStateFile(): string {
  return join(configDir(), 'update-check.json')
}

export function readUpdateState(): UpdateState | undefined {
  try {
    const file = updateStateFile()
    if (!existsSync(file)) return undefined
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<UpdateState>
    if (typeof raw.checkedAt !== 'string') return undefined
    return {
      checkedAt: raw.checkedAt,
      latest: typeof raw.latest === 'string' ? raw.latest : undefined,
    }
  } catch {
    return undefined
  }
}

export function writeUpdateState(state: UpdateState): void {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(updateStateFile(), JSON.stringify(state))
}

// Is it time to ask GitHub again?
export function checkIsDue(state: UpdateState | undefined, now: Date): boolean {
  if (!state) return true
  const last = Date.parse(state.checkedAt)
  return Number.isNaN(last) || now.getTime() - last >= CHECK_INTERVAL_MS
}

// The one-line nudge, or undefined when the remembered latest is not newer.
export function updateNudge(state: UpdateState | undefined, current: string): string | undefined {
  if (!state?.latest || compareVersions(state.latest, current) <= 0) return undefined
  return `A newer ellipsis is available: ${state.latest} (you have ${current}). Run \`ellipsis update\`.`
}

// Invocations that must not start a check: they are the check, they are about
// to delete the binary, or they never reach a command at all.
const QUIET_FIRST_ARGS = new Set(['update', 'uninstall', 'help', '--help', '-h', '--version', '-V'])

export function maybeNudgeUpdate(argv: readonly string[]): void {
  try {
    if (process.env.ELLIPSIS_NO_UPDATE_CHECK || process.env.CI) return
    if (!process.stderr.isTTY) return
    if (installKind(process.execPath) !== 'binary') return
    const first = argv[2]
    if (first === undefined || QUIET_FIRST_ARGS.has(first)) return

    const state = readUpdateState()
    const nudge = updateNudge(state, VERSION)
    if (nudge) console.error(nudge)
    if (!checkIsDue(state, new Date())) return

    // Throttle before spawning, so an offline machine asks once a day rather
    // than once a command.
    writeUpdateState({ checkedAt: new Date().toISOString(), latest: state?.latest })
    const child = spawn(process.execPath, ['update', '--check', '--quiet'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELLIPSIS_NO_UPDATE_CHECK: '1' },
    })
    child.unref()
  } catch {
    // The nudge is never worth breaking the command over.
  }
}
