import type { Command } from 'commander'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { parse as parseYaml } from 'yaml'
import { ApiClient } from '../lib/api'
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
import { sessionUrl } from '../lib/urls'
import {
  resolveWsBase,
  streamSession,
  StreamUnavailableError,
  type StreamFrame,
  type StreamOutcome,
} from '../lib/ws'
import type {
  AgentSession,
  AgentSessionSource,
  AgentSessionStatus,
  GithubAccountSnippet,
  ReplayAgentSessionRequest,
  SessionSearchResult,
  SessionSearchScope,
  SessionTranscript,
  StartAgentSessionRequest,
  SyncAgentSessionRequest,
} from '../lib/types'
import {
  branchFromCwd,
  createWipCommit,
  dropSpooledSync,
  enrolledRepos,
  listSpooledSyncs,
  pushHandoffRef,
  recordSyncOutcome,
  redactLine,
  repoFromCwd,
  spoolSync,
  type SyncOutcome,
} from '../lib/laptop'
import { openBrowser } from '../lib/auth'
import { registerConnect, runConnect } from './connect'
import { formatStepLine, oneLine, recordText } from '../lib/steps'
import { ApiError } from '../lib/api'
import { resolveToken } from '../lib/config'

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
  const session = program.command('session').description('Start and inspect agent sessions')

  // `session connect` lives in connect.ts (the interactive terminal window
  // into a cloud session); registered here so it sits with its siblings.
  registerConnect(session)

  session
    .command('start')
    .description('Start a new agent session (POST /v1/sessions)')
    .argument(
      '[prompt]',
      'what the agent should do this session (positional shorthand for --prompt)',
    )
    .option(
      '-c, --config <id>',
      'start from a saved agent config id (default: the platform default config)',
    )
    .option(
      '-f, --config-file <path>',
      'start from an inline agent config (.yaml/.yml or .json file)',
    )
    .option(
      '-t, --template <slug>',
      'start from a maintained session template (e.g. welcome-to-ellipsis)',
    )
    .option(
      '-o, --config-override <yaml>',
      'partial agent config (YAML/JSON) merged onto the chosen config for this session, e.g. "limits:\\n  run: 5"',
    )
    .option(
      '--config-override-file <path>',
      'read the partial config override from a file (.yaml/.yml or .json) instead of inline',
    )
    .option('--model <id>', 'set claude.model for this session (e.g. claude-opus-4-8)')
    .option('--system <text>', 'set claude.system (the agent system prompt) for this session')
    .option(
      '--repo <owner/name>',
      'check out a repository in the sandbox (repeatable; "name" defaults owner to your account)',
      collect,
      [] as string[],
    )
    .option('--cpu <n>', 'sandbox vCPUs (e.g. 2 or 0.5)', toNumber)
    .option('--memory <size>', 'sandbox memory (e.g. 8GB)')
    .option('--timeout <duration>', 'sandbox timeout (e.g. 30m or 1h)')
    .option('--budget <usd>', 'per-run spend limit in USD for this session (limits.run)', toNumber)
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
    .option('-d, --detach', 'start and return immediately (fire-and-forget; the default)')
    .option(
      '-w, --watch',
      'block until the session reaches a terminal status, streaming live output',
    )
    .option(
      '--quiet',
      'with --watch, wait without streaming — print only the final result and exit with a matching code',
    )
    .option(
      '--connect',
      'after starting, wait for the sandbox and connect: view the conversation, follow it live, and send messages',
    )
    .option('--json', 'output raw JSON')
    .action(
      async (
        promptArg: string | undefined,
        opts: {
          config?: string
          configFile?: string
          template?: string
          configOverride?: string
          configOverrideFile?: string
          model?: string
          system?: string
          repo: string[]
          cpu?: number
          memory?: string
          timeout?: string
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
          if (opts.configFile) req.config = readConfigFile(opts.configFile)
          if (opts.template) req.template_id = opts.template
          // Sugar flags (--model, --repo, --cpu, ...) and the raw
          // --config-override are merged into one structured override, applied
          // onto the chosen (or default) config and re-validated server-side.
          const override = buildStartOverride(opts)
          if (override) req.config_override = override
          // Appended to the initial user query at build time; gives this
          // session instructions on top of the config's shared system prompt.
          if (promptText) req.prompt = promptText

          const api = new ApiClient()
          const session = await api.startAgentSession(req)

          if (opts.connect) {
            await startConnect(session)
            return
          }

          if (opts.watch) {
            if (!opts.json) {
              console.log(`✓ started session ${session.id}`)
              await printSessionUrl(api, session.id)
            }
            // --quiet blocks on status only (no live output stream); either way
            // the terminal status sets the exit code.
            if (opts.quiet) {
              await watchSession(api, session.id, FALLBACK_POLL_INTERVAL_SECONDS, opts.json)
            } else {
              await watchSessionStreaming(api, session.id, FALLBACK_POLL_INTERVAL_SECONDS, opts.json)
            }
            return
          }

          if (opts.json) {
            printJson(session)
            return
          }
          console.log(`✓ started session ${session.id} (${session.status})`)
          await printSessionUrl(api, session.id)
          console.log(`  follow with: agent session get ${session.id} --watch`)
        })
      },
    )

  session
    .command('list')
    .description('List recent agent sessions (GET /v1/sessions)')
    .option('-c, --config <id>', 'filter by config id')
    .option('-s, --source <source>', 'filter by source (repeatable)', collect, [] as string[])
    .option(
      '-a, --author <login>',
      'only sessions attributed to this developer (a GitHub login, see `agent github members`)',
    )
    .option('-d, --days <n>', 'look back N days', toInt)
    .option('--start <iso>', 'start of the time window (ISO 8601)')
    .option('--end <iso>', 'end of the time window (ISO 8601)')
    .option('-l, --limit <n>', 'max sessions to return', toInt, 50)
    .option('--json', 'output raw JSON')
    .action(
      async (opts: {
        config?: string
        source: string[]
        author?: string
        days?: number
        start?: string
        end?: string
        limit: number
        json?: boolean
      }) => {
        await runAction(async () => {
          const api = new ApiClient()
          const sessions = await api.listAgentSessions({
            config_id: opts.config,
            source: opts.source.length ? (opts.source as AgentSessionSource[]) : undefined,
            author_id: opts.author ? await resolveAuthorId(api, opts.author) : undefined,
            days: opts.days,
            start: opts.start,
            end: opts.end,
            limit: opts.limit,
          })
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
              s.source ?? '—',
              formatTs(s.created_at),
              usdFromMillicents(
                s.cost_tokens + s.cost_sandbox_cpu + s.cost_sandbox_memory + s.cost_fee,
              ),
            ]),
          )
        })
      },
    )

  session
    .command('search <query>')
    .description(
      'Search sessions by step text, recap text, created PR, or similarity (GET /v1/sessions/search)',
    )
    .addHelpText(
      'after',
      '\nA PR-shaped query ("#512", "acme/api#512", or a pull request URL) also finds the ' +
        'session that created that exact pull request.\n' +
        'Sources: laptop, react, manual, api, cli, mention, cron. ' +
        '--since/--until accept ISO 8601 or "today", "yesterday", "N days ago".',
    )
    .option(
      '-a, --author <login>',
      'only sessions attributed to this developer (a GitHub login, see `agent github members`)',
    )
    .option('-c, --config <id>', 'only sessions run by this saved config (repeatable)', collect, [] as string[])
    .option('-s, --source <source>', 'filter by source (repeatable)', collectSource, [] as string[])
    .option('-r, --repo <name>', 'only sessions on this repository ("owner/name" or a bare name)')
    .option('--status <status>', 'filter by session status (repeatable)', collectStatus, [] as string[])
    .option('--scope <scope>', 'what to search: steps, recaps, or both', parseScope, 'both')
    .option('--session <id>', 'restrict the search to this session (repeatable)', collect, [] as string[])
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
          const api = new ApiClient()
          const authorId = opts.author ? await resolveAuthorId(api, opts.author) : undefined
          const res = await api.searchSessions({
            q: query,
            scope: opts.scope as SessionSearchScope,
            source: opts.source.length ? (opts.source as AgentSessionSource[]) : undefined,
            author_id: authorId === undefined ? undefined : [authorId],
            agent_config_id: opts.config.length ? opts.config : undefined,
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
            '\nInspect one: agent session get <id>; full transcript: agent session records <id>',
          )
        })
      },
    )

  session
    .command('records <sessionId>')
    .description("Read a session's records (GET /v1/sessions/{id}/records)")
    .option('--json', 'output raw JSON (full record payloads)')
    .action(async (sessionId: string, opts: { json?: boolean }) => {
      await runAction(async () => {
        const records = await new ApiClient().getAgentSessionRecords(sessionId)
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

  session
    .command('transcript <sessionId>')
    .description(
      "Download a session's raw transcript files (GET /v1/sessions/{id}/transcripts)",
    )
    .option('-o, --output <path>', 'write to a file instead of stdout')
    .option('--process <processId>', 'pick a specific process (retries have several)')
    .option('--all', "download every process's transcript")
    .option('-d, --dir <dir>', 'directory for --all downloads', '.')
    .option('--json', 'print the metadata response (incl. download URLs), download nothing')
    .option('--gzip', 'keep the .jsonl.gz bytes as-is (skip gunzip)')
    .action(
      async (
        sessionId: string,
        opts: {
          output?: string
          process?: string
          all?: boolean
          dir: string
          json?: boolean
          gzip?: boolean
        },
      ) => {
        await runAction(async () => {
          if (opts.all && (opts.process || opts.output)) {
            throw new Error('--all cannot be combined with --process or -o')
          }
          const res = await new ApiClient().getSessionTranscripts(sessionId)
          if (opts.json) {
            printJson(res)
            return
          }
          if (res.transcripts.length === 0) {
            console.log('No transcripts stored for this session.')
            return
          }
          const ext = opts.gzip ? 'jsonl.gz' : 'jsonl'
          if (opts.all) {
            mkdirSync(opts.dir, { recursive: true })
            for (const t of res.transcripts) {
              const path = join(opts.dir, `${t.process_id}.${ext}`)
              writeFileSync(path, await fetchTranscript(t, { gzip: opts.gzip }))
              console.log(path)
            }
            return
          }
          // Default: the latest process (the list is in process-creation
          // order, so retries supersede the attempts before them).
          let transcript = res.transcripts[res.transcripts.length - 1]!
          if (opts.process) {
            const picked = res.transcripts.find((t) => t.process_id === opts.process)
            if (!picked) {
              throw new Error(
                `no transcript for process '${opts.process}' — available: ` +
                  res.transcripts.map((t) => t.process_id).join(', '),
              )
            }
            transcript = picked
          }
          const data = await fetchTranscript(transcript, { gzip: opts.gzip })
          if (opts.output) {
            writeFileSync(opts.output, data)
            console.log(opts.output)
          } else {
            process.stdout.write(data)
          }
        })
      },
    )

  session
    .command('get <sessionId>')
    .description('Get a single agent session (GET /v1/sessions/{id})')
    .option(
      '-w, --watch',
      'block until the session reaches a terminal status, streaming live output',
    )
    .option('--quiet', 'with --watch, wait without streaming — print only the final result')
    .option('--json', 'output raw JSON')
    .action(
      async (sessionId: string, opts: { watch?: boolean; quiet?: boolean; json?: boolean }) => {
        await runAction(async () => {
          const api = new ApiClient()
          if (opts.quiet && !opts.watch) {
            throw new Error('--quiet only applies with --watch')
          }
          if (opts.watch) {
            if (!opts.json) await printSessionUrl(api, sessionId)
            if (opts.quiet) {
              await watchSession(api, sessionId, FALLBACK_POLL_INTERVAL_SECONDS, opts.json)
            } else {
              await watchSessionStreaming(api, sessionId, FALLBACK_POLL_INTERVAL_SECONDS, opts.json)
            }
            return
          }
        if (opts.json) {
          printJson(await api.getAgentSession(sessionId))
          return
        }
        // Fetch the session and the login (for the link) together — no added latency.
        const [s, me] = await Promise.all([api.getAgentSession(sessionId), api.whoami()])
        printSessionSummary(s)
        console.log(`url:       ${sessionUrl(resolveAppBase(), me.customer_login, sessionId)}`)
      })
    })

  session
    .command('replay <sessionId>')
    .description("Re-run an existing session's trigger input (POST /v1/sessions/{id}/replay)")
    .option(
      '-c, --config <id>',
      "run against a different saved config instead of the original session's snapshot",
    )
    .option(
      '-o, --config-override <yaml>',
      'partial agent config (YAML/JSON) merged onto the config for this replay, e.g. "claude:\\n  model: claude-opus-4-8"',
    )
    .option(
      '--config-override-file <path>',
      'read the partial config override from a file (.yaml/.yml or .json) instead of inline',
    )
    .option(
      '-p, --prompt <text>',
      "the session prompt; omit to inherit the original session's prompt, pass '' to clear it",
    )
    .option(
      '-w, --watch',
      'block until the session reaches a terminal status, streaming live output',
    )
    .option('--quiet', 'with --watch, wait without streaming — print only the final result')
    .option('--json', 'output raw JSON')
    .action(
      async (
        sessionId: string,
        opts: {
          config?: string
          configOverride?: string
          configOverrideFile?: string
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

          const api = new ApiClient()
          const session = await api.replayAgentSession(sessionId, req)

          if (opts.watch) {
            if (!opts.json) {
              console.log(`✓ started replay ${session.id} (from ${sessionId})`)
              await printSessionUrl(api, session.id)
            }
            if (opts.quiet) {
              await watchSession(api, session.id, FALLBACK_POLL_INTERVAL_SECONDS, opts.json)
            } else {
              await watchSessionStreaming(api, session.id, FALLBACK_POLL_INTERVAL_SECONDS, opts.json)
            }
            return
          }
          if (opts.json) {
            printJson(session)
            return
          }
          console.log(`✓ started replay ${session.id} (${session.status}, from ${sessionId})`)
          await printSessionUrl(api, session.id)
          console.log(`  follow with: agent session get ${session.id} --watch`)
        })
      },
    )

  // Laptop → cloud handoff (design: LOCAL_CLAUDE_CODE.md §7.2): snapshot the
  // dirty working tree as a commit (without disturbing it), push it to
  // refs/ellipsis/handoff/<short>, and start a fresh cloud session on the
  // built-in handoff config with that prompt as its query — never a
  // literal `claude --resume` of the local session.
  session
    .command('handoff <prompt>')
    .description('Hand the current repo + a synced session off to a cloud agent')
    .requiredOption(
      '-p, --parent <sessionId>',
      'the synced laptop session to chain from (see `agent session list --source laptop`)',
    )
    .option('--cwd <path>', 'repository to hand off (default: current directory)')
    .option('--json', 'output raw JSON')
    .action(
      async (
        prompt: string,
        opts: { parent: string; cwd?: string; json?: boolean },
      ) => {
        await runAction(async () => {
          const cwd = opts.cwd ?? process.cwd()
          const repo = repoFromCwd(cwd)
          if (!repo) {
            throw new Error('not inside a git repository with an origin remote')
          }
          const { sha, dirty } = createWipCommit(cwd)
          const ref = pushHandoffRef(cwd, sha)
          if (!opts.json) {
            console.log(
              dirty
                ? `✓ pushed working-tree snapshot ${sha.slice(0, 12)} to ${ref}`
                : `✓ working tree clean — handing off HEAD ${sha.slice(0, 12)} via ${ref}`,
            )
          }
          const api = new ApiClient()
          const session = await api.startAgentSession({
            handoff: { parent_session_id: opts.parent, repo, sha, ref },
            prompt,
          })
          if (opts.json) {
            printJson(session)
            return
          }
          console.log(`✓ started handoff session ${session.id} (${session.status})`)
          await printSessionUrl(api, session.id)
          console.log(`  follow with: agent session get ${session.id} --watch`)
        })
      },
    )

  // The laptop-transcript sync (design: LOCAL_CLAUDE_CODE.md §7.1). Normally
  // invoked by the Claude Code Stop/SessionEnd hooks `agent hooks install`
  // writes, with the hook's JSON context on stdin; the flags exist for manual
  // runs and testing. In hook mode every failure path is a QUIET no-op (exit
  // 0): consent gaps (unenrolled repo), a logged-out CLI, and network errors
  // must never surface into someone's Claude Code session. Network failures
  // spool to disk and flush on the next successful sync.
  session
    .command('sync')
    .description('Sync a Claude Code transcript to Ellipsis (invoked by CC hooks)')
    .option('--transcript <path>', 'transcript JSONL path (default: from hook stdin)')
    .option('--session-id <id>', 'Claude Code session id (default: from hook stdin)')
    .option('--reason <reason>', 'stop | session_end (default: from hook stdin)')
    .option('--cwd <path>', 'session working directory (default: from hook stdin)')
    .option('--json', 'output raw JSON')
    .action(
      async (opts: {
        transcript?: string
        sessionId?: string
        reason?: string
        cwd?: string
        json?: boolean
      }) => {
        await runAction(async () => {
          await syncTranscript(opts)
        })
      },
    )

  session
    .command('stop <sessionId>')
    .description('Stop an in-flight session (POST /v1/sessions/{id}/stop)')
    .option('--json', 'output raw JSON')
    .action(async (sessionId: string, opts: { json?: boolean }) => {
      await runAction(async () => {
        const api = new ApiClient()
        const s = await api.stopAgentSession(sessionId)
        if (opts.json) {
          printJson(s)
          return
        }
        console.log(`✓ stopped session ${sessionId} (${s.status})`)
      })
    })

  // The browser IDE into a live session's sandbox (GET /v1/sessions/{id}/ide).
  // The URL is the membership-gated dashboard page for the sandbox — no
  // credential in it, so it is durable and safe to share with any org member.
  // 409s (sandbox idle/torn down) carry curated server messages; runAction
  // surfaces them as-is.
  session
    .command('ide <sessionId>')
    .description("Open the session's browser IDE (GET /v1/sessions/{id}/ide)")
    .addHelpText(
      'after',
      "\nThe IDE shares the live sandbox's working tree with the agent. The URL is the " +
        'membership-gated dashboard page for the sandbox, so it is safe to share with ' +
        'org members; if the session is idle, send it a message to wake it first ' +
        '(agent session connect).',
    )
    .option('--no-open', 'print the URL without opening a browser')
    .option('--json', 'output raw JSON')
    .action(async (sessionId: string, opts: { open: boolean; json?: boolean }) => {
      await runAction(async () => {
        const res = await new ApiClient().getSessionIde(sessionId)
        if (opts.json) {
          printJson(res)
          return
        }
        console.log(res.url)
        if (opts.open) openBrowser(res.url)
      })
    })

  // A preview port's link (GET /v1/sessions/{id}/ports/{port}) — a dev
  // server the agent or the IDE user started in the sandbox, opened through
  // the same membership-gated dashboard page as the IDE.
  session
    .command('port <sessionId> <port>')
    .description("Open a preview port on the session's sandbox (GET /v1/sessions/{id}/ports/{port})")
    .addHelpText(
      'after',
      '\nAny TCP port serves (3000, 5173, 8000, 8080 are just the usual dev-server ' +
        'picks). The URL is the membership-gated dashboard page deep-linked to the ' +
        'port — safe to share with org members; the preview renders while something ' +
        'in the sandbox listens on that port.',
    )
    .option('--no-open', 'print the URL without opening a browser')
    .option('--json', 'output raw JSON')
    .action(
      async (sessionId: string, port: string, opts: { open: boolean; json?: boolean }) => {
        await runAction(async () => {
          const portNumber = Number.parseInt(port, 10)
          if (Number.isNaN(portNumber)) {
            throw new Error(`port must be a number, got "${port}"`)
          }
          const res = await new ApiClient().getSessionPort(sessionId, portNumber)
          if (opts.json) {
            printJson(res)
            return
          }
          console.log(res.url)
          if (opts.open) openBrowser(res.url)
        })
      },
    )
}

// `start --connect`: drop straight into the semantic connect (render the
// conversation, follow it live, send messages through the inbox — the same as
// `session connect`). The connect UI itself renders the sandbox lifecycle
// (creating sandbox → spawning agent process) as it happens and reports a
// terminal status reached before the sandbox ever ran (a preflight/budget gate),
// so there is nothing to wait for out here.
export async function startConnect(session: AgentSession): Promise<void> {
  await runConnect(session.id, true)
}

// `--watch` entry point: stream the session's output live over WebSocket, and
// fall back to REST status polling if streaming is unavailable (e.g. a
// backend without the endpoint). Identical UX either way — the same flag
// covers both.
export async function watchSessionStreaming(
  api: ApiClient,
  sessionId: string,
  intervalSeconds: number,
  json?: boolean,
): Promise<void> {
  const token = requireToken()
  const wsBase = resolveWsBase(resolveApiBase())

  // The server sends a `status` frame as its keepalive, so collapse unchanged
  // statuses — both to keep the human log quiet and the NDJSON stream clean.
  let lastStatus: string | undefined
  const onFrame = (frame: StreamFrame) => {
    if (frame.type === 'status') {
      if (frame.status === lastStatus) return
      lastStatus = frame.status
    }
    if (json) {
      console.log(JSON.stringify(frame))
      return
    }
    renderFrameHuman(frame)
  }

  let outcome: StreamOutcome
  try {
    outcome = await streamSession({ token, sessionId, wsBase, onFrame })
  } catch (err) {
    if (err instanceof StreamUnavailableError) {
      if (!json) {
        console.error(
          `live stream unavailable (${err.message}); falling back to status polling`,
        )
      }
      await watchSession(api, sessionId, intervalSeconds, json)
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

function renderFrameHuman(frame: StreamFrame): void {
  switch (frame.type) {
    case 'status':
      console.log(`${nowClock()}  ${frame.status}`)
      break
    case 'stdout':
      writeChunk(process.stdout, frame.data)
      break
    case 'stderr':
      writeChunk(process.stderr, frame.data)
      break
    case 'error':
      console.error(`error: ${frame.message ?? frame.data ?? 'stream error'}`)
      break
    case 'done':
      break // handled by the caller
  }
}

function writeChunk(stream: NodeJS.WriteStream, data?: string): void {
  if (!data) return
  stream.write(data.endsWith('\n') ? data : data + '\n')
}

// Exit 0 for a successful terminal status, non-zero otherwise (spec §4.1).
export function exitCodeForStatus(status: string): number {
  return status === 'completed' ? 0 : 1
}

// Poll a session until it reaches a terminal status, printing each status
// transition. This is the status-level fallback used when live streaming isn't
// available: the /v1 REST API exposes session state, not the step-by-step stream.
export async function watchSession(
  api: ApiClient,
  sessionId: string,
  intervalSeconds: number,
  json?: boolean,
): Promise<void> {
  const intervalMs = Math.max(1, intervalSeconds) * 1000
  let last: AgentSessionStatus | undefined
  for (;;) {
    const s = await api.getAgentSession(sessionId)
    if (s.status !== last) {
      if (!json) {
        const reason = s.status_reason ? ` — ${s.status_reason}` : ''
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
  if (s.agent_config_id) console.log(`config:    ${s.agent_config_id}`)
  console.log(`created:   ${s.created_at}`)
  console.log(`updated:   ${s.updated_at}`)
  console.log(`tokens:    ${s.tokens_total.toLocaleString()}`)
  console.log(
    `cost:      ${usdFromMillicents(
      s.cost_tokens + s.cost_sandbox_cpu + s.cost_sandbox_memory + s.cost_fee,
    )}`,
  )
  const keys = Object.keys(s.metadata ?? {})
  if (keys.length) {
    console.log('metadata:')
    for (const k of keys) console.log(`  ${k}=${s.metadata[k]}`)
  }
}

// Print a clickable dashboard link for a session. The route is scoped by
// account login, which isn't on the session object, so resolve it from /v1/me.
async function printSessionUrl(api: ApiClient, sessionId: string): Promise<void> {
  const me = await api.whoami()
  console.log(`  ${sessionUrl(resolveAppBase(), me.customer_login, sessionId)}`)
}

// Apply the mutually-exclusive config-override flags onto a session request.
// `--config-override` is an inline YAML/JSON string passed straight through as
// config_override_yaml; `--config-override-file` is read and parsed to a mapping
// and sent as the structured config_override. Both merge identically server-side.
export function applyConfigOverride(
  req: { config_override?: Record<string, unknown>; config_override_yaml?: string },
  opts: { configOverride?: string; configOverrideFile?: string },
): void {
  if (opts.configOverride && opts.configOverrideFile) {
    throw new Error('provide only one of --config-override / --config-override-file')
  }
  if (opts.configOverride) req.config_override_yaml = opts.configOverride
  if (opts.configOverrideFile) {
    req.config_override = readMappingFile(opts.configOverrideFile, 'config override')
  }
}

// Build the single structured config override for `session start`. The raw
// --config-override / --config-override-file supplies the base mapping (any
// field); the sugar flags (--model, --system, --repo, --cpu, --memory,
// --timeout, --budget) are assembled into a partial config and deep-merged on
// top, so an explicit flag wins over the same field in a raw override. Returns
// undefined when nothing was set (no override sent). The result is applied onto
// the chosen (or default) config and re-validated server-side.
export function buildStartOverride(opts: {
  configOverride?: string
  configOverrideFile?: string
  model?: string
  system?: string
  repo?: string[]
  cpu?: number
  memory?: string
  timeout?: string
  budget?: number
}): Record<string, unknown> | undefined {
  if (opts.configOverride && opts.configOverrideFile) {
    throw new Error('provide only one of --config-override / --config-override-file')
  }
  let base: Record<string, unknown> = {}
  if (opts.configOverrideFile) {
    base = readMappingFile(opts.configOverrideFile, 'config override')
  } else if (opts.configOverride) {
    const parsed = parseYaml(opts.configOverride)
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
  const sandbox: Record<string, unknown> = {}
  if (Object.keys(compute).length) sandbox.compute = compute
  if (opts.repo && opts.repo.length) sandbox.repositories = opts.repo.map(parseRepo)
  if (Object.keys(sandbox).length) sugar.sandbox = sandbox

  if (opts.budget !== undefined) sugar.limits = { run: opts.budget }

  const merged = deepMerge(base, sugar)
  return Object.keys(merged).length ? merged : undefined
}

// Parse a --repo value into a sandbox.repositories entry. "owner/name" sets
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
// (author_id on GET /v1/sessions and /v1/sessions/search), via the org roster.
// An unknown login fails with the known logins so the user can self-correct.
export async function resolveAuthorId(api: ApiClient, login: string): Promise<number> {
  const { members } = await api.listGithubMembers()
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
// step hits when both matched; step_hit_count renders as a trailing count so
// "many hits" is visible without dumping every step. Exported for tests.
export function formatSearchResult(
  result: SessionSearchResult,
  users: Record<string, GithubAccountSnippet>,
  now: Date = new Date(),
): string[] {
  const s = result.session
  const author = s.attribution_id ? users[String(s.attribution_id)]?.login : undefined
  const header = [
    s.id,
    s.status,
    ...(author ? [author] : []),
    relativeAge(s.created_at, now),
    `matched: ${result.matched.join(', ')}`,
  ].join('  ')
  const lines = [header]
  const snippet = result.recap_snippet ?? result.step_hits[0]?.snippet
  if (snippet) lines.push(`    ${oneLine(snippet, 200)}`)
  if (result.step_hit_count > 1) {
    lines.push(`    ${result.step_hit_count} matching steps`)
  }
  return lines
}

// formatStepLine / recordText moved to lib/steps.ts (shared with `session
// connect`); re-exported here for existing importers and tests.
export { formatStepLine, recordText }

// Pull a transcript from its presigned S3 URL (bare fetch — the signature in
// the URL is the credential) and gunzip unless the caller wants the raw
// .jsonl.gz bytes. A warning for a failed final write goes to stderr so the
// default stdout stream stays pure JSONL.
export async function fetchTranscript(
  transcript: SessionTranscript,
  opts: { gzip?: boolean },
): Promise<Buffer> {
  if (transcript.write_status === 'failed') {
    console.error(
      `warning: ${transcript.process_id}'s final transcript write failed — ` +
        'the tail past the last periodic flush may be missing',
    )
  }
  const res = await fetch(transcript.download_url)
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        `transcript for ${transcript.process_id} is gone from storage — ` +
          'it was likely deleted by your log retention setting',
      )
    }
    throw new Error(
      `download failed: ${res.status} ${res.statusText}` +
        (res.status === 403
          ? ' (the presigned URL likely expired — re-run the command for a fresh one)'
          : ''),
    )
  }
  const raw = Buffer.from(await res.arrayBuffer())
  return opts.gzip ? raw : gunzipSync(raw)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Local wall-clock HH:MM:SS for the --watch transition log.
function nowClock(): string {
  return new Date().toTimeString().slice(0, 8)
}

// ---------------------------------------------------------------------------
// `agent session sync` implementation.
// ---------------------------------------------------------------------------

// The JSON context Claude Code writes to a hook's stdin. Fields beyond these
// exist per event; we only need the session identity + transcript location.
interface HookStdin {
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
  reason?: string
}

async function readHookStdin(): Promise<HookStdin | undefined> {
  if (process.stdin.isTTY) return undefined
  let data = ''
  for await (const chunk of process.stdin) data += chunk
  data = data.trim()
  if (!data) return undefined
  try {
    return JSON.parse(data) as HookStdin
  } catch {
    return undefined
  }
}

// A fetch() network failure (DNS, refused, offline) — retriable, so spool.
// ApiError >= 500 is treated the same; 4xx is permanent and never spooled.
function isRetriable(err: unknown): boolean {
  if (err instanceof ApiError) return err.status >= 500
  // Anything that never produced an HTTP response (DNS, refused, offline).
  return true
}

async function syncTranscript(opts: {
  transcript?: string
  sessionId?: string
  reason?: string
  cwd?: string
  json?: boolean
}): Promise<void> {
  const hook = await readHookStdin()
  // Hook mode = driven by CC (stdin context, no explicit flags): all failure
  // paths are silent no-ops so they never surface into the session.
  const hookMode = hook !== undefined && !opts.transcript && !opts.sessionId

  const ccSessionId = opts.sessionId ?? hook?.session_id
  const transcriptPath = opts.transcript ?? hook?.transcript_path
  const cwd = opts.cwd ?? hook?.cwd ?? process.cwd()
  const reason: 'stop' | 'session_end' =
    opts.reason === 'session_end' || opts.reason === 'stop'
      ? opts.reason
      : hook?.hook_event_name === 'SessionEnd'
        ? 'session_end'
        : 'stop'
  const repo = repoFromCwd(cwd)

  // Hook mode is quiet on every failure path, so the local activity log
  // (hooks/sync.log.jsonl + stats.json, surfaced by `agent hooks logs/stats`)
  // is the only place a failed background sync is observable. Recording is
  // best-effort and never throws, preserving the exit-0 guarantee.
  const quit = (outcome: SyncOutcome, message: string): void => {
    recordSyncOutcome({ outcome, cc_session_id: ccSessionId, repo, reason, error: message })
    if (!hookMode) throw new Error(message)
  }

  if (!ccSessionId || !transcriptPath) {
    return quit('rejected', 'need --session-id and --transcript (or hook JSON on stdin)')
  }

  // Consent gate: per-repo opt-in, silently skipped otherwise.
  if (!repo || !enrolledRepos().includes(repo.toLowerCase())) {
    return quit(
      'skipped_unenrolled',
      `repository ${repo ?? `at ${cwd}`} is not enrolled (agent hooks enroll)`,
    )
  }
  if (!resolveToken()) {
    return quit('not_logged_in', 'not logged in. Run `agent login` first, or set ELLIPSIS_API_TOKEN.')
  }
  if (!existsSync(transcriptPath)) {
    return quit('no_transcript', `transcript not found: ${transcriptPath}`)
  }

  // Redact line-by-line (secrets never leave the laptop unredacted), then
  // gzip + base64 for the JSON body.
  const lines = readFileSync(transcriptPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map(redactLine)
  if (lines.length === 0) {
    return quit('no_transcript', `transcript is empty: ${transcriptPath}`)
  }

  const req: SyncAgentSessionRequest = {
    cc_session_id: ccSessionId,
    transcript_gzip_b64: gzipSync(lines.join('\n') + '\n').toString('base64'),
    reason,
    repo,
    cwd,
    git_branch: branchFromCwd(cwd),
  }

  const api = new ApiClient()
  try {
    const res = await api.syncAgentSession(req)
    recordSyncOutcome({
      outcome: 'synced',
      cc_session_id: ccSessionId,
      repo,
      reason,
      session_id: res.session_id,
      event_count: res.event_count,
    })
    if (opts.json) printJson(res)
    else if (!hookMode) {
      console.log(
        `✓ synced ${res.event_count} events to session ${res.session_id}` +
          (res.accepted ? '' : ' (server already had a newer snapshot)'),
      )
    }
  } catch (err) {
    if (isRetriable(err)) {
      // Spool (latest snapshot per session wins) and stay quiet in hook mode —
      // the next sync flushes it.
      spoolSync(req)
      quit('spooled', (err as Error).message)
      return
    }
    // Permanent rejection (auth, validation, payload too large): never spool.
    quit('rejected', (err as Error).message)
    return
  }

  // The API is reachable — flush anything an earlier offline sync spooled.
  for (const { file, req: spooled } of listSpooledSyncs()) {
    if (spooled.cc_session_id === ccSessionId) {
      // The snapshot we just synced supersedes it (snapshots only grow).
      dropSpooledSync(file)
      continue
    }
    try {
      await api.syncAgentSession(spooled)
      dropSpooledSync(file)
    } catch (err) {
      if (isRetriable(err)) break // server unhealthy again; retry next time
      dropSpooledSync(file) // permanent rejection: retrying can't succeed
    }
  }
}
