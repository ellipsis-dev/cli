import { type Command } from 'commander'
import { ApiClient } from '../lib/api'
import { printJson, printTable, runAction } from '../lib/output'

export function registerModel(program: Command): void {
  const model = program
    .command('model')
    // Resource sub-groups register their plural as an alias so the two
    // spellings can never diverge into different surfaces.
    .alias('models')
    .description('Browse the models your agent can run on')

  model
    .command('list')
    .alias('ls')
    .description('List selectable agent models (GET /v1/models)')
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const models = await new ApiClient().listSupportedModels()
        if (opts.json) {
          printJson(models)
          return
        }
        if (models.length === 0) {
          console.log('No models found.')
          return
        }
        printTable(
          ['ID', 'NAME', 'DEFAULT'],
          models.map((m) => [m.id, m.display_name, m.is_default_agent_model ? 'yes' : '']),
        )
        console.log('\nSelect one by setting `model:` under `claude:` in your agent config YAML.')
      })
    })
}
