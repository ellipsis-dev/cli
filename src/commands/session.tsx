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
  collectStatus,
  parseScope,
  parseWhen,
  toInt,
  toNumber,
} from '../lib/args'
import { alsoKnownAs, apiRoutes } from '../lib/help'
import { sessionUrl } from '../lib/urls'
import {
  sessionStatusWord,
  streamSession,
  StreamUnavailableError,
  type StreamFrame,
  type StreamOutcome,
} from '@ellipsis-dev/sdk/stream'
import { recordToItems } from '@ellipsis-dev/sdk/store'
import { makeOpenSocket, resolveWsBase } from '../lib/stream'
import type { Ellipsis, Session as FrameSession } from '@ellipsis-dev/sdk'
import type {
  AgentConfig,
  AgentSession,
  AgentSessionSource,
  AgentSessionStatus,
  GithubAccountSnippet,
  ReplayAgentSessionRequest,
  SessionLogSegment,
  SessionRecord,
  SessionSearchResult,
  SessionSearchScope,
  StartAgentSessionRequest,
} from '../lib/types'
import { repoFromCwd } from '../lib/git'
import { openBrowser } from '../lib/auth'
import { registerConnect, runConnect } from './connect'
import { canHostSessionsUi, defaultStartRequest, runSessionsUi } from '../ui/launch'
import { formatStepLine, oneLine, recordText } from '../lib/steps'
import { sessionConfigName } from '../lib/sessions'

// Poll cadence for the `--watch` REST fallback (used only when live WebSocket
// streaming is unavailable). Not user-configurable — the fallback is rare.
const FALLBACK_POLL_INTERVAL_SECONDS = 2

// Statuses past which a session no longer changes — `--watch` stops here.
const TERMINAL_STATUSES: ReadonlySet<AgentSessionStatus> = new Set<AgentSessionStatus>([
  'completed',
  'error',
  'cancelled',
  'stopped',
])

