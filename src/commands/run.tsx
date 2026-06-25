import type { Command } from 'commander'
import { readFileSync } from 'node:fs'
import React from 'react'
import { render } from 'ink'
import { RunView } from '../ui/RunView'
import { requireToken } from '../lib/config'
import { ApiClient } from '../lib/api'
import { printJson, runAction } from '../lib/output'
import { collect, collectKeyValue, toInt } from '../lib/args'
import type { AgentRun, AgentRunSource, StartAgentRunRequest } from '../lib/types'

export function registerRun(program: Command): void {
  const run = program.command('run').description('Start and inspect agent runs')

  run
    .command('start')
    .description('Start a new agent run (POST /v1/agents/runs)')
    .option('-c, --config <id>', 'start from a saved agent config id')
    .option('-f, --config-file <path>', 'start from an inline agent config (JSON file)')
    .option('-b, --budget <usd>', 'per-run budget override in USD', parseFloat)
    .option(
      '-m, --metadata <key=value>',
      'attach metadata (repeatable)',
      collectKeyValue,
      {} as Record<string, string>,
    )
    .option('-s, --source <source>', 'run source', 'cli')
    .option('--json', 'output raw JSON')
    .action(
      async (opts: {
        config?: string
        configFile?: string
        budget?: number
        metadata: Record<string, string>
        source: string
        json?: boolean
      }) => {
        await runAction(async () => {
          if (!opts.config && !opts.configFile) {
            throw new Error('provide --config <id> or --config-file <path>')
          }
          if (opts.config && opts.configFile) {
            throw new Error('provide only one of --config / --config-file')
          }
          const req: StartAgentRunRequest = {
            source: opts.source as AgentRunSource,
            metadata: opts.metadata,
          }
          if (opts.config) req.config_id = opts.config
          if (opts.configFile) req.config = readJsonFile(opts.configFile)
          if (opts.budget !== undefined) req.budget_usd = opts.budget

          const run = await new ApiClient().startAgentRun(req)
          if (opts.json) {
            printJson(run)
            return
          }
          console.log(`✓ started run ${run.id} (${run.status})`)
          console.log(`  attach with: agent run view ${run.id}`)
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
          for (const r of runs) {
            console.log(`${r.id}  ${r.status.padEnd(16)} ${r.created_at}`)
          }
        })
      },
    )

  run
    .command('get <runId>')
    .description('Get a single agent run (GET /v1/agents/runs/{id})')
    .option('--json', 'output raw JSON')
    .action(async (runId: string, opts: { json?: boolean }) => {
      await runAction(async () => {
        const r = await new ApiClient().getAgentRun(runId)
        if (opts.json) {
          printJson(r)
          return
        }
        printRunSummary(r)
      })
    })

  run
    .command('view')
    .description('Attach to a run and stream its output (defaults to the latest run)')
    .argument('[runId]', 'run id; defaults to the most recent run')
    .action((runId?: string) => {
      // Streaming is a separate WebSocket surface, not part of /v1 (deferred in
      // documents/eng/ELLIPSIS_API_AND_CLI.md §7). The server-side frame
      // protocol is still stubbed.
      const token = requireToken()
      render(<RunView runId={runId ?? 'latest'} token={token} />)
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

function printRunSummary(r: AgentRun): void {
  console.log(`id:        ${r.id}`)
  console.log(`status:    ${r.status}${r.status_reason ? ` (${r.status_reason})` : ''}`)
  if (r.source) console.log(`source:    ${r.source}`)
  if (r.agent_config_id) console.log(`config:    ${r.agent_config_id}`)
  console.log(`created:   ${r.created_at}`)
  console.log(`updated:   ${r.updated_at}`)
  console.log(`tokens:    ${r.tokens_total.toLocaleString()}`)
  const keys = Object.keys(r.metadata ?? {})
  if (keys.length) {
    console.log('metadata:')
    for (const k of keys) console.log(`  ${k}=${r.metadata[k]}`)
  }
}

function readJsonFile(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch (err) {
    throw new Error(`could not read config file ${path}: ${(err as Error).message}`)
  }
}
