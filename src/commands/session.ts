import type { Command } from 'commander'
import { readFileSync, writeFileSync } from 'node:fs'
import { extname } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { parse as parseYaml } from 'yaml'
import { api } from '../lib/api'
import { requireToken, resolveApiBase, resolveAppBase } from '../lib/config'
import {
  formatTs,
  printJson,
  printTable,
  relativeAge,
  runAction,
  usdFromMillicents,
} from '../lib/output'
import {
  collect,
  collectKeyValue,
  collectSource,
  parseWhen,
  toInt,
  toNumber,
  toHarness,
} from '../lib/args'
import { alsoKnownAs, apiRoutes } from '../lib/help'
import { sessionUrl } from '../lib/urls'
import { joinPatches, omittedNote } from '../lib/sessionDiff'
import {
  sessionStatusWord,
  streamSession,
  StreamUnavailableError,
  type StreamFrame,
  type StreamOutcome,
} from '@ellipsis-dev/sdk/stream'
import { recordToItems } from '@ellipsis-dev/sdk/store'
import { makeOpenSocket, resolveWsBase } from '../lib/stream'
import { isTurnFinal, type Ellipsis } from '@ellipsis-dev/sdk'
import type {
  AgentSession,
  AgentSessionSource,
  SessionLogSegment,
  SessionRecord,
  StartAgentSessionRequest,
} from '../lib/types'
import { repoFromCwd } from '../lib/git'
import { openBrowser } from '../lib/auth'
import { readImageAttachment } from '../lib/images'
import { formatStepLine, recordText } from '../lib/steps'
import {
  parseRepo,
  withSessionPrompt,
  assertCurrentHarnessKeys,
  sessionConfigName,
  startRequestFromConfig,
  withContextRepository,
} from '../lib/sessions'

// Re-exported for existing importers (help.ts starts the helper template
// through the same mapping).
export { startRequestFromConfig, withContextRepository }

// Poll cadence for the `--watch` REST fallback (used only when live WebSocket
// streaming is unavailable). Not user-configurable — the fallback is rare.
const FALLBACK_POLL_INTERVAL_SECONDS = 2