export function registerSession(program: Command): void {
  const session = alsoKnownAs(
    program.command('session').description('Start, inspect, and connect to agent sessions'),
    'sessions',
  )

  // `session connect` lives in connect.ts (the interactive terminal window
  // into a cloud session); registered here so it sits with its siblings.
  registerConnect(session)

  apiRoutes(
    session.command('start').description('Start a new agent session in the cloud'),
    'POST /v1/sessions',
    'WS /v1/sessions/{id}/stream with --watch or --connect',
  )
    .argument(
      '[prompt...]',
      'what the agent should do this session (positional shorthand for --prompt)',
    )
    .option(
      '-c, --config <config-id>',
      'start from a saved agent config (default: the resolved default config)',
    )
    .option(
      '-f, --config-file <path>',
      'start from an inline agent config (.yaml/.yml or .json file)',
    )
    .option(
      '-t, --template <slug>',
      'start from a maintained session template (e.g. ellipsis-helper)',
    )
    .option(
      '-e, --environment <environment-id>',
      'run in a saved environment, by id or name (only without -c/-f: an agent config decides its own environment)',
    )
    .option(
      '--override <yaml>',
      'partial patch (YAML/JSON) on the resolved session config, applied last, e.g. "budget:\\n  session: 5"',
    )
    .option(
      '--override-file <path>',
      'read the partial override from a file (.yaml/.yml or .json) instead of inline',
    )
    .option(
      '--model <model-id>',
      'override claude.model for this session (see `agent model list`)',
    )
    .option('--system <text>', 'override claude.system, the agent system prompt')
    .option(
      '-r, --repo <owner/name>',
      'check out a repository in the sandbox (repeatable; a bare name means your account)',
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
      '-m, --metadata <key=value>',
      'attach metadata (repeatable)',
      collectKeyValue,
      {} as Record<string, string>,
    )
    .option('-d, --detach', 'start and return immediately, the default')
    .option(
      '-w, --watch',
      'block until the session reaches a terminal status, streaming live output',
    )
    .option(
      '--quiet',
      'with --watch, wait without streaming: print only the final result and exit with a matching code',
    )
    .option(
      '--connect',
      'after starting, open the conversation: follow it live and send messages',
    )
    .option('--json', 'output raw JSON')
    .action(
      async (
        promptWords: string[],
        opts: {
          config?: string
          configFile?: string
          template?: string
          environment?: string
          override?: string
          overrideFile?: string
          model?: string
          system?: string
          repo: string[]
          cpu?: number
          memory?: string
          timeout?: string
          rebuild?: boolean
          budget?: number
          prompt?: string
          metadata: Record<string, string>
          detach?: boolean
          watch?: boolean
          quiet?: boolean
          connect?: boolean
          json?: boolean
        },
      ) => {
        await runAction(async () => {
          // A config source is optional: with none, the server runs on the
          // platform default config and the prompt is the sole instruction.
          // At most one source may be given.
          const sources = [opts.config, opts.configFile, opts.template].filter(Boolean)
          if (sources.length > 1) {
            throw new Error('provide only one of --config / --config-file / --template')
          }
          // An unquoted prompt arrives as one word per argv entry, so join it
          // back into a sentence: `agent fix the tests` means one instruction.
          const promptArg = promptWords.length > 0 ? promptWords.join(' ') : undefined
          // The prompt is either positional or --prompt, not both.
          if (promptArg !== undefined && opts.prompt !== undefined) {
            throw new Error('provide the prompt positionally or with --prompt, not both')
          }
          const promptText = promptArg ?? opts.prompt
          // At most one attach mode. --detach is the default made explicit;
          // --watch blocks (live, or quiet with --quiet); --connect is interactive.
          const modes = [
            opts.detach && '--detach',
            opts.watch && '--watch',
            opts.connect && '--connect',
          ].filter(Boolean)
          if (modes.length > 1) {
            throw new Error(`provide at most one of ${modes.join(' / ')}`)
          }
          if (opts.quiet && !opts.watch) {
            throw new Error('--quiet only applies with --watch')
          }
          // --connect takes over the terminal, so it can't emit the NDJSON stream.
          if (opts.connect && opts.json) {
            throw new Error('--connect is interactive and cannot be combined with --json')
          }
          const req: StartAgentSessionRequest = {
            metadata: opts.metadata,
          }
          if (opts.config) req.config_id = opts.config
          if (opts.configFile) req.config = readConfigFile(opts.configFile) as AgentConfig
          // Templates left the start request (#6394): resolve the slug to its
          // YAML via GET /v1/agents/templates/{slug} and start inline.
          if (opts.template) {
            const template = await api().agents.templates.get(opts.template)
            req.config = parseYaml(template.yaml) as AgentConfig
          }
          // The environment is only a session-level choice when no config
          // decides it; the server 400s the combination, so pre-check locally
          // for a clearer error.
          if (opts.environment) {
            if (opts.config || opts.configFile) {
              throw new Error(
                '--environment cannot be combined with --config/--config-file: the agent config decides its environment',
              )
            }
            req.environment = opts.environment
          }
          // The repo we're standing in (origin remote), sent unconditionally —
          // with no config source it picks the repo rung of the server's
          // defaults ladder, and either way the server merges it into the
          // sandbox checkout set. Outside a git repo (or with no usable
          // remote) nothing is sent.
          const contextRepo = repoFromCwd(process.cwd())
          if (contextRepo) req.repository = contextRepo
          // Sugar flags (--model, --repo, --cpu, ...) and the raw
          // --override are merged into one structured override, applied
          // onto the chosen (or default) config and re-validated server-side.
          const override = buildStartOverride(opts)
          if (override) req.override = override
          // Appended to the initial user query at build time; gives this
          // session instructions on top of the config's shared system prompt.
          if (promptText) req.prompt = promptText
          // Skip the image cache for the initial provision (wakes cache as
          // usual); the fresh build's snapshot becomes the new cache entry.
          if (opts.rebuild) req.force_rebuild = true
          // A promptless start opens idle: no fabricated kickoff message,
          // Claude Code waits at the prompt like a local `claude` (the
          // server-side contract since #6394 — nothing extra to send).

          const client = api()
          const { session } = await client.sessions.start(req)

          // Say which agent the server picked when it came from the defaults
          // ladder, so a bare `agent` never silently runs an unexpected config.
          // The connect UI shows the config in its footer meta line (anything
          // printed before the app would land in scrollback); every other
          // mode prints this note.
          const resolvedConfigName = sessionConfigName(session)
          let configNote: string | undefined
          if (resolvedConfigName) {
            if (session.agent.source === 'repo_default') {
              configNote = `using config "${resolvedConfigName}" (repo default)`
            } else if (session.agent.source === 'account_default') {
              configNote = `using config "${resolvedConfigName}" (account default)`
            }
          }
          // Same transparency for the environment ladder: say which
          // environment the server resolved when the session didn't name one.
          const environmentSource = session.environment?.source
          if (session.environment?.environment_id && environmentSource !== 'request') {
            const label =
              environmentSource === 'repo_default'
                ? 'repo default'
                : environmentSource === 'account_default'
                  ? 'account default'
                  : environmentSource === 'agent_config'
                    ? 'from the agent config'
                    : environmentSource
            const note = `using environment ${session.environment.environment_id} (${label})`
            configNote = configNote ? `${configNote}; ${note}` : note
          }

          if (opts.connect) {
            // A non-interactive config refuses the stream/messages surface, so
            // a connect would fail; degrade to watching the output instead.
            // The wire session carries no config blob, so interactivity comes
            // from the same projection POST /messages enforces.
            if (!session.prompting.enabled) {
              if (configNote) console.log(configNote)
              console.log(
                'this agent is not interactive; watching output instead of connecting',
              )
              console.log(`✓ started session ${session.id}`)
              await printSessionUrl(client, session.id)
              await watchSessionStreaming(client, session.id, FALLBACK_POLL_INTERVAL_SECONDS, false)
              return
            }
            await startConnect(session, undefined, resolvedConfigName ?? undefined)
            return
          }

          if (!opts.json && configNote) console.log(configNote)

          if (opts.watch) {
            if (!opts.json) {
              console.log(`✓ started session ${session.id}`)
              await printSessionUrl(client, session.id)
            }
            // --quiet blocks on status only (no live output stream); either way
            // the terminal status sets the exit code.
            if (opts.quiet) {
              await watchSession(client, session.id, FALLBACK_POLL_INTERVAL_SECONDS, opts.json)
            } else {
              await watchSessionStreaming(
                client,
                session.id,
                FALLBACK_POLL_INTERVAL_SECONDS,
                opts.json,
              )
            }
            return
          }

          if (opts.json) {
            printJson(session)
            return
          }
          console.log(`✓ started session ${session.id} (${session.status})`)
          await printSessionUrl(client, session.id)
          console.log(`  follow with: agent session get ${session.id} --watch`)
        })
      },
    )

  apiRoutes(
    alsoKnownAs(
      session.command('list').description('List recent sessions, newest first'),
      'ls',
    ).addHelpText(
      'after',
      '\nSources: react, manual, api, cli, mention, cron. ' +
        '--since/--until accept ISO 8601 or "today", "yesterday", "N days ago".',
    ),
    'GET /v1/sessions',
    'GET /v1/integrations/github/members to resolve --author',
  )
    .option('-c, --config <config-id>', 'only sessions run by this saved agent config')
    .option(
      '-s, --source <source>',
      'only sessions from this source (repeatable)',
      collectSource,
      [] as string[],
    )
    .option(
      '-a, --author <login>',
      'only sessions attributed to this GitHub login (see `agent github members`)',
    )
    .option('--days <n>', 'look back N days', toInt)
    .option('--since <when>', 'only sessions at or after this time', (v: string) => parseWhen(v))
    .option('--until <when>', 'only sessions at or before this time', (v: string) => parseWhen(v))
    .option('-l, --limit <n>', 'max sessions to return', toInt, 50)
    .option('--json', 'output raw JSON')
    .action(
      async (opts: {
        config?: string
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
              config_id: opts.config,
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
            ['ID', 'STATUS', 'SOURCE', 'CREATED', 'COST'],
            sessions.map((s) => [
              s.id,
              s.status,
              s.source ?? '-',
              formatTs(s.created_at),
              usdFromMillicents(s.cost?.total ?? 0),
            ]),
          )
        })
      },
    )

  apiRoutes(
    session
      .command('search <query>')
      .description('Search session history by transcript text, recap, created PR, or similarity')
      .addHelpText(
        'after',
        '\nA PR-shaped query ("#512", "acme/api#512", or a pull request URL) also finds the ' +
          'session that created that exact pull request.\n' +
          'Sources: react, manual, api, cli, mention, cron. ' +
          '--since/--until accept ISO 8601 or "today", "yesterday", "N days ago".',
      ),
    'GET /v1/sessions/search',
    'GET /v1/integrations/github/members to resolve --author',
  )
    .option(
      '-a, --author <login>',
      'only sessions attributed to this GitHub login (see `agent github members`)',
    )
    .option(
      '-c, --config <config-id>',
      'only sessions run by this saved agent config (repeatable)',
      collect,
      [] as string[],
    )
    .option(
      '-s, --source <source>',
      'only sessions from this source (repeatable)',
      collectSource,
      [] as string[],
    )
    .option('-r, --repo <owner/name>', 'only sessions on this repository (a bare name works too)')
    .option(
      '--status <status>',
      'only sessions in this status (repeatable)',
      collectStatus,
      [] as string[],
    )
    .option('--scope <scope>', 'what to search: records, recaps, or both', parseScope, 'both')
    .option(
      '--session <session-id>',
      'restrict the search to this session (repeatable)',
      collect,
      [] as string[],
    )
    .option('--since <when>', 'only sessions at or after this time', (v: string) => parseWhen(v))
    .option('--until <when>', 'only sessions at or before this time', (v: string) => parseWhen(v))
    .option('-l, --limit <n>', 'max result sessions (up to 100)', toInt, 20)
    .option('--json', 'output raw JSON')
    .action(
      async (
        query: string,
        opts: {
          author?: string
          config: string[]
          source: string[]
          repo?: string
          status: string[]
          scope: string
          session: string[]
          since?: string
          until?: string
          limit: number
          json?: boolean
        },
      ) => {
        await runAction(async () => {
          const client = api()
          const authorId = opts.author ? await resolveAuthorId(client, opts.author) : undefined
          const res = await client.sessions.search({
            q: query,
            scope: opts.scope as SessionSearchScope,
            source: opts.source.length ? (opts.source as AgentSessionSource[]) : undefined,
            author_id: authorId === undefined ? undefined : [authorId],
            config_id: opts.config.length ? opts.config : undefined,
            session_ids: opts.session.length ? opts.session : undefined,
            repo: opts.repo,
            status: opts.status.length ? (opts.status as AgentSessionStatus[]) : undefined,
            start: opts.since,
            end: opts.until,
            limit: opts.limit,
          })
          if (opts.json) {
            printJson(res)
            return
          }
          if (res.results.length === 0) {
            console.log('No matching sessions found.')
            return
          }
          for (const result of res.results) {
            for (const line of formatSearchResult(result, res.attributed_users)) {
              console.log(line)
            }
          }
          console.log(
            '\nInspect one: agent session get <session-id>. Full history: agent session export <session-id>',
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
    'GET /v1/sessions/{id}/export',
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
          const manifest = await api().sessions.export(sessionId)
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
      .command('get <session-id>')
      .description("Show one session's status, cost, and dashboard link"),
    'GET /v1/sessions/{id}',
    'WS /v1/sessions/{id}/stream with --watch',
  )
    .option(
      '-w, --watch',
      'block until the session reaches a terminal status, streaming live output',
    )
    .option('--quiet', 'with --watch, wait without streaming: print only the final result')
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
            if (opts.quiet) {
              await watchSession(client, sessionId, FALLBACK_POLL_INTERVAL_SECONDS, opts.json)
            } else {
              await watchSessionStreaming(
                client,
                sessionId,
                FALLBACK_POLL_INTERVAL_SECONDS,
                opts.json,
              )
            }
            return
          }
        if (opts.json) {
          printJson((await client.sessions.get(sessionId)).session)
          return
        }
        // Fetch the session and the login (for the link) together — no added latency.
        const [{ session: s }, me] = await Promise.all([
          client.sessions.get(sessionId),
          client.me(),
        ])
        printSessionSummary(s)
        console.log(`url:       ${sessionUrl(resolveAppBase(), me.customer_login, sessionId)}`)
      })
    })

  apiRoutes(
    session
      .command('replay <session-id>')
      .description("Re-run an existing session's trigger input as a fresh session"),
    'POST /v1/sessions/{id}/replay',
    'WS /v1/sessions/{id}/stream with --watch',
  )
    .option(
      '-c, --config <config-id>',
      "run against a different saved agent config instead of the original session's snapshot",
    )
    .option(
      '--override <yaml>',
      'partial patch (YAML/JSON) on the replayed config, e.g. "claude:\\n  model: claude-opus-4-8"',
    )
    .option(
      '--override-file <path>',
      'read the partial override from a file (.yaml/.yml or .json) instead of inline',
    )
    .option(
      '-p, --prompt <text>',
      "the session prompt; omit to inherit the original session's prompt, pass '' to clear it",
    )
    .option(
      '-w, --watch',
      'block until the session reaches a terminal status, streaming live output',
    )
    .option('--quiet', 'with --watch, wait without streaming: print only the final result')
    .option('--json', 'output raw JSON')
    .action(
      async (
        sessionId: string,
        opts: {
          config?: string
          override?: string
          overrideFile?: string
          prompt?: string
          watch?: boolean
          quiet?: boolean
          json?: boolean
        },
      ) => {
        await runAction(async () => {
          if (opts.quiet && !opts.watch) {
            throw new Error('--quiet only applies with --watch')
          }
          const req: ReplayAgentSessionRequest = {}
          if (opts.config) req.config_id = opts.config
          applyConfigOverride(req, opts)
          // Distinguish "flag omitted" (inherit the original prompt) from
          // `--prompt ''` (clear it): only set the field when the flag was passed.
          if (opts.prompt !== undefined) req.prompt = opts.prompt

          const client = api()
          const { session } = await client.sessions.replay(sessionId, req)

          if (opts.watch) {
            if (!opts.json) {
              console.log(`✓ started replay ${session.id} (from ${sessionId})`)
              await printSessionUrl(client, session.id)
            }
            if (opts.quiet) {
              await watchSession(client, session.id, FALLBACK_POLL_INTERVAL_SECONDS, opts.json)
            } else {
              await watchSessionStreaming(
                client,
                session.id,
                FALLBACK_POLL_INTERVAL_SECONDS,
                opts.json,
              )
            }
            return
          }
          if (opts.json) {
            printJson(session)
            return
          }
          console.log(`✓ started replay ${session.id} (${session.status}, from ${sessionId})`)
          await printSessionUrl(client, session.id)
          console.log(`  follow with: agent session get ${session.id} --watch`)
        })
      },
    )

  apiRoutes(
    session.command('stop <session-id>').description('Stop an in-flight session'),
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
        console.log(`✓ stopped session ${sessionId} (${s.status})`)
      })
    })
}

