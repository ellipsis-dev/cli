import type { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { ApiClient } from '../lib/api'
import { requireToken, resolveApiBase, resolveAppBase } from '../lib/config'
import { formatTs, printJson, printTable, runAction, usdFromMillicents } from '../lib/output'
import { collect, collectKeyValue, toInt } from '../lib/args'
import { runUrl } from '../lib/urls'
import {
  resolveWsBase,
  streamRun,
  StreamUnavailableError,
  type StreamFrame,
  type StreamOutcome,
} from '../lib/ws'
import type {
  AgentRun,
  AgentRunSource,
  AgentRunStatus,
  StartAgentRunRequest,
} from '../lib/types'

// Statuses past which a run no longer changes — `--watch` stops here.
const TERMINAL_STATUSES: ReadonlySet<AgentRunStatus> = new Set<AgentRunStatus>([
  'completed',
  'error',
  'cancelled',
  'stopped',
])

export function registerRun(program: Command): void {
  const run = program.command('run').description('Start and inspect agent runs')

  run
    .command('start')
    .description('Start a new agent run (POST /v1/agents/runs)')
    .option('-c, --config <id>', 'start from a saved agent config id')
    .option('-f, --config-file <path>', 'start from an inline agent config (JSON file)')
    .option(
      '-t, --template <slug>',
      'start from a maintained run template (e.g. welcome-to-ellipsis)',
    )
    .option('-b, --budget <usd>', 'per-run budget override in USD', parseFloat)
    .option(
      '-m, --metadata <key=value>',
      'attach metadata (repeatable)',
      collectKeyValue,
      {} as Record<string, string>,
    )
    .option('-s, --source <source>', 'run source', 'cli')
    .option('-w, --watch', 'stream the run live until it reaches a terminal status')
    .option('-i, --interval <seconds>', 'poll interval for the --watch fallback', toInt, 3)
    .option('--json', 'output raw JSON')
    .action(
      async (opts: {
        config?: string
        configFile?: string
        template?: string
        budget?: number
        metadata: Record<string, string>
        source: string
        watch?: boolean
        interval: number
        json?: boolean
      }) => {
        await runAction(async () => {
          // The server enforces "exactly one of config / config_id / template_id";
          // pre-check locally for a clearer error than a bare 400.
          const sources = [opts.config, opts.configFile, opts.template].filter(Boolean)
          if (sources.length === 0) {
            throw new Error('provide one of --config <id>, --config-file <path>, or --template <slug>')
          }
          if (sources.length > 1) {
            throw new Error('provide only one of --config / --config-file / --template')
          }
          const req: StartAgentRunRequest = {
            source: opts.source as AgentRunSource,
            metadata: opts.metadata,
          }
          if (opts.config) req.config_id = opts.config
          if (opts.configFile) req.config = readJsonFile(opts.configFile)
          if (opts.template) req.template_id = opts.template
          if (opts.budget !== undefined) req.budget_usd = opts.budget

          const api = new ApiClient()
          const run = await api.startAgentRun(req)

          if (opts.watch) {
            if (!opts.json) {
              console.log(`✓ started run ${run.id}`)
              await printRunUrl(api, run.id)
            }
            await watchRunStreaming(api, run.id, opts.interval, opts.json)
            return
          }

          if (opts.json) {
            printJson(run)
            return
          }
          console.log(`✓ started run ${run.id} (${run.status})`)
          await printRunUrl(api, run.id)
          console.log(`  follow with: agent run get ${run.id} --watch`)
        })
      },
    )

  run
    .command('list')
    .description('List recent agent runs (GET /v1/agents/runs)')
    .option('-c, --config-id <id>', 'filter by config id')
    .option('-s, --source <source>', 'filter by source (repeatable)', collect, [] as string[])
    .option('-d, --days <n>', 'look back N days', toInt)
    .option('--start <iso>', 'start of the time window (ISO 8601)')
    .option('--end <iso>', 'end of the time window (ISO 8601)')
    .option('-l, --limit <n>', 'max runs to return', toInt, 50)
    .option('--json', 'output raw JSON')
    .action(
      async (opts: {
        configId?: string
        source: string[]
        days?: number
        start?: string
        end?: string
        limit: number
        json?: boolean
      }) => {
        await runAction(async () => {
          const runs = await new ApiClient().listAgentRuns({
            config_id: opts.configId,
            source: opts.source.length ? (opts.source as AgentRunSource[]) : undefined,
            days: opts.days,
            start: opts.start,
            end: opts.end,
            limit: opts.limit,
          })
          if (opts.json) {
            printJson(runs)
            return
          }
          if (runs.length === 0) {
            console.log('No runs found.')
            return
          }
          printTable(
            ['ID', 'STATUS', 'SOURCE', 'CREATED', 'COST'],
            runs.map((r) => [
              r.id,
              r.status,
              r.source ?? '—',
              formatTs(r.created_at),
              usdFromMillicents(
                r.cost_tokens + r.cost_sandbox_cpu + r.cost_sandbox_memory + r.cost_fee,
              ),
            ]),
          )
        })
      },
    )

  run
    .command('get <runId>')
    .description('Get a single agent run (GET /v1/agents/runs/{id})')
    .option('-w, --watch', 'poll until the run reaches a terminal status')
    .option('-i, --interval <seconds>', 'poll interval for --watch', toInt, 3)
    .option('--json', 'output raw JSON')
    .action(async (runId: string, opts: { watch?: boolean; interval: number; json?: boolean }) => {
      await runAction(async () => {
        const api = new ApiClient()
        if (opts.watch) {
          if (!opts.json) await printRunUrl(api, runId)
          await watchRunStreaming(api, runId, opts.interval, opts.json)
          return
        }
        if (opts.json) {
          printJson(await api.getAgentRun(runId))
          return
        }
        // Fetch the run and the login (for the link) together — no added latency.
        const [r, me] = await Promise.all([api.getAgentRun(runId), api.whoami()])
        printRunSummary(r)
        console.log(`url:       ${runUrl(resolveAppBase(), me.customer_login, runId)}`)
      })
    })

  run
    .command('stop <runId>')
    .description('Stop an in-flight run')
    .action((runId: string) => {
      // No /v1 endpoint exists yet (deferred). Fail loudly rather than pretend.
      console.error(
        `stopping runs is not available in the /v1 API yet (run ${runId}). ` +
          'Stop it from the dashboard for now.',
      )
      process.exitCode = 1
    })
}

// `--watch` entry point: stream the run's output live over WebSocket, and fall
// back to REST status polling if streaming is unavailable (e.g. a backend
// without the endpoint). Identical UX either way — the same flag covers both.
export async function watchRunStreaming(
  api: ApiClient,
  runId: string,
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
    outcome = await streamRun({ token, runId, wsBase, onFrame })
  } catch (err) {
    if (err instanceof StreamUnavailableError) {
      if (!json) {
        console.error(
          `live stream unavailable (${err.message}); falling back to status polling`,
        )
      }
      await watchRun(api, runId, intervalSeconds, json)
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
    console.log(`\n${mark} run ${runId} ${outcome.status}`)
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

// Poll a run until it reaches a terminal status, printing each status
// transition. This is the status-level fallback used when live streaming isn't
// available: the /v1 REST API exposes run state, not the step-by-step stream.
export async function watchRun(
  api: ApiClient,
  runId: string,
  intervalSeconds: number,
  json?: boolean,
): Promise<void> {
  const intervalMs = Math.max(1, intervalSeconds) * 1000
  let last: AgentRunStatus | undefined
  for (;;) {
    const r = await api.getAgentRun(runId)
    if (r.status !== last) {
      if (!json) {
        const reason = r.status_reason ? ` — ${r.status_reason}` : ''
        console.log(`${nowClock()}  ${r.status}${reason}`)
      }
      last = r.status
    }
    if (TERMINAL_STATUSES.has(r.status)) {
      if (json) {
        printJson(r)
      } else {
        console.log('')
        printRunSummary(r)
      }
      return
    }
    await sleep(intervalMs)
  }
}

function printRunSummary(r: AgentRun): void {
  console.log(`id:        ${r.id}`)
  console.log(`status:    ${r.status}${r.status_reason ? ` (${r.status_reason})` : ''}`)
  if (r.source) console.log(`source:    ${r.source}`)
  if (r.agent_config_id) console.log(`config:    ${r.agent_config_id}`)
  console.log(`created:   ${r.created_at}`)
  console.log(`updated:   ${r.updated_at}`)
  console.log(`tokens:    ${r.tokens_total.toLocaleString()}`)
  console.log(
    `cost:      ${usdFromMillicents(
      r.cost_tokens + r.cost_sandbox_cpu + r.cost_sandbox_memory + r.cost_fee,
    )}`,
  )
  const keys = Object.keys(r.metadata ?? {})
  if (keys.length) {
    console.log('metadata:')
    for (const k of keys) console.log(`  ${k}=${r.metadata[k]}`)
  }
}

// Print a clickable dashboard link for a run. The route is scoped by account
// login, which isn't on the run object, so resolve it from /v1/me.
async function printRunUrl(api: ApiClient, runId: string): Promise<void> {
  const me = await api.whoami()
  console.log(`  ${runUrl(resolveAppBase(), me.customer_login, runId)}`)
}

function readJsonFile(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch (err) {
    throw new Error(`could not read config file ${path}: ${(err as Error).message}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Local wall-clock HH:MM:SS for the --watch transition log.
function nowClock(): string {
  return new Date().toTimeString().slice(0, 8)
}
