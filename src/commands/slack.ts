import { type Command } from 'commander'
import { api, requireConnected } from '../lib/api'
import { alsoKnownAs, apiRoutes } from '../lib/help'
import { printJson, printTable, runAction } from '../lib/output'

export function registerSlack(program: Command): void {
  const slack = program
    .command('slack')
    .description('Browse the connected Slack workspace')

  apiRoutes(
    alsoKnownAs(
      slack.command('channels').description('List the channels in the Slack workspace'),
      'channel',
    ),
    'GET /v1/integrations/slack/channels',
  )
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const res = await requireConnected('Slack', api().integrations.slack.channels())
        if (opts.json) {
          printJson(res)
          return
        }
        if (res.channels.length === 0) {
          console.log(`No channels found in ${res.team_name}.`)
          return
        }
        printTable(
          ['ID', 'NAME', 'PRIVATE', 'MEMBER'],
          res.channels.map((c) => [
            c.id,
            c.name ?? '',
            c.is_private ? 'yes' : 'no',
            c.is_member ? 'yes' : 'no',
          ]),
        )
      })
    })

  apiRoutes(
    alsoKnownAs(
      slack
        .command('members')
        .description('List the workspace members, with linked GitHub identities'),
      'member',
    ),
    'GET /v1/integrations/slack/members',
  )
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const res = await requireConnected('Slack', api().integrations.slack.members())
        if (opts.json) {
          printJson(res)
          return
        }
        if (res.members.length === 0) {
          console.log(`No members found in ${res.team_name}.`)
          return
        }
        // GITHUB shows the linked login when a Slack<->GitHub link row exists,
        // so a Slack mention maps to the same person's sessions.
        printTable(
          ['ID', 'NAME', 'DISPLAY', 'EMAIL', 'GITHUB'],
          res.members.map((m) => [
            m.id,
            m.real_name ?? m.name ?? '',
            m.display_name ?? '',
            m.email ?? '',
            m.github?.login ?? (m.github ? String(m.github.id) : ''),
          ]),
        )
      })
    })
}