// `start --connect`: drop straight into the multi-session UI focused on the
// fresh session (or the solo connect when no TTY hosts the sidebar). The
// chat renders the sandbox lifecycle (creating sandbox → spawning agent
// process) as it happens and reports a terminal status reached before the
// sandbox ever ran (a preflight/budget gate), so there is nothing to wait
// for out here.
export async function startConnect(
  session: AgentSession,
  notice?: string,
  // The start response's resolved config name, which the session itself does
  // not carry; shown in the chat footer's meta line.
  resolvedConfigName?: string,
): Promise<void> {
  const configName = resolvedConfigName ?? sessionConfigName(session) ?? undefined
  if (canHostSessionsUi()) {
    await runSessionsUi({
      initialSessionId: session.id,
      initialConfigName: configName,
      initialNotice: notice,
      buildStartRequest: defaultStartRequest,
    })
    return
  }
  await runConnect(session.id, true, false, notice, configName)
}

// `--watch` entry point: stream the session's output live over WebSocket, and
// fall back to REST status polling if streaming is unavailable (e.g. a
// backend without the endpoint). Identical UX either way — the same flag
// covers both.
export async function watchSessionStreaming(
  client: Ellipsis,
  sessionId: string,
  intervalSeconds: number,
  json?: boolean,
): Promise<void> {
  const token = requireToken()
  const openSocket = makeOpenSocket(token, resolveWsBase(resolveApiBase()))

  // Session frames are LWW snapshots resent on any change (cost ticks
  // included), so collapse to status-word transitions — both to keep the
  // human log quiet and the NDJSON stream clean of near-duplicates. Heartbeats
  // are liveness only; deltas are ephemeral partials the committed record
  // supersedes — a line-oriented log skips both.
  let lastStatus: string | undefined
  const onFrame = (frame: StreamFrame) => {
    if (frame.type === 'session' || frame.type === 'snapshot') {
      const word = sessionStatusWord(
        (frame as unknown as { session: FrameSession }).session,
      )
      if (word === lastStatus) return
      lastStatus = word
    }
    if (frame.type === 'heartbeat' || frame.type === 'delta') return
    if (json) {
      console.log(JSON.stringify(frame))
      return
    }
    renderFrameHuman(frame, lastStatus)
  }

  let outcome: StreamOutcome
  try {
    outcome = await streamSession({ sessionId, openSocket, onFrame })
  } catch (err) {
    if (err instanceof StreamUnavailableError) {
      if (!json) {
        console.error(
          `live stream unavailable (${err.message}); falling back to status polling`,
        )
      }
      await watchSession(client, sessionId, intervalSeconds, json)
      return
    }
    throw err // StreamAuthError and anything unexpected: surfaced by runAction.
  }

  if (outcome.type === 'aborted') return
  if (outcome.type === 'error') {
    process.exitCode = 1
    return
  }
  // Terminal `done` frame. Output already streamed live; print a one-line cap.
  if (!json) {
    const mark = outcome.status === 'completed' ? '✓' : '✗'
    console.log(`\n${mark} session ${sessionId} ${outcome.status}`)
  }
  if (exitCodeForStatus(outcome.status) !== 0) process.exitCode = 1
}

