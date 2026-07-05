import type { Command } from 'commander'
import { formatTs, printJson, printTable, runAction } from '../lib/output'
import { toInt } from '../lib/args'
import {
  claudeSettingsPath,
  enrollRepo,
  enrolledRepos,
  hookStatsPath,
  hooksInstalled,
  installHooks,
  readHookStats,
  readSyncLog,
  repoFromCwd,
  spooledPendingCount,
  syncLogPath,
  unenrollRepo,
  uninstallHooks,
  type HookSyncStats,
} from '../lib/laptop'

// `agent hooks …` — manage the Claude Code hooks + per-repo enrollment that
// drive laptop transcript sync (`agent session sync`). Installing the hooks
// alone syncs nothing: consent is per-repo opt-in, so a repo must also be
// enrolled (`agent hooks enroll`, run inside the repo) before its sessions
// are captured.

// Resolve the repo to enroll/unenroll: an explicit "owner/name" arg wins,
// else derive it from the cwd's git remote.
function resolveRepo(explicit: string | undefined): string {
  if (explicit) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(explicit)) {
      throw new Error(`"${explicit}" is not an owner/name repository.`)
    }
    return explicit
  }
  const repo = repoFromCwd(process.cwd())
  if (!repo) {
    throw new Error(
      'Not inside a git repository with an origin remote. Run from the repo, or pass owner/name explicitly.',
    )
  }
  return repo
}

export function registerHooks(program: Command): void {
  const hooks = program
    .command('hooks')
    .description('Manage Claude Code hooks + repo enrollment for transcript sync')

  hooks
    .command('install')
    .description('Install the Stop + SessionEnd hooks that run `agent session sync`')
    .action(async () =>
      runAction(async () => {
        const { path } = installHooks()
        console.log(`Installed Stop + SessionEnd hooks in ${path}.`)
        const enrolled = enrolledRepos()
        if (enrolled.length === 0) {
          console.log(
            'No repositories enrolled yet — nothing will sync. Run `agent hooks enroll` inside a repo to opt it in.',
          )
        }
      }),
    )

  hooks
    .command('uninstall')
    .description('Remove the `agent session sync` hooks (enrollment is kept)')
    .action(async () =>
      runAction(async () => {
        const { path, changed } = uninstallHooks()
        console.log(
          changed ? `Removed sync hooks from ${path}.` : `No sync hooks found in ${path}.`,
        )
      }),
    )

  hooks
    .command('status')
    .description('Show hook installation + enrolled repositories')
    .option('--json', 'print JSON instead of text')
    .action(async (opts: { json?: boolean }) =>
      runAction(async () => {
        const installed = hooksInstalled()
        const enrolled = enrolledRepos()
        const stats = readHookStats()
        if (opts.json) {
          printJson({
            settings: claudeSettingsPath(),
            hooks: installed,
            enrolled_repos: enrolled,
            sync_stats: stats ?? null,
          })
          return
        }
        printTable(
          ['HOOK', 'INSTALLED'],
          Object.entries(installed).map(([event, ok]) => [event, ok ? 'yes' : 'no']),
        )
        console.log('')
        if (enrolled.length === 0) console.log('Enrolled repositories: none')
        else printTable(['ENROLLED REPOSITORY'], enrolled.map((r) => [r]))
        if (stats?.last_sync_at) {
          console.log('')
          console.log(
            `Last sync ${ago(stats.last_sync_at)} (${stats.last_outcome}) · ` +
              `${stats.synced_24h} synced / ${stats.failed_24h} failed in 24h · ` +
              `${spooledPendingCount()} spooled pending`,
          )
        }
      }),
    )

  hooks
    .command('logs')
    .description('Show the activity log the background `agent session sync` hooks write')
    .option('-n, --tail <n>', 'show the last N entries', toInt, 20)
    .option('--failures', 'only show entries whose outcome is not "synced"')
    .option('--json', 'print NDJSON (one log entry per line)')
    .action(async (opts: { tail: number; failures?: boolean; json?: boolean }) =>
      runAction(async () => {
        let entries = readSyncLog()
        if (opts.failures) entries = entries.filter((e) => e.outcome !== 'synced')
        entries = entries.slice(-Math.max(0, opts.tail))
        if (opts.json) {
          for (const e of entries) console.log(JSON.stringify(e))
          return
        }
        if (entries.length === 0) {
          console.log(
            opts.failures
              ? 'No sync failures logged.'
              : `No sync activity logged yet (${syncLogPath()}).`,
          )
          return
        }
        printTable(
          ['TIME', 'OUTCOME', 'REPO', 'REASON', 'DETAIL'],
          entries.map((e) => [
            formatTs(e.ts),
            e.outcome,
            e.repo ?? '—',
            e.reason ?? '—',
            e.outcome === 'synced'
              ? `${e.event_count ?? '?'} events → ${e.session_id ?? '?'}`
              : e.error ?? '',
          ]),
        )
      }),
    )

  hooks
    .command('stats')
    .description('Show sync stats from the plain-JSON stats object the hooks maintain')
    .option('--json', 'print the raw stats object')
    .action(async (opts: { json?: boolean }) =>
      runAction(async () => {
        const stats = readHookStats()
        if (!stats) {
          if (opts.json) {
            printJson(null)
            return
          }
          console.log(`No sync stats yet (${hookStatsPath()}). Nothing has attempted to sync.`)
          return
        }
        // spooled_pending in the file is a snapshot from the last sync; the
        // spool dir is cheap to count, so show it live.
        const live: HookSyncStats = { ...stats, spooled_pending: spooledPendingCount() }
        if (opts.json) {
          printJson(live)
          return
        }
        console.log(`stats file:      ${hookStatsPath()}`)
        console.log(
          `last sync:       ${live.last_sync_at ? `${formatTs(live.last_sync_at)} (${ago(live.last_sync_at)})` : '—'}`,
        )
        console.log(`last outcome:    ${live.last_outcome ?? '—'}`)
        if (live.last_error) console.log(`last error:      ${live.last_error}`)
        console.log(`synced (24h):    ${live.synced_24h}`)
        console.log(`failed (24h):    ${live.failed_24h}`)
        console.log(`spooled pending: ${live.spooled_pending}`)
        console.log(`total synced:    ${live.total_synced}`)
        if (live.recent_session_ids.length) {
          console.log('recent sessions:')
          for (const id of live.recent_session_ids) console.log(`  ${id}`)
        }
      }),
    )

  hooks
    .command('enroll [repo]')
    .description('Opt a repository (default: the cwd\'s origin) into transcript sync')
    .action(async (repo: string | undefined) =>
      runAction(async () => {
        const resolved = resolveRepo(repo)
        enrollRepo(resolved)
        console.log(`Enrolled ${resolved}. Claude Code sessions in this repo will sync.`)
        const installed = hooksInstalled()
        if (!installed.Stop || !installed.SessionEnd) {
          console.log('Hooks are not installed — run `agent hooks install` to start syncing.')
        }
      }),
    )

  hooks
    .command('unenroll [repo]')
    .description('Opt a repository back out of transcript sync')
    .action(async (repo: string | undefined) =>
      runAction(async () => {
        const resolved = resolveRepo(repo)
        unenrollRepo(resolved)
        console.log(`Unenrolled ${resolved}.`)
      }),
    )
}

// Coarse relative time ("4m ago") for the status/stats one-liners.
export function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return iso
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
