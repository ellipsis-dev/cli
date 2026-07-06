import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, requireConnected } from '../src/lib/api'
import { integrationRows } from '../src/commands/integrations'
import type { GetIntegrationsResponse } from '../src/lib/types'

describe('integration discovery endpoints', () => {
  afterEach(() => vi.unstubAllGlobals())

  const stub = (body: unknown): ReturnType<typeof vi.fn> => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('hits the provider-namespaced paths', async () => {
    const cases: Array<[(api: ApiClient) => Promise<unknown>, string, unknown]> = [
      [(api) => api.getIntegrations(), '/v1/integrations', { sentry: [] }],
      [(api) => api.listGithubRepositories(), '/v1/github/repos', { repositories: [] }],
      [(api) => api.listGithubMembers(), '/v1/github/members', { members: [] }],
      [(api) => api.listSlackChannels(), '/v1/slack/channels', { channels: [] }],
      [(api) => api.listSlackMembers(), '/v1/slack/members', { members: [] }],
      [(api) => api.listLinearTeams(), '/v1/linear/teams', { teams: [] }],
      [(api) => api.listSentryOrganizations(), '/v1/sentry/organizations', { organizations: [] }],
    ]
    for (const [call, path, body] of cases) {
      const fetchMock = stub(body)
      await call(new ApiClient('http://api.test', 't'))
      expect(fetchMock.mock.calls[0][0]).toBe(`http://api.test${path}`)
      vi.unstubAllGlobals()
    }
  })
})

describe('requireConnected', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('maps a 404 to a friendly not-connected error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: 'Slack is not connected for this account.' }), {
            status: 404,
          }),
      ),
    )
    const api = new ApiClient('http://api.test', 't')
    await expect(requireConnected('Slack', api.listSlackChannels())).rejects.toThrow(
      /^Slack is not connected/,
    )
  })

  it('propagates other failures unchanged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ detail: 'nope' }), { status: 403 })),
    )
    const api = new ApiClient('http://api.test', 't')
    await expect(requireConnected('Slack', api.listSlackChannels())).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
    })
  })

  it('returns the payload when connected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ team_id: 'T1', team_name: 'acme', channels: [] }), {
            status: 200,
          }),
      ),
    )
    const api = new ApiClient('http://api.test', 't')
    await expect(requireConnected('Slack', api.listSlackChannels())).resolves.toMatchObject({
      team_id: 'T1',
    })
  })
})

describe('integrationRows', () => {
  const connected: GetIntegrationsResponse = {
    github: {
      account_login: 'acme',
      account_type: 'organization',
      repository_selection: 'all',
      suspended: false,
      repository_count: 12,
    },
    slack: { team_id: 'T042', team_name: 'acme-hq', operations_channel_id: null },
    linear: {
      organization_id: 'org_1',
      teams: [
        { id: 'team_1', name: 'Eng', key: 'ENG', is_enabled: true },
        { id: 'team_2', name: 'Design', key: 'DES', is_enabled: false },
      ],
    },
    jira: { cloud_id: 'cloud_9' },
    sentry: [
      { integration_id: 'int_1', organization_slug: 'acme-corp' },
      { integration_id: 'int_2', organization_slug: 'acme-labs' },
    ],
  }

  it('renders every integration as connected with details', () => {
    expect(integrationRows(connected)).toEqual([
      ['github', 'connected', 'acme (organization), 12 repos, all repositories'],
      ['slack', 'connected', 'acme-hq (T042)'],
      ['linear', 'connected', '2 teams, 1 enabled'],
      ['jira', 'connected', 'cloud cloud_9'],
      ['sentry', 'connected', 'acme-corp, acme-labs'],
    ])
  })

  it('renders null (and empty sentry) as not connected', () => {
    const none: GetIntegrationsResponse = {
      github: null,
      slack: null,
      linear: null,
      jira: null,
      sentry: [],
    }
    for (const [name, status, details] of integrationRows(none)) {
      expect(status).toBe('not connected')
      expect(details).toBe('')
      expect(name).toBeTruthy()
    }
  })

  it('flags a suspended installation and selected repos', () => {
    const rows = integrationRows({
      ...connected,
      github: {
        ...connected.github!,
        repository_selection: 'selected',
        suspended: true,
        repository_count: 1,
      },
    })
    expect(rows[0][2]).toBe('acme (organization), 1 repo, selected repositories, suspended')
  })
})