function renderFrameHuman(frame: StreamFrame, statusWord?: string): void {
  switch (frame.type) {
    case 'snapshot':
    case 'session':
      console.log(`${nowClock()}  ${statusWord ?? ''}`)
      break
    case 'records_append': {
      // Raw records, rendered client-side (the semantic-relay philosophy):
      // one line per transcript item, same shaping as `session connect`.
      // Lifecycle records render too (recordToItems shapes them through
      // lifecycleText): the startup narrative — scheduled, phase
      // transitions with cache tier + duration, setup output, ready —
      // belongs in a watch log; types without display copy (message_*/
      // turn_* bookkeeping) shape to nothing.
      const records = (frame as { records: SessionRecord[] }).records
      for (const record of records) {
        for (const item of recordToItems(record, `w${record.feed_seq}`)) {
          const line = item.detail ? `${item.text}  ${item.detail}` : item.text
          if (line.trim()) console.log(line)
        }
      }
      break
    }
    case 'error':
      console.error(`error: ${(frame as { message?: string }).message ?? 'stream error'}`)
      break
    case 'done':
      break // handled by the caller
    default:
      break // unknown frame types are ignored (protocol §3.6)
  }
}

// Exit 0 for a successful terminal status, non-zero otherwise (spec §4.1).
export function exitCodeForStatus(status: string): number {
  return status === 'completed' ? 0 : 1
}