export function registerSession(program: Command): void {
  const session = alsoKnownAs(
    program.command('session').description('Start, inspect, and follow agent sessions'),
    'sessions',
  )

  apiRoutes(
    session.command('start').description('Start a new agent session in the cloud'),
    'POST /v1/sessions',
    'WS /v1/sessions/{id}/stream with --watch',
  )
    .argument(
      '[prompt...]',
      'what the agent should do this session (positional shorthand for --prompt)',
    )
    .option(
      '-f, --config-file <path>',
      'start from a config file (.yaml/.yml or .json: an automation file, whose session: block is used, or a bare session config); to run a saved automation use `ellipsis automation run`',
    )
    .option(
      '-t, --template <slug>',
      'start from a maintained session template (e.g. ellipsis-helper)',
    )
    .option(
      '-e, --environment <environment-id>',
      'run in a saved environment, by id or name (default: the built-in basic sandbox)',
    )
    .option(
      '--override <yaml>',
      'partial patch (YAML/JSON) of session config keys merged onto the inline config, e.g. "claude_code:\\n  effort: high"',
    )
    .option(
      '--override-file <path>',
      'read the partial override from a file (.yaml/.yml or .json) instead of inline',
    )
    .option(
      '--model <model-id>',
      'override the selected harness model for this session (see `ellipsis model list`)',
    )
    .option('--harness <type>', 'select claude_code or codex (default: claude_code)', toHarness)
    .option('--system <text>', 'retired; put instructions in the prompt or AGENTS.md')
    .option(
      '-r, --repo <owner/name>',
      'also check out a repository, in whichever environment the session runs (repeatable; a bare name means your account)',
      collect,
      [] as string[],
    )
    .option('--cpu <n>', 'sandbox vCPUs (e.g. 2 or 0.5)', toNumber)
    .option('--memory <size>', 'sandbox memory (e.g. 8GB)')
    .option('--timeout <duration>', 'sandbox timeout (e.g. 30m or 1h)')
    .option(
      '--rebuild',
      'skip the sandbox image cache: fresh full build (image layers, clones, image.setup), whose snapshot refreshes the cache',
    )
    .option('--budget <usd>', 'spend limit in USD for this session', toNumber)
    .option(
      '-p, --prompt <text>',
      "the session prompt, appended to the agent's initial user query (or pass it positionally)",
    )
    .option(
      '--image <path>',
      'attach an image (PNG, JPEG, GIF, or WebP, up to 5 MiB) to the prompt; the agent sees it on its first turn (repeatable)',
      collect,
      [] as string[],
    )
    .option(
      '-m, --metadata <key=value>',
      'attach metadata (repeatable)',
      collectKeyValue,
      {} as Record<string, string>,
    )
    .option('-d, --detach', 'start and return immediately, the default')
    .option(
      '-w, --watch',
      'block until the opening turn ends (completed, failed, stopped, or cancelled), streaming live output',
    )
    .option(
      '--quiet',
      'with --watch, wait without streaming: print only how the turn ended and exit with a matching code',
    )
    .option('--json', 'output raw JSON')
    .action(
      async (
        promptWords: string[],
        opts: {
          configFile?: string
          template?: string
          environment?: string
          override?: string
          overrideFile?: string
          model?: string
          harness?: 'claude_code' | 'codex'
          system?: string
          repo: string[]
          cpu?: number
          memory?: string
          timeout?: string
          rebuild?: boolean
          budget?: number
          prompt?: string
          image: string[]
          metadata: Record<string, string>
          detach?: boolean
          watch?: boolean
          quiet?: boolean
          json?: boolean
        },
      ) => {
        await runAction(async () => {
          // An inline config source is optional: with none, the session runs
          // on the bare ad-hoc config (model and budget from the organization's
          // settings) and the prompt is the sole instruction. At most one source may be given.
          const sources = [opts.configFile, opts.template].filter(Boolean)
          if (sources.length > 1) {
            throw new Error('provide only one of --config-file / --template')
          }
          // An unquoted prompt arrives as one word per argv entry, so join it
          // back into a sentence: `ellipsis fix the tests` means one instruction.
          const promptArg = promptWords.length > 0 ? promptWords.join(' ') : undefined
          // The prompt is either positional or --prompt, not both.
          if (promptArg !== undefined && opts.prompt !== undefined) {
            throw new Error('provide the prompt positionally or with --prompt, not both')
          }
          const promptText = promptArg ?? opts.prompt
          // At most one attach mode. --detach is the default made explicit;
          // --watch blocks (live, or quiet with --quiet).
          const modes = [opts.detach && '--detach', opts.watch && '--watch'].filter(Boolean)
          if (modes.length > 1) {
            throw new Error(`provide at most one of ${modes.join(' / ')}`)
          }
          if (opts.quiet && !opts.watch) {
            throw new Error('--quiet only applies with --watch')
          }
          // The flat raw-session body: a SessionConfig plus run settings;
          // there is no base config to merge onto (a saved automation is
          // invoked with `ellipsis automation run` instead).
          let req: StartAgentSessionRequest = { claude_code: {} }
          if (opts.configFile) {
            req = startRequestFromConfig(readConfigFile(opts.configFile))
          }
          // Templates left the start request (#6394): resolve the slug to its
          // YAML via GET /v1/templates/{slug} and start inline.
          if (opts.template) {
            const template = await api().templates.get(opts.template)
            req = startRequestFromConfig(parseYaml(template.yaml))
          }
          // Sugar flags (--model, --repo, --cpu, ...) and the raw --override
          // are one structured patch, deep-merged onto the inline config so an
          // explicit flag wins over the same field from -f/-t.
          const override = buildStartOverride(opts, req.codex ? 'codex' : 'claude_code')
          if (override) req = deepMerge(req, override) as StartAgentSessionRequest
          // A NAMED environment re-picks it wholesale, so there is nothing for
          // the environment fields of an override to merge into.
          if (opts.environment) {
            if (isPlainObject(req.environment) && Object.keys(req.environment).length > 0) {
              throw new Error(
                '--environment names a saved environment wholesale; it cannot be combined with environment overrides (--cpu/--memory/--timeout or an override\'s environment block)',
              )
            }
            req.environment = opts.environment
          }
          // The repo we're standing in (origin remote), added to whichever
          // environment the session resolves to — the request's top-level
          // `repositories` key joins the checkout set without replacing it.
          // Outside a git repo (or with no usable remote) nothing is added.
          const contextRepo = repoFromCwd(process.cwd())
          if (contextRepo) req = withContextRepository(req, contextRepo)
          // Appended to the initial user query at build time; gives this
          // session instructions on top of the config's shared system prompt.
          if (promptText) req = withSessionPrompt(req, promptText)
          // Pictures ride the first message inline, the way a paste into a
          // local `claude` does: the prompt gains an `[Image #N]` placeholder
          // per file and the model sees each as a content block on turn 0.
          if (opts.image.length > 0) {
            req.images = opts.image.map((path) => readImageAttachment(path).attachment)
          }
          // Run settings ride top-level: --rebuild skips the image cache for
          // the initial provision (the fresh build's snapshot refreshes the
          // cache).
          if (Object.keys(opts.metadata).length > 0) req.metadata = opts.metadata
          if (opts.rebuild) req.force_rebuild = true
          // A promptless start creates no turn: the session waits for its
          // first message, nothing extra to send.

          const client = api()
          const { session } = await client.sessions.start(req)

          // Transparency for the environment resolution: say which environment
          // the server resolved when the session didn't name one (the agent
          // config's own reference).
          let configNote: string | undefined
          const environmentSource = session.environment?.source
          if (session.environment?.id && environmentSource !== 'request') {
            const label =
              environmentSource === 'agent'
                ? 'from the automation'
                : environmentSource
            const note = `using environment ${session.environment.id} (${label})`
            configNote = configNote ? `${configNote}; ${note}` : note
          }

          if (!opts.json && configNote) console.log(configNote)

          if (opts.watch) {
            if (!opts.json) {
              console.log(`✓ started session ${session.id}`)
              await printSessionUrl(client, session.id)
            }
            // The opening turn is the one this start created; a promptless
            // start has none to wait on.
            await watchTurn(client, session, opts)
            return
          }

          if (opts.json) {
            printJson(session)
            return
          }
          const opening = session.turn ? `turn ${session.turn.status}` : 'no turn yet'
          console.log(`✓ started session ${session.id} (${opening})`)
          await printSessionUrl(client, session.id)
          console.log(`  follow with: ellipsis session get ${session.id} --watch`)
        })
      },
    )

  apiRoutes(
    alsoKnownAs(
      session.command('list').description('List recent sessions, newest first'),
      'ls',
    ).addHelpText(
      'after',
      '\nSources: react, web, api, cli, mention, cron. ' +
        '--since/--until accept ISO 8601 or "today", "yesterday", "N days ago".',
    ),
    'GET /v1/sessions',
    'GET /v1/integrations/github/members to resolve --author',
  )
    .option('--automation <automation-id>', 'only sessions this automation started, by id or name')
    .option(
      '-s, --source <source>',
      'only sessions from this source (repeatable)',
      collectSource,
      [] as string[],
    )
    .option(
      '-a, --author <login>',
      'only sessions attributed to this GitHub login (see `ellipsis github members`)',
    )
    .option('--days <n>', 'look back N days', toInt)
    .option('--since <when>', 'only sessions at or after this time', (v: string) => parseWhen(v))
    .option('--until <when>', 'only sessions at or before this time', (v: string) => parseWhen(v))
    .option('-l, --limit <n>', 'max sessions to return', toInt, 50)
    .option('--json', 'output raw JSON')
    .action(
      async (opts: {
        automation?: string
        source: string[]
        author?: string
        days?: number
        since?: string
        until?: string
        limit: number
        json?: boolean
      }) => {
        await runAction(async () => {
          const client = api()
          const sessions = (
            await client.sessions.list({
              agent: opts.automation,
              source: opts.source.length ? (opts.source as AgentSessionSource[]) : undefined,
              author_id: opts.author ? await resolveAuthorId(client, opts.author) : undefined,
              days: opts.days,
              start: opts.since,
              end: opts.until,
              limit: opts.limit,
            })
          ).items
          if (opts.json) {
            printJson(sessions)
            return
          }
          if (sessions.length === 0) {
            console.log('No sessions found.')
            return
          }
          printTable(
            ['ID', 'CONVERSATION', 'TURN', 'SOURCE', 'CREATED', 'COST'],
            sessions.map((s) => [
              s.id,
              s.conversation.state,
              s.turn?.status ?? '-',
              s.source ?? '-',
              formatTs(s.created_at),
              usdFromMillicents(s.cost?.total ?? 0),
            ]),
          )
        })
      },
    )

  apiRoutes(
    alsoKnownAs(
      session
        .command('record <session-id>')
        .description("Print a session's stored transcript, one line per record"),
      'records',
    ),
    'GET /v1/sessions/{id}/records',
  )
    .option('--json', 'output raw JSON (full record payloads)')
    .action(async (sessionId: string, opts: { json?: boolean }) => {
      await runAction(async () => {
        const records = (await api().sessions.records(sessionId)).items as SessionRecord[]
        if (opts.json) {
          printJson(records)
          return
        }
        if (records.length === 0) {
          console.log('No records stored for this session.')
          return
        }
        // Feed order (transcript + lifecycle merged), one line per record;
        // --json has the full payloads.
        const ordered = [...records].sort((a, b) => a.feed_seq - b.feed_seq)
        for (const record of ordered) console.log(formatStepLine(record))
      })
    })

  apiRoutes(
    alsoKnownAs(
      session
        .command('export <session-id>')
        .description("Download a session's complete archived history to stdout or a file"),
      'log',
      'logs',
    ),
    'GET /v1/sessions/{id}/download',
  )
    .option('-o, --output <path>', 'write to a file instead of stdout')
    .option('--gzip', 'keep the concatenated .jsonl.gz bytes as-is (skip gunzip)')
    .option('--json', 'output raw JSON (the manifest with segment URLs); downloads nothing')
    .action(
      async (
        sessionId: string,
        opts: {
          output?: string
          gzip?: boolean
          json?: boolean
        },
      ) => {
        await runAction(async () => {
          const manifest = await api().sessions.download(sessionId)
          if (opts.json) {
            printJson(manifest)
            return
          }
          if (manifest.segments.length === 0) {
            console.error('No log segments archived for this session yet.')
            return
          }
          // Fetch every segment in feed order and concatenate the raw gzip
          // members: their concatenation is itself a valid multi-member
          // .jsonl.gz, so one gunzip yields the whole log.
          const parts: Buffer[] = []
          for (const segment of manifest.segments) {
            parts.push(await fetchLogSegment(segment))
          }
          const gz = Buffer.concat(parts)
          const data = opts.gzip ? gz : gunzipSync(gz)
          if (opts.output) {
            writeFileSync(opts.output, data)
            console.log(opts.output)
          } else {
            process.stdout.write(data)
          }
          if (manifest.has_more) {
            console.error(
              `note: the archive trails the live feed (archived through ` +
                `${manifest.archived_through_feed_seq} of ${manifest.latest_feed_seq}). ` +
                'Re-run shortly for the complete log.',
            )
          }
        })
      },
    )

  apiRoutes(
    session
      .command('diff <session-id>')
      .description("Print the session's uncommitted changes as a unified patch, one section per file"),
    'GET /v1/sessions/{id}/diff',
  )
    .option('-o, --output <path>', 'write the patch to a file instead of stdout')
    .option('--json', 'output raw JSON (files with their patches, and the omitted paths)')
    .action(async (sessionId: string, opts: { output?: string; json?: boolean }) => {
      await runAction(async () => {
        const diff = await api().sessions.diff(sessionId)
        if (opts.json) {
          printJson(diff)
          return
        }
        if (diff.files.length === 0 && diff.omitted_paths.length === 0) {
          console.error('No uncommitted changes were captured for this session.')
          return
        }
        const patch = joinPatches(diff.files)
        if (opts.output) {
          writeFileSync(opts.output, patch)
          console.log(opts.output)
        } else {
          process.stdout.write(patch)
        }
        const note = omittedNote(diff.omitted_paths)
        if (note) console.error(note)
      })
    })

  apiRoutes(
    session
      .command('get <session-id>')
      .description("Show one session's conversation state, turn, cost, and dashboard link"),
    'GET /v1/sessions/{id}',
    'WS /v1/sessions/{id}/stream with --watch',
    'GET /v1/sessions/{id}/turns/{turn_id} with --watch --quiet',
  )
    .option(
      '-w, --watch',
      'block until the turn in progress ends (completed, failed, stopped, or cancelled), streaming live output',
    )
    .option('--quiet', 'with --watch, wait without streaming: print only how the turn ended')
    .option('--json', 'output raw JSON')
    .action(
      async (sessionId: string, opts: { watch?: boolean; quiet?: boolean; json?: boolean }) => {
        await runAction(async () => {
          const client = api()
          if (opts.quiet && !opts.watch) {
            throw new Error('--quiet only applies with --watch')
          }
          if (opts.watch) {
            if (!opts.json) await printSessionUrl(client, sessionId)
            // The turn to wait on is the one in progress (running, else
            // pending); with none, the latest turn's status is the answer.
            const { session: s } = await client.sessions.get(sessionId)
            await watchTurn(client, s, opts)
            return
          }
        if (opts.json) {
          printJson((await client.sessions.get(sessionId)).session)
          return
        }
        // Fetch the session and the login (for the link) together — no added latency.
        const [{ session: s }, me] = await Promise.all([
          client.sessions.get(sessionId),
          client.identity(),
        ])
        printSessionSummary(s)
        console.log(row('url', sessionUrl(resolveAppBase(), me.customer_login, sessionId)))
      })
    })

  apiRoutes(
    session.command('stop <session-id>').description("Stop a session's turn in progress"),
    'POST /v1/sessions/{id}/stop',
  )
    .option('--json', 'output raw JSON')
    .action(async (sessionId: string, opts: { json?: boolean }) => {
      await runAction(async () => {
        const { session: s } = await api().sessions.stop(sessionId)
        if (opts.json) {
          printJson(s)
          return
        }
        console.log(`✓ stopped session ${sessionId} (turn ${turnStatusText(s.turn)})`)
      })
    })
}

