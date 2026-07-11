// Laptop transcript sync plumbing (`agent hooks …` + `agent session sync`) —
// the client half of documents/eng/LOCAL_CLAUDE_CODE.md §7.1 in the monorepo.
//
// Claude Code fires `Stop` (once per turn) and `SessionEnd` hooks whose
// command is `agent session sync`; the hook's JSON context arrives on stdin
// with the session id and the live on-disk transcript path. The sync checks
// per-repo enrollment (cwd → git remote → enrolled set; silent no-op
// otherwise), redacts client-side (secrets never leave the laptop
// unredacted), gzips, and POSTs to /v1/sessions/sync. Network failures spool
// to disk and are flushed on the next successful sync.

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getEnrolledRepos, setEnrolledRepos } from './config'
import type { SyncAgentSessionRequest } from './types'

// ---------------------------------------------------------------------------
// Claude Code settings (~/.claude/settings.json): install/remove our hooks.
// ---------------------------------------------------------------------------

// The events we capture. Stop is v0 of the laptop phase by design — the
// pipeline can't rely on session-end-only capture (a mid-session sync is what
// makes a live session visible and handoff-able).
export const HOOK_EVENTS = ['Stop', 'SessionEnd'] as const

// How we recognize our own handler entries in settings.json, so install is
// idempotent and uninstall never touches hooks the user wrote themselves.
export const HOOK_COMMAND = 'agent session sync'

interface HookHandler {
  type: string
  command?: string
  async?: boolean
  timeout?: number
  [key: string]: unknown
}

interface HookGroup {
  matcher?: string
  hooks: HookHandler[]
  [key: string]: unknown
}

export function claudeSettingsPath(): string {
  return process.env.CLAUDE_SETTINGS_PATH ?? join(homedir(), '.claude', 'settings.json')
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function isOurs(handler: HookHandler): boolean {
  return handler.type === 'command' && (handler.command ?? '').startsWith(HOOK_COMMAND)
}

// Install the Stop + SessionEnd handlers, preserving everything else in the
// file (other events, other matcher groups, other handlers in our groups).
// Idempotent: re-running replaces our entries rather than duplicating them.
export function installHooks(): { path: string; changed: boolean } {
  const path = claudeSettingsPath()
  const settings = readSettings(path)
  const hooks = (settings.hooks ?? {}) as Record<string, HookGroup[]>
  let changed = false
  for (const event of HOOK_EVENTS) {
    const groups: HookGroup[] = hooks[event] ?? []
    for (const g of groups) g.hooks = (g.hooks ?? []).filter((h) => !isOurs(h))
    const kept = groups.filter((g) => (g.hooks ?? []).length > 0)
    kept.push({
      hooks: [
        {
          type: 'command',
          command: HOOK_COMMAND,
          // Background so a slow upload never blocks the turn; async hooks'
          // exit codes are ignored, so a failed sync can't disturb the
          // session either.
          async: true,
          timeout: 120,
        },
      ],
    })
    hooks[event] = kept
    changed = true
  }
  settings.hooks = hooks
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n')
  return { path, changed }
}

export function uninstallHooks(): { path: string; changed: boolean } {
  const path = claudeSettingsPath()
  if (!existsSync(path)) return { path, changed: false }
  const settings = readSettings(path)
  const hooks = (settings.hooks ?? {}) as Record<string, HookGroup[]>
  let changed = false
  for (const event of HOOK_EVENTS) {
    const groups = hooks[event]
    if (!groups) continue
    const next = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0)
    if (next.length !== groups.length || JSON.stringify(next) !== JSON.stringify(groups)) {
      changed = true
    }
    if (next.length === 0) delete hooks[event]
    else hooks[event] = next
  }
  settings.hooks = hooks
  if (Object.keys(hooks).length === 0) delete settings.hooks
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n')
  return { path, changed }
}

export function hooksInstalled(): Record<string, boolean> {
  const settings = readSettings(claudeSettingsPath())
  const hooks = (settings.hooks ?? {}) as Record<string, HookGroup[]>
  const out: Record<string, boolean> = {}
  for (const event of HOOK_EVENTS) {
    out[event] = (hooks[event] ?? []).some((g) => (g.hooks ?? []).some(isOurs))
  }
  return out
}

// ---------------------------------------------------------------------------
// Per-repo enrollment (consent is per-repo opt-in, never account-wide).
// Stored in the CLI config file as "owner/name" strings.
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}

// "owner/name" from a git remote URL (ssh or https, with or without .git).
export function repoFromRemoteUrl(url: string): string | undefined {
  const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/)
  return m ? `${m[1]}/${m[2]}` : undefined
}

export function repoFromCwd(cwd: string): string | undefined {
  const url = git(cwd, 'remote', 'get-url', 'origin')
  return url ? repoFromRemoteUrl(url) : undefined
}

export function branchFromCwd(cwd: string): string | undefined {
  return git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
}

export function enrolledRepos(): string[] {
  return getEnrolledRepos()
}

export function enrollRepo(repo: string): void {
  const set = new Set(getEnrolledRepos())
  set.add(repo.toLowerCase())
  setEnrolledRepos([...set].sort())
}