// Poll a session until it reaches a terminal status, printing each status
// transition. This is the status-level fallback used when live streaming isn't
// available: the public REST API exposes session state, not the step-by-step stream.
export async function watchSession(
  client: Ellipsis,
  sessionId: string,
  intervalSeconds: number,
  json?: boolean,
): Promise<void> {
  const intervalMs = Math.max(1, intervalSeconds) * 1000
  let last: AgentSessionStatus | undefined
  for (;;) {
    const { session: s } = await client.sessions.get(sessionId)
    if (s.status !== last) {
      if (!json) {
        const reason = s.status_reason ? `: ${s.status_reason}` : ''
        console.log(`${nowClock()}  ${s.status}${reason}`)
      }
      last = s.status
    }
    if (TERMINAL_STATUSES.has(s.status)) {
      if (json) {
        printJson(s)
      } else {
        console.log('')
        printSessionSummary(s)
      }
      if (exitCodeForStatus(s.status) !== 0) process.exitCode = 1
      return
    }
    await sleep(intervalMs)
  }
}

function printSessionSummary(s: AgentSession): void {
  console.log(`id:        ${s.id}`)
  console.log(`status:    ${s.status}${s.status_reason ? ` (${s.status_reason})` : ''}`)
  if (s.source) console.log(`source:    ${s.source}`)
  const config = sessionConfigName(s)
  if (config) console.log(`config:    ${config}`)
  console.log(`created:   ${s.created_at}`)
  console.log(`updated:   ${s.updated_at}`)
  console.log(`tokens:    ${(s.tokens?.total ?? 0).toLocaleString()}`)
  console.log(`cost:      ${usdFromMillicents(s.cost?.total ?? 0)}`)
  const keys = Object.keys(s.metadata ?? {})
  if (keys.length) {
    console.log('metadata:')
    for (const k of keys) console.log(`  ${k}=${s.metadata[k]}`)
  }
}

