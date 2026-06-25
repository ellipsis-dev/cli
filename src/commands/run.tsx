import type { Command } from 'commander'
import React from 'react'
import { render } from 'ink'
import { RunView } from '../ui/RunView'
import { requireToken } from '../lib/config'

export function registerRun(program: Command): void {
  const run = program.command('run').description('Start and inspect agent runs')

  run
    .command('start')
    .description('Start a new agent run')
    .argument('[prompt...]', 'the prompt to send to the agent')
    .action(async (prompt: string[]) => {
      // TODO: POST /v1/runs, then attach to the stream just like `run view`.
      console.log(`[stub] starting run with prompt: ${prompt.join(' ') || '(none)'}`)
    })

  run
    .command('view')
    .description('Attach to a run and stream its output (defaults to the latest run)')
    .argument('[runId]', 'run id; defaults to the most recent run')
    .action((runId?: string) => {
      const token = requireToken()
      render(<RunView runId={runId ?? 'latest'} token={token} />)
    })

  run
    .command('stop <runId>')
    .description('Stop an in-flight run')
    .action((runId: string) => {
      console.log(`[stub] stopping run ${runId}`)
    })

  run
    .command('list')
    .description('List recent runs')
    .action(() => {
      console.log('[stub] list runs')
    })
}