// How a turn ended: its status plus the reason and detail a failed, stopped,
// or cancelled turn carries. The wire's own words, so the human line and
// `--json` never disagree.
export interface TurnEnd {
  status: string
  reason: string | null
  detail: string | null
}

// One line for where a turn is: `running`, `completed`, or
// `failed (budget_hit): The session reached its budget.` `none` when the
// session has no turn yet.
export function turnStatusText(turn: TurnEnd | null | undefined): string {
  if (!turn) return 'none'
  const reason = turn.reason ? ` (${turn.reason})` : ''
  const detail = turn.detail ? `: ${turn.detail}` : ''
  return `${turn.status}${reason}${detail}`
}

// Exit 0 only when the turn completed; 1 when it failed, was stopped, or was
// cancelled (see docs/SESSION_STREAMING.md).
export function exitCodeForStatus(status: string): number {
  return status === 'completed' ? 0 : 1
}

// `--watch` entry point: follow one turn until it reaches a final status.
// `session.turn` is the turn to wait on: the opening turn a start created, or
// the one in progress (running, else pending) that a GET found. With no turn
// in progress there is nothing to wait for: the latest turn's status is the
// answer, and the exit code follows it.
export async function watchTurn(
  client: Ellipsis,
  session: AgentSession,
  opts: { quiet?: boolean; json?: boolean },
): Promise<void> {
  const turn = session.turn
  if (turn == null) {
    if (opts.json) printJson(session)
    else console.log(`session ${session.id} has no turn yet: nothing to wait for`)
    return
  }
  if (isTurnFinal(turn.status)) {
    if (opts.json) printJson(session)
    endWatch(session.id, turn, opts.json)
    return
  }
  if (opts.quiet) {
    await pollTurn(client, session.id, turn.id, FALLBACK_POLL_INTERVAL_SECONDS, opts.json)
  } else {
    await streamFrames(client, session.id, turn.id, FALLBACK_POLL_INTERVAL_SECONDS, opts.json)
  }
}

