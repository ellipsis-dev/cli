// Claude Code hook management for laptop transcript sync.
//
// `agent hooks install` writes `Stop` + `SessionEnd` handlers into the user's
// ~/.claude/settings.json (user scope: hooks fire in every project; the
// per-REPO consent gate lives in enrollment, not here). Each handler execs
// `agent session sync --hook`, which reads the hook JSON from stdin and
// silently no-ops for unenrolled repos. Stop runs async so a slow upload never
// blocks the developer's session; SessionEnd runs synchronously (the CC
// process is exiting — an async handler may never finish) with a timeout.

import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

export const HOOK_COMMAND = 'agent session sync --hook'
const HOOK_EVENTS = ['Stop', 'SessionEnd'] as const

interface HookHandler {
  type: 'command'
  command: string
  async?: boolean
  timeout?: number
}

interface MatcherGroup {
  matcher?: string
  hooks: HookHandler[]
}

type SettingsHooks = Record<string, MatcherGroup[]>

export function claudeSettingsPath(): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  return join(base, 'settings.json')
}

function isOurs(handler: HookHandler): boolean {
  return (
    handler.type === 'command' &&
    typeof handler.command === 'string' &&
    handler.command.includes('agent session sync')
  )
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

// Idempotently add our Stop + SessionEnd handlers, preserving everything else
// in the settings file (other hooks, other keys). Returns the settings path.
export function installHooks(): string {
  const path = claudeSettingsPath()
  const settings = readSettings(path)
  const hooks = (settings.hooks ?? {}) as SettingsHooks
  for (const event of HOOK_EVENTS) {
    const groups: MatcherGroup[] = hooks[event] ?? []
    // Drop any previous incarnation of our handler, then append the current one.
    for (const group of groups) {
      group.hooks = group.hooks.filter((h) => !isOurs(h))
    }
    const kept = groups.filter((g) => g.hooks.length > 0)
    kept.push({
      hooks: [
        event === 'Stop'
          ? { type: 'command', command: HOOK_COMMAND, async: true }
          : { type: 'command', command: HOOK_COMMAND, timeout: 60 },
      ],
    })
    hooks[event] = kept
  }
  settings.hooks = hooks
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n')
  return path
}

// Remove our handlers (and any matcher groups left empty), preserving
// everything else. Returns the settings path.
export function uninstallHooks(): string {
  const path = claudeSettingsPath()
  const settings = readSettings(path)
  const hooks = settings.hooks as SettingsHooks | undefined
  if (hooks) {
    for (const event of HOOK_EVENTS) {
      const groups = hooks[event]
      if (!groups) continue
      for (const group of groups) {
        group.hooks = group.hooks.filter((h) => !isOurs(h))
      }
      const kept = groups.filter((g) => g.hooks.length > 0)
      if (kept.length > 0) hooks[event] = kept
      else delete hooks[event]
    }
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n')
  }
  return path
}

// Which of our hook events are currently installed.
export function installedHookEvents(): string[] {
  const settings = readSettings(claudeSettingsPath())
  const hooks = settings.hooks as SettingsHooks | undefined
  if (!hooks) return []
  return HOOK_EVENTS.filter((event) =>
    (hooks[event] ?? []).some((g) => g.hooks.some((h) => isOurs(h))),
  )
}
