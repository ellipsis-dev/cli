import { type Command } from 'commander'
import { api } from '../lib/api'
import { alsoKnownAs, apiRoutes } from '../lib/help'
import { printJson, printTable, runAction } from '../lib/output'

export function registerModel(program: Command): void {
  const model = alsoKnownAs(
    program.command('model').description('Browse the models an agent can run on'),
    'models',
  )

  apiRoutes(
    alsoKnownAs(
      model
        .command('list')
        .description(
          'List the models an agent config can select (the account default is marked)',
        ),
      'ls',
    ),
    'GET /models',
  )
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const { models } = await api().models.list()
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