// Follow a session's whole conversation live until it closes. A session that
// runs once closes after its turn ended and the platform's teardown work is
// done: a review's findings are collected then, so `ellipsis review` waits
// for the close rather than the turn's end.
export async function followConversation(
  client: Ellipsis,
  sessionId: string,
  json?: boolean,
): Promise<void> {
  await streamFrames(client, sessionId, null, FALLBACK_POLL_INTERVAL_SECONDS, json)
}

// The watch's last word: one line naming how the turn ended, and the exit
// code that goes with it. `--json` callers have already printed the turn.
function endWatch(sessionId: string, turn: TurnEnd, json?: boolean): void {
  if (!json) {
    const mark = exitCodeForStatus(turn.status) === 0 ? '✓' : '✗'
    console.log(`${mark} session ${sessionId} turn ${turnStatusText(turn)}`)
  }
  if (exitCodeForStatus(turn.status) !== 0) process.exitCode = 1
}

// Stream a session's output live over WebSocket, falling back to polling over
// REST if streaming is unavailable (e.g. a backend without the endpoint).
// With `turnId` the watch ends when that turn does; without one it follows
// the whole conversation until it closes. Either way the last line names how
// the turn ended and the exit code follows it.
async function streamFrames(
  client: Ellipsis,
  sessionId: string,
  turnId: string | null,
  intervalSeconds: number,
  json?: boolean,
): Promise<void> {
  const token = requireToken()
  const openSocket = makeOpenSocket(token, resolveWsBase(resolveApiBase()))

  // The stream stays open for the whole conversation; a turn watch wants one
  // turn of it. That turn's end arrives twice, as its turn_ended record
  // (cursored, never lost) and on the session frame carrying its final
  // status, and either one ends the watch, which closes the socket itself.
  const abort = new AbortController()
  // What the frames have said: the latest turn seen (the awaited one, or
  // whichever turn the session is on) and, for a turn watch, its end once
  // seen. Session frames are LWW snapshots resent on any change (cost ticks
  // included), so they collapse to the turn's status transitions to keep the
  // human log quiet and the NDJSON stream clean of near-duplicates.
  // Heartbeats are liveness only; deltas are ephemeral partials the committed
  // record supersedes: a line-oriented log skips both.
  const seen: { turn: (TurnEnd & { id: string }) | null; end: TurnEnd | null } = {
    turn: null,
    end: null,
  }
  const onFrame = (frame: StreamFrame) => {
    if (frame.type === 'heartbeat' || frame.type === 'delta') return
    if (frame.type === 'snapshot' || frame.type === 'session') {
      const turn = frame.session.turn
      if (turn == null || (turnId != null && turn.id !== turnId)) return
      if (turn.id === seen.turn?.id && turn.status === seen.turn.status) return
      seen.turn = { id: turn.id, status: turn.status, reason: turn.reason, detail: turn.detail }
      if (turnId != null && isTurnFinal(turn.status)) seen.end = seen.turn
    } else if (frame.type === 'records_append') {
      for (const record of frame.records) {
        if (
          turnId != null &&
          record.kind === 'platform' &&
          record.record_type === 'turn_ended' &&
          record.payload.turn_id === turnId
        ) {
          const { status, reason, detail } = record.payload
          seen.end = { status, reason: reason ?? null, detail: detail ?? null }
        }
      }
    }
    if (json) console.log(JSON.stringify(frame))
    else renderFrameHuman(frame, seen.turn?.status)
    if (seen.end) abort.abort()
  }

  let outcome: StreamOutcome
  try {
    outcome = await streamSession({ sessionId, openSocket, onFrame, signal: abort.signal })
  } catch (err) {
    if (err instanceof StreamUnavailableError) {
      if (!json) {
        console.error(`live stream unavailable (${err.message}); falling back to polling`)
      }
      if (turnId != null) await pollTurn(client, sessionId, turnId, intervalSeconds, json)
      else await pollConversation(client, sessionId, intervalSeconds, json)
      return
    }
    throw err // StreamAuthError and anything unexpected: surfaced by runAction.
  }

  if (outcome.type === 'error') {
    process.exitCode = 1
    return
  }
  // `aborted` is a turn watch closing the socket once its turn ended; `done`
  // is the conversation closing, after the last session frame carried its
  // turn's end. A turn watch that saw neither fetches its turn.
  const end =
    seen.end ??
    (turnId != null ? (await client.sessions.turns.get(sessionId, turnId)).turn : seen.turn)
  if (end == null) {
    if (!json) console.log(`\nconversation ${sessionId} closed`)
    return
  }
  endWatch(sessionId, end, json)
}

