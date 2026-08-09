import { type Command } from 'commander'
import { ApiClient } from '../lib/api'
import { alsoKnownAs, apiRoutes } from '../lib/help'
import { printJson, printTable, runAction } from '../lib/output'

export function registerSentry(program: Command): void {
  const sentry = program
    .command('sentry')
    .description('Browse the connected Sentry organizations')

  apiRoutes(
    alsoKnownAs(
      sentry.command('orgs').description('List the connected Sentry organizations'),
      'org',
      'organizations',
    ),
    'GET /sentry/organizations',
  )
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const res = await new ApiClient().listSentryOrganizations()
        if (opts.json) {
          printJson(res)
          return
        }
        // The organization is the connection, so an empty list simply means
        // Sentry is not connected (the endpoint never 404s).
        if (res.organizations.length === 0) {
          console.log('No Sentry organizations connected.')
          return
        }
        printTable(
          ['ORG', 'INTEGRATION ID'],
          res.organizations.map((o) => [o.organization_slug, o.integration_id]),
        )
      })
    })
}