// Print a clickable dashboard link for a session. The route is scoped by
// account login, which isn't on the session object, so resolve it from /me.
async function printSessionUrl(client: Ellipsis, sessionId: string): Promise<void> {
  const me = await client.me()
  console.log(`  ${sessionUrl(resolveAppBase(), me.customer_login, sessionId)}`)
}

// Apply the mutually-exclusive override flags onto a session request: an
// inline YAML/JSON string or a file, both parsed to the one structured
// `override` patch applied onto the resolved config server-side.
export function applyConfigOverride(
  req: {
    override?: Record<string, unknown> | null
  },
  opts: { override?: string; overrideFile?: string },
): void {
  if (opts.override && opts.overrideFile) {
    throw new Error('provide only one of --override / --override-file')
  }
  if (opts.overrideFile) {
    req.override = readMappingFile(opts.overrideFile, 'override')
  } else if (opts.override) {
    const parsed = parseYaml(opts.override)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('--override must be a YAML/JSON mapping of fields to override')
    }
    req.override = parsed as Record<string, unknown>
  }
}

// Build the single structured config override for `session start`. The raw
// --override / --override-file supplies the base mapping (any
// field); the sugar flags (--model, --system, --repo, --cpu, --memory,
// --timeout, --budget) are assembled into a partial config and deep-merged on
// top, so an explicit flag wins over the same field in a raw override. Returns
// undefined when nothing was set (no override sent). The result is applied onto
// the chosen (or default) config and re-validated server-side.
export function buildStartOverride(opts: {
  override?: string
  overrideFile?: string
  model?: string
  system?: string
  repo?: string[]
  cpu?: number
  memory?: string
  timeout?: string
  budget?: number
}): Record<string, unknown> | undefined {
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

  const sugar: Record<string, unknown> = {}
  const claude: Record<string, unknown> = {}
  if (opts.model !== undefined) claude.model = opts.model
  if (opts.system !== undefined) claude.system = opts.system
  if (Object.keys(claude).length) sugar.claude = claude

  const compute: Record<string, unknown> = {}
  if (opts.cpu !== undefined) compute.cpu = opts.cpu
  if (opts.memory !== undefined) compute.memory = opts.memory
  if (opts.timeout !== undefined) compute.timeout = opts.timeout
  const environment: Record<string, unknown> = {}
  if (Object.keys(compute).length) environment.compute = compute
  if (opts.repo && opts.repo.length) environment.repositories = opts.repo.map(parseRepo)
  if (Object.keys(environment).length) sugar.environment = environment

  if (opts.budget !== undefined) sugar.budget = { session: opts.budget }

  const merged = deepMerge(base, sugar)
  return Object.keys(merged).length ? merged : undefined
}