function renderFrameHuman(frame: StreamFrame, statusWord?: string): void {
  switch (frame.type) {
    case 'snapshot':
    case 'session':
      console.log(`${nowClock()}  ${statusWord ?? ''}`)
      break
    case 'records_append': {
      // Raw records, rendered client-side (the semantic-relay philosophy):
      // one line per transcript item. Platform records render too
      // (recordToItems shapes them through lifecycleText): environment
      // preparation with the customer's hook output, how a turn ended, the
      // conversation closing. Types without display copy (message_*
      // bookkeeping) shape to nothing.
      for (const record of frame.records) {
        for (const item of recordToItems(record, `w${record.feed_seq}`)) {
          const line = item.detail ? `${item.text}  ${item.detail}` : item.text
          if (line.trim()) console.log(line)
        }
      }
      break
    }
    case 'error':
      console.error(`error: ${frame.message ?? 'stream error'}`)
      break
    case 'done':
      break // handled by the caller
    default:
      break // unknown frame types are ignored (see docs/SESSION_STREAMING.md)
  }
}

// Poll one turn until it reaches a final status, printing each status
// transition. The status-level path: `--watch --quiet`, and the fallback when
// live streaming isn't available.
export async function pollTurn(
  client: Ellipsis,
  sessionId: string,
  turnId: string,
  intervalSeconds: number,
  json?: boolean,
): Promise<void> {
  const intervalMs = Math.max(1, intervalSeconds) * 1000
  let last: string | undefined
  for (;;) {
    const { turn } = await client.sessions.turns.get(sessionId, turnId)
    if (turn.status !== last) {
      if (!json) console.log(`${nowClock()}  ${turn.status}`)
      last = turn.status
    }
    if (isTurnFinal(turn.status)) {
      if (json) printJson(turn)
      else console.log('')
      endWatch(sessionId, turn, json)
      return
    }
    await sleep(intervalMs)
  }
}

