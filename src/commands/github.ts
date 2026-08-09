import { type Command } from 'commander'
import { ApiClient } from '../lib/api'
import { alsoKnownAs, apiRoutes } from '../lib/help'
import { printJson, printTable, runAction } from '../lib/output'

// Read-only browsers of a connected integration, so each resource is one bare
// plural command (`github repos`) rather than a `<noun> list` pair: there is no
// get/create/delete to disambiguate it from.
export function registerGithub(program: Command): void {
  const github = program
    .command('github')
    .description('Browse the connected GitHub installation')

  apiRoutes(
    alsoKnownAs(
      github
        .command('repos')
        .description('List the repositories the GitHub installation can reach'),
      'repo',
    ),
    'GET /github/repos',
  )
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const res = await new ApiClient().listGithubRepositories()
        if (opts.json) {
          printJson(res)
          return
        }
        if (res.repositories.length === 0) {
          console.log('No repositories connected.')
          return
        }
        printTable(
          ['REPO', 'PRIVATE', 'DEFAULT BRANCH', 'DESCRIPTION'],
          res.repositories.map((r) => [
            r.full_name,
            r.private ? 'yes' : 'no',
            r.default_branch ?? '',
            r.description ?? '',
          ]),
        )
      })
    })

  apiRoutes(
    alsoKnownAs(
      github
        .command('members')
        .description(
          'List the org roster: the logins --author accepts, plus linked Slack identities',
        ),
      'member',
    ),
    'GET /github/members',
  )
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const res = await new ApiClient().listGithubMembers()
        if (opts.json) {
          printJson(res)
          return
        }
        if (res.members.length === 0) {
          console.log('No members found.')
          return
        }
        // SLACK shows the linked slack_user_id when a Slack<->GitHub link row
        // exists for the member, so `agent slack members` can go the other way.
        printTable(
          ['LOGIN', 'NAME', 'ROLE', 'SLACK'],
          res.members.map((m) => [
            m.login ?? String(m.id),
            m.name ?? '',
            m.role ?? '',
            m.slack?.slack_user_id ?? '',
          ]),
        )
      })
    })
}
