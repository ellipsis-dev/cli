import { type Command } from 'commander'
import { ApiClient, requireConnected } from '../lib/api'
import { printJson, printTable, runAction } from '../lib/output'

export function registerLinear(program: Command): void {
  const linear = program
    .command('linear')
    .description('Browse the connected Linear organization')

  linear
    .command('teams')
    .description('List teams in the connected Linear organization (GET /v1/linear/teams)')
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const res = await requireConnected('Linear', new ApiClient().listLinearTeams())
        if (opts.json) {
          printJson(res)
          return
        }
        if (res.teams.length === 0) {
          console.log('No teams found.')
          return
        }
        // ENABLED is whether Ellipsis is enabled for the team.
        printTable(
          ['ID', 'NAME', 'KEY', 'ENABLED'],
          res.teams.map((t) => [t.id, t.name, t.key ?? '', t.is_enabled ? 'yes' : 'no']),
        )
      })
    })
}