export function unenrollRepo(repo: string): void {
  setEnrolledRepos(getEnrolledRepos().filter((r) => r !== repo.toLowerCase()))
}

// ---------------------------------------------------------------------------
// Client-side redaction: secrets never leave the laptop unredacted. Pattern
// list is deliberately high-precision (recognizable token shapes), not a
// generic entropy scan — false positives corrupt tool results the transcript
// exists to preserve.
// ---------------------------------------------------------------------------

const REDACTION_PATTERNS: RegExp[] = [
  // GitHub tokens (classic + fine-grained + app/oauth/refresh).
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  // AWS access key ids + the canonical secret-key assignment shape.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\baws_secret_access_key\s*[=:]\s*[A-Za-z0-9/+=]{30,}/gi,
  // Anthropic / OpenAI.
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{30,}\b/g,
  // Slack tokens and webhook URLs.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
  // Stripe, npm, PyPI.
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\bpypi-[A-Za-z0-9_-]{30,}\b/g,
  // JWTs (three base64url segments, header starts with eyJ).
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // Private key blocks (single-line JSON-escaped or raw).
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

export function redactLine(line: string): string {
  let out = line
  for (const pattern of REDACTION_PATTERNS) out = out.replace(pattern, '[REDACTED]')
  return out
}

// ---------------------------------------------------------------------------
// Spool-and-retry: a sync that can't reach the API is written here (latest
// snapshot per CC session wins — snapshots only grow) and flushed by the next
// invocation. Bounded by one file per session; SessionEnd's final sync
// re-delivers everything a lost Stop sync carried.
// ---------------------------------------------------------------------------

function spoolDir(): string {
  return join(
    process.env.ELLIPSIS_CONFIG_DIR ?? join(homedir(), '.config', 'ellipsis'),
    'spool',
  )
}

export function spoolSync(req: SyncAgentSessionRequest): string {
  const dir = spoolDir()
  mkdirSync(dir, { recursive: true })
  // One file per CC session: a newer snapshot supersedes the spooled one.
  const file = join(dir, `${req.cc_session_id.replace(/[^A-Za-z0-9-]/g, '_')}.json`)
  writeFileSync(file, JSON.stringify(req), { mode: 0o600 })
  return file
}

export function listSpooledSyncs(): { file: string; req: SyncAgentSessionRequest }[] {
  const dir = spoolDir()
  if (!existsSync(dir)) return []
  const out: { file: string; req: SyncAgentSessionRequest }[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const file = join(dir, name)
    try {
      out.push({ file, req: JSON.parse(readFileSync(file, 'utf8')) })
    } catch {
      // A torn write from a crashed hook; drop it — the next sync of that
      // session carries a longer snapshot anyway.
      unlinkSync(file)
    }
  }
  return out
}

export function dropSpooledSync(file: string): void {
  try {
    unlinkSync(file)
  } catch {
    // Already gone (a concurrent hook flushed it) — fine.
  }
}

// Cheap count of spooled (retriable, not-yet-delivered) syncs, without
// parsing them — used by the hook stats object.
export function spooledPendingCount(): number {
  const dir = spoolDir()
  if (!existsSync(dir)) return 0
  return readdirSync(dir).filter((n) => n.endsWith('.json')).length
}

// ---------------------------------------------------------------------------
// Hook observability. In hook mode `agent session sync` is a quiet no-op on
// every failure path by design (async hooks' output is discarded and a broken
// sync must never disturb a Claude Code session), so nothing is visible in the
// session itself. Instead, every sync attempt appends one JSONL line to
// hooks/sync.log.jsonl (read by `agent hooks logs`) and atomically rewrites
// hooks/stats.json — a plain JSON object anything can read without invoking
// the CLI (read by `agent hooks stats`). All of it is best-effort: a logging
// failure stays silent so hook mode keeps its exit-0 guarantee.
// ---------------------------------------------------------------------------

export type SyncOutcome =
  | 'synced' // delivered to POST /v1/sessions/sync
  | 'skipped_unenrolled' // consent gate: repo not enrolled (or no git remote)
  | 'not_logged_in' // no token anywhere
  | 'no_transcript' // transcript path missing/empty on disk
  | 'spooled' // retriable failure (network / 5xx); queued for the next sync
  | 'rejected' // permanent failure (4xx / bad invocation); never retried

export interface SyncLogEntry {
  ts: string // ISO-8601, when the attempt finished
  outcome: SyncOutcome
  cc_session_id?: string
  repo?: string
  reason?: string // stop | session_end
  session_id?: string // v1 API session id (synced only)
  event_count?: number // events the server acknowledged (synced only)
  error?: string // failure detail (non-synced outcomes)
}

// The stats object rewritten on every sync. 24h windows are derived from the
// activity log; total_synced is carried forward so the log cap can't shrink it.
export interface HookSyncStats {
  last_sync_at?: string // ts of the most recent attempt (any outcome)
  last_outcome?: SyncOutcome
  last_error?: string // error of the most recent failed attempt
  synced_24h: number
  failed_24h: number // not_logged_in / no_transcript / spooled / rejected
  spooled_pending: number
  total_synced: number
  recent_session_ids: string[] // distinct v1 session ids, most recent first
}

// The log is an audit trail for "did that background sync fail, and why",
// not unbounded history — keep the newest N lines.
const SYNC_LOG_MAX_LINES = 1000
const RECENT_SESSION_IDS_MAX = 10

const FAILURE_OUTCOMES: ReadonlySet<SyncOutcome> = new Set<SyncOutcome>([
  'not_logged_in',
  'no_transcript',
  'spooled',
  'rejected',
])

function hooksDir(): string {
  return join(
    process.env.ELLIPSIS_CONFIG_DIR ?? join(homedir(), '.config', 'ellipsis'),
    'hooks',
  )
}

export function syncLogPath(): string {
  return join(hooksDir(), 'sync.log.jsonl')
}

export function hookStatsPath(): string {
  return join(hooksDir(), 'stats.json')
}

// stats.json readers may race a hook's rewrite, so writes go through a
// same-directory temp file + rename (atomic on POSIX).
function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, data, { mode: 0o600 })
  renameSync(tmp, path)
}

