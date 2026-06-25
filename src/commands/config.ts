import type { Command } from 'commander'
import { ApiClient } from '../lib/api'
import { printJson, runAction } from '../lib/output'

export function registerConfig(program: Command): void {
  const config = program.command('config').description('Inspect saved agent configurations')

  config
    .command('list')
    .description('List saved agent configurations (GET /v1/agents/configs)')
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const configs = await new ApiClient().listAgentConfigs()
        if (opts.json) {
          printJson(configs)
          return
        }
        if (configs.length === 0) {
          console.log('No configs found.')
          return
        }
        for (const c of configs) {
          const flags = [c.deleted ? 'deleted' : null, c.last_sync_error ? 'sync-error' : null]
            .filter(Boolean)
            .join(',')
          console.log(`${c.id}  ${c.updated_at}${flags ? `  [${flags}]` : ''}`)
        }
      })
    })

  config
    .command('get <configId>')
    .description('Get a single agent configuration (GET /v1/agents/configs/{id})')
    .option('--json', 'output raw JSON')
    .action(async (configId: string, opts: { json?: boolean }) => {
      await runAction(async () => {
        const c = await new ApiClient().getAgentConfig(configId)
        if (opts.json) {
          printJson(c)
          return
        }
        console.log(`id:        ${c.id}`)
        console.log(`created:   ${c.created_at}`)
        console.log(`updated:   ${c.updated_at}`)
        if (c.last_synced_commit_sha) console.log(`synced:    ${c.last_synced_commit_sha}`)
        if (c.last_sync_error) console.log(`sync error: ${c.last_sync_error}`)
        console.log('config:')
        printJson(c.agent_config)
      })
    })

  // Note: agent configs are sourced from YAML in GitHub, not created/deployed
  // through the API (see documents/eng/ELLIPSIS_API_AND_CLI.md). There is no
  // /v1 create/deploy endpoint; edit the config file in your repo instead.
}
