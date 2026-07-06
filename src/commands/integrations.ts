import { type Command } from 'commander'
import { ApiClient } from '../lib/api'
import { printJson, printTable, runAction } from '../lib/output'
import type { GetIntegrationsResponse } from '../lib/types'

export function registerIntegrations(program: Command): void {
  program
    .command('integrations')
    .description('Show every connected integration (GET /v1/integrations)')
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const integrations = await new ApiClient().getIntegrations()
        if (opts.json) {
          printJson(integrations)
          return
        }
        printTable(['INTEGRATION', 'STATUS', 'DETAILS'], integrationRows(integrations))
        console.log(
          '\nList resources: agent github repos | agent slack channels | agent linear teams | agent sentry orgs',
        )
      })
    })
}

// One table row per integration, connected or not, so the output always shows
// the full universe of integrations. Exported for tests.
export function integrationRows(res: GetIntegrationsResponse): string[][] {
  const row = (name: string, details: string | null): string[] =>
    details === null ? [name, 'not connected', ''] : [name, 'connected', details]

  const github = res.github
    ? [
        `${res.github.account_login} (${res.github.account_type})`,
        `${res.github.repository_count} ${res.github.repository_count === 1 ? 'repo' : 'repos'}`,
        res.github.repository_selection === 'all' ? 'all repositories' : 'selected repositories',
        ...(res.github.suspended ? ['suspended'] : []),
      ].join(', ')
    : null

  const linear = res.linear
    ? `${res.linear.teams.length} ${res.linear.teams.length === 1 ? 'team' : 'teams'}, ` +
      `${res.linear.teams.filter((t) => t.is_enabled).length} enabled`
    : null

  // The organization is the connection for Sentry, so an empty list (never a
  // null) means not connected.
  const sentry = res.sentry.length
    ? res.sentry.map((o) => o.organization_slug).join(', ')
    : null

  return [
    row('github', github),
    row('slack', res.slack ? `${res.slack.team_name} (${res.slack.team_id})` : null),
    row('linear', linear),
    row('jira', res.jira ? `cloud ${res.jira.cloud_id}` : null),
    row('sentry', sentry),
  ]
}