export function readSyncLog(): SyncLogEntry[] {
  const path = syncLogPath()
  if (!existsSync(path)) return []
  const out: SyncLogEntry[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as SyncLogEntry)
    } catch {
      // A torn line from a crashed hook — skip it, keep the rest.
    }
  }
  return out
}

export function readHookStats(): HookSyncStats | undefined {
  try {
    return JSON.parse(readFileSync(hookStatsPath(), 'utf8')) as HookSyncStats
  } catch {
    return undefined
  }
}

export function computeHookStats(
  entries: SyncLogEntry[],
  totalSynced: number,
  now: Date = new Date(),
): HookSyncStats {
  const dayAgo = now.getTime() - 24 * 60 * 60 * 1000
  const recent = entries.filter((e) => Date.parse(e.ts) >= dayAgo)
  const last = entries[entries.length - 1]
  const lastFailed = [...entries].reverse().find((e) => FAILURE_OUTCOMES.has(e.outcome))
  const recentIds: string[] = []
  for (const e of [...entries].reverse()) {
    if (e.outcome !== 'synced' || !e.session_id) continue
    if (recentIds.includes(e.session_id)) continue
    recentIds.push(e.session_id)
    if (recentIds.length >= RECENT_SESSION_IDS_MAX) break
  }
  return {
    last_sync_at: last?.ts,
    last_outcome: last?.outcome,
    last_error: lastFailed?.error,
    synced_24h: recent.filter((e) => e.outcome === 'synced').length,
    failed_24h: recent.filter((e) => FAILURE_OUTCOMES.has(e.outcome)).length,
    spooled_pending: spooledPendingCount(),
    total_synced: totalSynced,
    recent_session_ids: recentIds,
  }
}

// Append one attempt to the activity log (capped) and rewrite stats.json.
// Never throws: observability must not break the hook-mode exit-0 guarantee.
export function recordSyncOutcome(entry: Omit<SyncLogEntry, 'ts'>): void {
  try {
    mkdirSync(hooksDir(), { recursive: true })
    const full: SyncLogEntry = { ts: new Date().toISOString(), ...entry }
    const entries = [...readSyncLog(), full].slice(-SYNC_LOG_MAX_LINES)
    writeFileAtomic(syncLogPath(), entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
    // total_synced carries forward from the previous stats object (the log is
    // capped, so recounting it would shrink the total); first write falls back
    // to counting whatever history the log holds.
    const prevTotal =
      readHookStats()?.total_synced ??
      entries.filter((e) => e.outcome === 'synced' && e !== full).length
    const total = prevTotal + (full.outcome === 'synced' ? 1 : 0)
    writeFileAtomic(hookStatsPath(), JSON.stringify(computeHookStats(entries, total), null, 2) + '\n')
  } catch {
    // Best-effort by design.
  }
}

// ---------------------------------------------------------------------------
// Handoff (design §7.2): snapshot the dirty working tree WITHOUT disturbing it
// and push it somewhere the cloud sandbox can fetch.
// ---------------------------------------------------------------------------

function gitOrThrow(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

// The WIP commit: `git stash create` builds a commit of the dirty tree without
// touching the index or working copy; a clean tree hands off HEAD itself.
export function createWipCommit(cwd: string): { sha: string; dirty: boolean } {
  const stashSha = gitOrThrow(cwd, 'stash', 'create', 'ellipsis handoff')
  if (stashSha) return { sha: stashSha, dirty: true }
  return { sha: gitOrThrow(cwd, 'rev-parse', 'HEAD'), dirty: false }
}

// Push the WIP commit to a hidden ref (never a branch — it must not appear in
// branch UIs). Requires push permission on the repo; the caller surfaces the
// git error verbatim when it fails.
export function pushHandoffRef(cwd: string, sha: string): string {
  const ref = `refs/ellipsis/handoff/${sha.slice(0, 12)}`
  gitOrThrow(cwd, 'push', 'origin', `${sha}:${ref}`)
  return ref
}
