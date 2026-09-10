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
          'List the models an automation can select (the account default is marked)',
        ),
      'ls',
    ),
    'GET /v1/account/models',
  )
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const { models } = await api().account.models.list()
        if (opts.json) {
          printJson(models)
          return
        }
        if (models.length === 0) {
          console.log('No models found.')
          return
        }
        printTable(
          ['ID', 'NAME', 'HARNESS', 'DEFAULT'],
          models.map((m) => [m.id, m.display_name, m.harness, m.is_default_agent_model ? 'yes' : '']),
        )
        console.log('\nSet `session.harness.type` and `session.harness.model` in your automation YAML, or use `agent session start --harness <type> --model <id>`.')
      })
    })
}