// Poll a session until its conversation closes, printing the turn's status
// transitions. The fallback for following a conversation when live streaming
// isn't available.
async function pollConversation(
  client: Ellipsis,
  sessionId: string,
  intervalSeconds: number,
  json?: boolean,
): Promise<void> {
  const intervalMs = Math.max(1, intervalSeconds) * 1000
  let last: string | undefined
  for (;;) {
    const { session } = await client.sessions.get(sessionId)
    const word = sessionStatusWord(session)
    if (word !== last) {
      if (!json) console.log(`${nowClock()}  ${word}`)
      last = word
    }
    if (session.conversation.state === 'closed') {
      if (json) printJson(session)
      else console.log('')
      if (session.turn) endWatch(sessionId, session.turn, json)
      return
    }
    await sleep(intervalMs)
  }
}

// One `label: value` line of `session get`, labels padded to one column.
function row(label: string, value: string): string {
  return `${label}:`.padEnd(14) + value
}

function printSessionSummary(s: AgentSession): void {
  console.log(row('id', s.id))
  console.log(row('conversation', s.conversation.state))
  console.log(row('warm', s.conversation.warm ? 'yes' : 'no'))
  console.log(row('turn', turnStatusText(s.turn)))
  if (s.source) console.log(row('source', s.source))
  const config = sessionConfigName(s)
  if (config) console.log(row('config', config))
  console.log(row('created', s.created_at))
  console.log(row('updated', s.updated_at))
  console.log(row('tokens', (s.tokens?.total ?? 0).toLocaleString()))
  console.log(row('cost', usdFromMillicents(s.cost?.total ?? 0)))
  const keys = Object.keys(s.metadata ?? {})
  if (keys.length) {
    console.log('metadata:')
    for (const k of keys) console.log(`  ${k}=${s.metadata[k]}`)
  }
}