// Parse a --repo value into an environment.repositories entry. "owner/name" sets
// both; a bare "name" omits owner so the server defaults it to the account.
function parseRepo(value: string): { name: string; owner?: string } {
  const parts = value.split('/')
  if (parts.length === 1 && parts[0]) return { name: parts[0] }
  if (parts.length === 2 && parts[0] && parts[1]) return { owner: parts[0], name: parts[1] }
  throw new Error(`--repo must be "name" or "owner/name", got "${value}"`)
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
    out[k] = isPlainObject(b) && isPlainObject(v) ? deepMerge(b, v) : v
  }
  return out
}

// Parse an inline agent config from disk, choosing the parser by file
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
// (author_id on GET /sessions and /sessions/search), via the org roster.
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

// One search result as display lines: a header (id, status, author, age,
// matched arms), then the best snippet indented. The recap snippet wins over
// record hits when both matched; record_hit_count renders as a trailing count
// so "many hits" is visible without dumping every record. Exported for tests.
export function formatSearchResult(
  result: SessionSearchResult,
  users: Record<string, GithubAccountSnippet>,
  now: Date = new Date(),
): string[] {
  const s = result.session
  const author = s.attribution?.id ? users[String(s.attribution.id)]?.login : undefined
  const header = [
    s.id,
    s.status,
    ...(author ? [author] : []),
    relativeAge(s.created_at, now),
    `matched: ${result.matched.join(', ')}`,
  ].join('  ')
  const lines = [header]
  const snippet = result.recap_snippet ?? result.record_hits[0]?.snippet
  if (snippet) lines.push(`    ${oneLine(snippet, 200)}`)
  if (result.record_hit_count > 1) {
    lines.push(`    ${result.record_hit_count} matching records`)
  }
  return lines
}

// formatStepLine / recordText moved to lib/steps.ts (shared with `session
// connect`); re-exported here for existing importers and tests.
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
