// `agent session sync` — laptop transcript ingestion (the client half of
// documents/eng/LOCAL_CLAUDE_CODE.md §7.1 in ellipsis-dev/ellipsis).
//
// Normally invoked by the Claude Code `Stop` / `SessionEnd` hooks that
// `agent hooks install` writes (`--hook`: hook JSON on stdin, always exits 0 so
// a sync problem can never disturb the developer's session). Can also be run
// by hand against an explicit transcript file.
//
// Flow: resolve the cwd's repo from its git remote → silently no-op unless the
// repo is enrolled (per-repo consent) → read the on-disk JSONL transcript →
// redact client-side → gzip+base64 → POST /v1/sessions/sync. Network-class
// failures spool to disk and are retried before the next successful sync.

import { basename, join } from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { gzipSync } from 'node:zlib'
import type { Command } from 'commander'
import { ApiClient, ApiError } from '../lib/api'
import { isEnrolled, repoForCwd } from '../lib/enrollment'
import { redactTranscript } from '../lib/redact'
import { flushSpool, spoolSync } from '../lib/spool'
import { printJson, runAction } from '../lib/output'
import type { SyncHookEvent, SyncSessionRequest } from '../lib/types'

interface HookInput {
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
  reason?: string
}

function hookEventFromName(name?: string): SyncHookEvent {
  if (name === 'Stop') return 'stop'
  if (name === 'SessionEnd') return 'session_end'
  return 'manual'
}

// Claude Code stores transcripts under ~/.claude/projects/<cwd-slug>/, where
// the slug is the cwd with every non-alphanumeric character replaced by `-`.
// Used only for manual (non-hook) invocations without --transcript.
function latestTranscriptForCwd(cwd: string): string | undefined {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const dir = join(base, 'projects', slug)
  if (!existsSync(dir)) return undefined
  const candidates = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return candidates.length > 0 ? join(dir, candidates[0].f) : undefined
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

interface SyncOpts {
  hook?: boolean
  transcript?: string
  event?: string
  json?: boolean
}

async function doSync(opts: SyncOpts): Promise<void> {
  const quiet = Boolean(opts.hook)
  // In hook mode everything below must be non-fatal: the hook contract is
  // "never disturb the session" — problems are printed to stderr (visible in
  // CC's debug log) and we exit 0.
  const fail = (message: string): void => {
    if (quiet) {
      console.error(`agent session sync: ${message}`)
      return
    }
    throw new Error(message)
  }

  let hookInput: HookInput = {}
  if (opts.hook) {
    try {
      hookInput = JSON.parse(await readStdin()) as HookInput
    } catch {
      return fail('could not parse hook JSON from stdin')
    }
  }

  const cwd = hookInput.cwd ?? process.cwd()
  const repo = repoForCwd(cwd)
  // The consent gate: only enrolled repos ever sync; everything else is a
  // silent no-op (by design — the hook fires in every project).
  if (!repo || !isEnrolled(repo)) {
    if (!quiet) {
      console.log(
        repo
          ? `repo ${repo} is not enrolled for transcript sync — run \`agent hooks enroll\` in it first.`
          : 'not inside a git repo with a recognizable GitHub remote; nothing to sync.',
      )
    }
    return
  }

  const transcriptPath =
    opts.transcript ?? hookInput.transcript_path ?? latestTranscriptForCwd(cwd)
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return fail(
      transcriptPath
        ? `transcript not found: ${transcriptPath}`
        : 'no transcript found for this directory (pass --transcript <path>)',
    )
  }

  const ccSessionId =
    hookInput.session_id ?? basename(transcriptPath).replace(/\.jsonl$/, '')
  const text = redactTranscript(readFileSync(transcriptPath, 'utf8'))
  if (!text.trim()) {
    if (!quiet) console.log('transcript is empty; nothing to sync.')
    return
  }

  const payload: SyncSessionRequest = {
    cc_session_id: ccSessionId,
    transcript_gzip_b64: gzipSync(Buffer.from(text, 'utf8')).toString('base64'),
    repo,
    cwd,
    hook_event: (opts.event as SyncHookEvent) ?? hookEventFromName(hookInput.hook_event_name),
    reason: hookInput.reason,
  }

  const api = new ApiClient()
  try {
    const res = await api.syncSession(payload)
    // A successful sync is the opportunistic moment to drain anything spooled
    // by earlier offline syncs.
    await flushSpool(api)
    if (!quiet) {
      if (opts.json) printJson(res)
      else
        console.log(
          `synced ${res.event_count} events → session ${res.agent_session_id}` +
            (res.stored ? '' : ' (server already had this snapshot)'),
        )
    }
  } catch (err) {
    if (err instanceof ApiError && err.status < 500) {
      // A 4xx will not succeed on retry — don't spool it.
      return fail(err.message)
    }
    // Network-class failure: spool the snapshot and retry on a later sync.
    spoolSync(payload)
    return fail(`sync failed (${(err as Error).message}); spooled for retry`)
  }
}

export function registerSession(program: Command): void {
  const session = program
    .command('session')
    .description('Work with agent sessions')

  session
    .command('sync')
    .description(
      'Sync the local Claude Code session transcript to Ellipsis (enrolled repos only)',
    )
    .option('--hook', 'hook mode: read Claude Code hook JSON from stdin, never fail')
    .option('--transcript <path>', 'explicit transcript .jsonl path')
    .option('--event <event>', 'override the hook event (stop|session_end|manual)')
    .option('--json', 'output the raw JSON response')
    .action(async (opts: SyncOpts) => {
      if (opts.hook) {
        // Hook contract: always exit 0; doSync reports problems on stderr.
        await doSync(opts).catch((err) =>
          console.error(`agent session sync: ${(err as Error).message}`),
        )
        return
      }
      await runAction(() => doSync(opts))
    })
}