// Print a clickable dashboard link for a session. The route is scoped by
// account login, which isn't on the session object, so resolve it from /identity.
async function printSessionUrl(client: Ellipsis, sessionId: string): Promise<void> {
  const me = await client.identity()
  console.log(`  ${sessionUrl(resolveAppBase(), me.customer_login, sessionId)}`)
}

// Build the structured config patch for `session start`. The raw
// --override / --override-file supplies the base mapping (any
// field); the sugar flags (--model, --system, --repo, --cpu, --memory,
// --timeout, --budget) are assembled into a partial config and deep-merged on
// top, so an explicit flag wins over the same field in a raw override. Returns
// undefined when nothing was set. The result rides the request body itself,
// which the server deep-merges onto the base config and re-validates.
export function buildStartOverride(opts: {
  override?: string
  overrideFile?: string
  model?: string
  harness?: 'claude_code' | 'codex'
  system?: string
  repo?: string[]
  cpu?: number
  memory?: string
  timeout?: string
  budget?: number
}, defaultHarness: 'claude_code' | 'codex' = 'claude_code'): Record<string, unknown> | undefined {
  if (opts.override && opts.overrideFile) {
    throw new Error('provide only one of --override / --override-file')
  }
  let base: Record<string, unknown> = {}
  if (opts.overrideFile) {
    base = readMappingFile(opts.overrideFile, 'override')
  } else if (opts.override) {
    const parsed = parseYaml(opts.override)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('config override must be a mapping of fields')
    }
    base = parsed as Record<string, unknown>
  }

  assertCurrentHarnessKeys(base)
  const sugar: Record<string, unknown> = {}
  if (opts.system !== undefined) {
    throw new Error('--system is no longer supported; put task instructions in the prompt or a repository AGENTS.md file')
  }
  const type = opts.harness ?? (base.codex ? 'codex' : base.claude_code ? 'claude_code' : defaultHarness)
  if (opts.harness !== undefined || opts.model !== undefined) {
    sugar[type] = { ...(opts.model !== undefined ? { model: opts.model } : {}) }
  }

  const compute: Record<string, unknown> = {}
  if (opts.cpu !== undefined) compute.cpu = opts.cpu
  if (opts.memory !== undefined) compute.memory = opts.memory
  if (opts.timeout !== undefined) compute.timeout = opts.timeout
  const environment: Record<string, unknown> = {}
  if (Object.keys(compute).length) environment.compute = compute
  if (Object.keys(environment).length) sugar.environment = environment
  // --repo adds checkouts to whichever environment resolves (the request's
  // additive `repositories` key), so it composes with -e. Validated here so a
  // malformed value fails before the request is built.
  if (opts.repo && opts.repo.length) {
    opts.repo.forEach(parseRepo)
    sugar.repositories = opts.repo
  }

  if (opts.budget !== undefined) sugar.budget = opts.budget

  const merged = deepMerge(base, sugar)
  return Object.keys(merged).length ? merged : undefined
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Recursively merge `over` onto `base`: nested objects merge, everything else
// (including arrays) is replaced by `over`.
function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) {
    const b = out[k]
    if ((k === 'codex' || k === 'claude_code') && v != null) {
      const other = k === 'codex' ? 'claude_code' : 'codex'
      const previous = out[other]
      // Carry the first message across a harness switch, never native options.
      if (isPlainObject(previous) && isPlainObject(v) && v.prompt === undefined && previous.prompt !== undefined) {
        out[k] = { ...v, prompt: previous.prompt }
      } else {
        out[k] = isPlainObject(b) && isPlainObject(v) ? deepMerge(b, v) : v
      }
      delete out[other]
    } else {
      out[k] = isPlainObject(b) && isPlainObject(v) ? deepMerge(b, v) : v
    }
  }
  return out
}

// Parse an inline automation config from disk, choosing the parser by file
// extension: .yaml/.yml as YAML, .json as JSON. (YAML is a JSON superset, so
// unknown extensions fall back to YAML, which still accepts JSON input.)
export function readConfigFile(path: string): Record<string, unknown> {
  return readMappingFile(path, 'config')
}

// Read a YAML/JSON file from disk and parse it to a mapping, choosing the parser
// by extension. `label` (e.g. "config", "config override") tailors the error.
function readMappingFile(path: string, label: string): Record<string, unknown> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(`could not read ${label} file ${path}: ${(err as Error).message}`)
  }
  const ext = extname(path).toLowerCase()
  try {
    const parsed = ext === '.json' ? JSON.parse(text) : parseYaml(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} must be a mapping of fields`)
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    const kind = ext === '.json' ? 'JSON' : 'YAML'
    throw new Error(`could not parse ${kind} ${label} file ${path}: ${(err as Error).message}`)
  }
}

// Resolve a --author GitHub login to the account id the API filters by
// (author_id on GET /sessions), via the org roster.
// An unknown login fails with the known logins so the user can self-correct.
export async function resolveAuthorId(client: Ellipsis, login: string): Promise<number> {
  const { members } = await client.integrations.github.members()
  const member = members.find((m) => m.login?.toLowerCase() === login.toLowerCase())
  if (member) return member.id
  const known = members.flatMap((m) => (m.login ? [m.login] : [])).join(', ')
  throw new Error(
    `no GitHub member with login "${login}"` +
      (known ? ` (known logins: ${known})` : ''),
  )
}

// formatStepLine / recordText live in lib/steps.ts; re-exported here for
// existing importers and tests.
export { formatStepLine, recordText }

// Pull one session-log segment's raw .jsonl.gz bytes from its presigned S3 URL
// (bare fetch — the signature in the URL is the credential). Returns the gzip
// member as-is; the caller concatenates segments and gunzips once.
export async function fetchLogSegment(segment: SessionLogSegment): Promise<Buffer> {
  const res = await fetch(segment.download_url)
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        `a log segment (feed_seq ${segment.start_feed_seq}–${segment.end_feed_seq}) is ` +
          'gone from storage. Your log retention setting likely deleted it.',
      )
    }
    throw new Error(
      `download failed: ${res.status} ${res.statusText}` +
        (res.status === 403
          ? ' (the presigned URL likely expired; re-run the command for a fresh one)'
          : ''),
    )
  }
  return Buffer.from(await res.arrayBuffer())
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Local wall-clock HH:MM:SS for the --watch transition log.
function nowClock(): string {
  return new Date().toTimeString().slice(0, 8)
}
