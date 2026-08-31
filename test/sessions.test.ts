import { describe, expect, it } from 'vitest'
import {
  applyComposerChoices,
  attentionFlip,
  builtInMcpServers,
  mcpServerEntry,
  validateMcpServer,
  COMPOSER_MODELS,
  composerModelOptions,
  composerPickerRows,
  connectability,
  environmentOptions,
  environmentPane,
  environmentSectionAt,
  environmentSectionRows,
  environmentSectionSummary,
  environmentSourceLabel,
  EMPTY_COMPUTE,
  EMPTY_HOOKS,
  EMPTY_IMAGE,
  EMPTY_PANE,
  computeOverride,
  fieldsOverride,
  filterSessions,
  mcpServerName,
  oneLine,
  paneEquals,
  paneWithRepository,
  parseRepo,
  resolveRepoFullName,
  startRequestFromConfig,
  withRepository,
  scriptRowLines,
  parseVariableEntry,
  repositoryRefLabel,
  variableRowLabel,
  modelRate,
  rateDollars,
  isActiveStatusWord,
  lastEventAt,
  navSlice,
  rowDescription,
  rowGlyph,
  rowMeta,
  rowStatusWord,
  SESSION_BAR_FETCH,
  sessionBarQuery,
  shortAge,
  sidebarSlice,
  sortSidebarSessions,
  statusBand,
  mergeSidebarSessions,
} from '../src/lib/sessions'
import { theme } from '../src/lib/theme'
import type { AgentConfig, AgentSession, SupportedModel } from '../src/lib/types'

// The session fixtures only read the config's name, so the rest is a stub.
const BARE_CONFIG = { ellipsis: { name: null } } as unknown as AgentConfig

function session(overrides: Partial<AgentSession>): AgentSession {
  return {
    id: 'session_1',
    created_at: '2026-07-07T00:00:00Z',
    updated_at: '2026-07-07T00:00:00Z',
    status: 'running',
    status_reason: null,
    agent: { config: BARE_CONFIG, config_id: null, override: null, source: 'platform_default' },
    source: 'api',
    harness: 'claude_code',
    prompting: { enabled: true },
    budget: { cents: 0, source: 'system' },
    cost: { llm: 0, sandbox_cpu: 0, sandbox_memory: 0, fee: 0, total: 0 },
    tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0, model: '' },
    metadata: {},
    ...overrides,
  }
}

describe('connectability', () => {
  it('sends when the server says prompting is enabled', () => {
    expect(connectability(session({ prompting: { enabled: true } }))).toEqual({ canSend: true })
  })

  it('honors the server prompting projection', () => {
    // A Slack mention session is keyed and live, but its answers post back to
    // the Slack thread, so the server refuses direct messages and we open
    // watch-only instead of a composer whose first Enter would 409.
    const c = connectability(
      session({
        session_key: 'slack:D1:1.1',
        session_state: 'idle',
        prompting: {
          enabled: false,
          blocked_reason: 'mention_surface',
          detail: 'This conversation lives on Slack. Reply there to steer the agent.',
          surface_name: 'Slack',
        },
      }),
    )
    expect(c.canSend).toBe(false)
    // The server's own sentence is shown verbatim, so the reason names Slack.
    expect(c.reason).toContain('This conversation lives on Slack.')
    expect(c.reason).toMatch(/watch-only/)
  })
})

describe('rowStatusWord / rowGlyph', () => {
  it('prefers the surface projection over the raw status', () => {
    const s = session({
      status: 'running',
      surface: { session: 'alive', run: 'working', status: 'waiting' },
    })
    expect(rowStatusWord(s)).toBe('waiting')
  })

  it('falls back to the raw status without a surface', () => {
    expect(rowStatusWord(session({ status: 'completed' }))).toBe('completed')
  })

  it('is always a dot — status is told by color, the arrow means selection', () => {
    for (const word of ['working', 'waiting', 'sleeping', 'failed', 'stopped', 'completed']) {
      expect(rowGlyph(word).glyph).toBe('●')
    }
  })

  it('colors in-flight amber, waiting with the accent, sleeping dim', () => {
    expect(rowGlyph('working')).toEqual({ glyph: '●', color: theme.active, dim: false })
    expect(isActiveStatusWord('working')).toBe(true)
    expect(rowGlyph('waiting').color).toBe(theme.foreground)
    expect(rowGlyph('sleeping')).toEqual({ glyph: '●', dim: true })
  })

  it('colors failures with the error token and settles the rest as done', () => {
    expect(rowGlyph('failed').color).toBe(theme.error)
    expect(rowGlyph('error')).toEqual({ glyph: '●', color: theme.error, dim: false })
    expect(rowGlyph('stopped')).toEqual({ glyph: '●', color: theme.error, dim: true })
    expect(rowGlyph('completed').color).toBe(theme.success)
    expect(rowGlyph('closed').color).toBe(theme.success)
  })
})

describe('rowDescription', () => {
  it('prefers the live summary, collapsed to one line', () => {
    const s = session({
      summary: { description: 'fixing the\n  webhook tests', created_at: null },
      prompt: 'do a thing',
    })
    expect(rowDescription(s)).toBe('fixing the webhook tests')
  })

  it('falls back to the prompt, then the source', () => {
    expect(rowDescription(session({ prompt: 'fix the tests' }))).toBe('fix the tests')
    expect(rowDescription(session({ source: 'react' }))).toBe('react session')
    // Every session carries a source, so that is the floor.
    expect(rowDescription(session({}))).toBe('api session')
  })

  it('ignores whitespace-only summaries', () => {
    expect(
      rowDescription(session({ summary: { description: '  \n ', created_at: null }, prompt: 'p' })),
    ).toBe('p')
  })
})

describe('lastEventAt / shortAge', () => {
  it('prefers last_activity_at, then last_message_at, then updated_at', () => {
    expect(
      lastEventAt(
        session({ last_activity_at: 'A', last_message_at: 'B', updated_at: 'C' } as never),
      ),
    ).toBe('A')
    expect(lastEventAt(session({ last_message_at: 'B', updated_at: 'C' } as never))).toBe('B')
    expect(lastEventAt(session({ updated_at: 'C' }))).toBe('C')
  })

  it('renders compact ages and never goes negative', () => {
    const now = new Date('2026-07-23T12:00:00Z')
    expect(shortAge('2026-07-23T11:59:48Z', now)).toBe('12s ago')
    expect(shortAge('2026-07-23T11:58:00Z', now)).toBe('2m ago')
    expect(shortAge('2026-07-23T09:00:00Z', now)).toBe('3h ago')
    expect(shortAge('2026-07-18T12:00:00Z', now)).toBe('5d ago')
    expect(shortAge('2026-07-23T12:00:05Z', now)).toBe('0s ago')
  })
})

describe('rowMeta', () => {
  const now = new Date('2026-07-23T12:00:00Z')

  it('reads spend and age, never the token count', () => {
    const s = session({
      tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 84_200, model: '' },
      cost: { llm: 30_000, sandbox_cpu: 10_000, sandbox_memory: 2_000, fee: 0, total: 42_000 },
      updated_at: '2026-07-23T11:58:00Z',
    } as never)
    expect(rowMeta(s, now)).toBe('$0.42, 2m ago')
  })

  it('drops the spend a fresh session has none of', () => {
    const s = session({ updated_at: '2026-07-23T11:59:48Z' })
    expect(rowMeta(s, now)).toBe('12s ago')
  })
})

describe('filterSessions', () => {
  const budget = session({
    id: 'budget',
    summary: { description: 'Checking the monthly budget' },
    prompt: 'can you check my budget',
  })
  const greet = session({ id: 'greet', summary: null, prompt: 'Hey!' })
  const bare = session({ id: 'bare', summary: null, prompt: null })

  it('matches all on an empty or blank query', () => {
    expect(filterSessions([budget, greet], '')).toEqual([budget, greet])
    expect(filterSessions([budget, greet], '   ')).toEqual([budget, greet])
  })

  it('matches the summary and the prompt, case-insensitively', () => {
    expect(filterSessions([budget, greet, bare], 'MONTHLY').map((s) => s.id)).toEqual(['budget'])
    expect(filterSessions([budget, greet, bare], 'hey').map((s) => s.id)).toEqual(['greet'])
  })

  it('drops sessions with nothing to match', () => {
    expect(filterSessions([bare], 'anything')).toEqual([])
  })
})

describe('sessionBarQuery', () => {
  const bar = {
    days: 7,
    repo: 'cwd' as const,
    statuses: 'all' as const,
    sources: undefined,
  }
  const context = { authorId: 42, detectedRepo: 'acme/api' }

  it('scopes to the author, the cwd repo, and the age cutoff', () => {
    expect(sessionBarQuery(bar, context)).toEqual({
      author_id: 42,
      limit: SESSION_BAR_FETCH,
      days: 7,
      repo: 'acme/api',
    })
  })

  // Outside a repository, asking for repo "" would empty the bar; the whole
  // account is the useful answer instead.
  it('drops the repo filter when the cwd is not a repository', () => {
    expect(sessionBarQuery(bar, { authorId: 42, detectedRepo: null }).repo).toBeUndefined()
  })

  it('drops the repo filter under repo "any" even inside one', () => {
    expect(sessionBarQuery({ ...bar, repo: 'any' }, context).repo).toBeUndefined()
  })

  it('omits days entirely at 0, rather than asking for a zero-day window', () => {
    expect(sessionBarQuery({ ...bar, days: 0 }, context).days).toBeUndefined()
  })

  it('asks for unfinished sessions only when configured to', () => {
    expect(sessionBarQuery(bar, context).unfinished).toBeUndefined()
    expect(sessionBarQuery({ ...bar, statuses: 'unfinished' }, context).unfinished).toBe(true)
  })

  it('passes sources through and omits them when unset', () => {
    expect(sessionBarQuery(bar, context).source).toBeUndefined()
    expect(sessionBarQuery({ ...bar, sources: ['cli', 'manual'] }, context).source).toEqual([
      'cli',
      'manual',
    ])
  })

  // An API-key credential has no GitHub user behind it: list the account's.
  it('omits the author filter without one', () => {
    expect(
      sessionBarQuery(bar, { authorId: null, detectedRepo: 'acme/api' }).author_id,
    ).toBeUndefined()
  })

  it('fetches a page deep enough to band and scroll', () => {
    expect(sessionBarQuery(bar, context).limit).toBe(SESSION_BAR_FETCH)
  })
})

describe('statusBand / sortSidebarSessions', () => {
  // A row per band, deliberately born newest-first-is-wrong-order so a
  // recency sort can't accidentally pass.
  const waiting = session({
    id: 'waiting',
    created_at: '2026-07-20T00:00:00Z',
    surface: { session: 'alive', run: 'waiting', status: 'waiting' },
  })
  const working = session({
    id: 'working',
    created_at: '2026-07-21T00:00:00Z',
    surface: { session: 'alive', run: 'working', status: 'working' },
  })
  const sleeping = session({
    id: 'sleeping',
    created_at: '2026-07-22T00:00:00Z',
    surface: { session: 'sleeping', run: 'done', status: 'sleeping' },
  })
  const done = session({ id: 'done', created_at: '2026-07-23T00:00:00Z', status: 'completed' })
  const failed = session({ id: 'failed', created_at: '2026-07-24T00:00:00Z', status: 'error' })

  it('bands by status: live, parked, done, dead', () => {
    expect(sortSidebarSessions([failed, done, sleeping, waiting, working]).map((s) => s.id)).toEqual(
      ['working', 'waiting', 'sleeping', 'done', 'failed'],
    )
    expect(statusBand('completed')).toBe(statusBand('closed'))
  })

  it('bands waiting with in-flight, so a finished turn does not move the row', () => {
    // The same session either side of a turn boundary: same band, same
    // created_at, so it holds its slot instead of jumping on every response.
    expect(statusBand('waiting')).toBe(statusBand('working'))
    expect(statusBand('waiting')).toBe(statusBand('starting'))
    const mid = sortSidebarSessions([waiting, working, sleeping]).map((s) => s.id)
    const after = sortSidebarSessions([
      { ...waiting, surface: { session: 'alive', run: 'working', status: 'working' } },
      { ...working, surface: { session: 'alive', run: 'waiting', status: 'waiting' } },
      sleeping,
    ] as AgentSession[]).map((s) => s.id)
    expect(after).toEqual(mid)
  })

  it('orders within a band newest-born first, ignoring event recency', () => {
    const old = session({ id: 'old', created_at: '2026-07-20T00:00:00Z', status: 'running' })
    const fresh = session({ id: 'fresh', created_at: '2026-07-22T00:00:00Z', status: 'running' })
    // `old` just spoke; that must not lift it above the younger session.
    const chatty = { ...old, last_activity_at: '2026-07-23T00:00:00Z' } as AgentSession
    expect(sortSidebarSessions([chatty, fresh]).map((s) => s.id)).toEqual(['fresh', 'old'])
    expect(sortSidebarSessions([fresh, chatty]).map((s) => s.id)).toEqual(['fresh', 'old'])
  })
})

describe('mergeSidebarSessions', () => {
  it('keeps local sessions the poll has not returned yet', () => {
    const polled = session({ id: 'a', created_at: '2026-07-23T10:00:00Z' })
    const local = session({ id: 'b', created_at: '2026-07-23T11:00:00Z' })
    expect(mergeSidebarSessions([polled], [local]).map((s) => s.id)).toEqual(['b', 'a'])
  })

  it('emits one row when a session is in both lists, preferring the polled copy', () => {
    const polled = session({ id: 'a', status: 'completed', session_state: 'closed' })
    const local = session({ id: 'a', status: 'running' })
    const merged = mergeSidebarSessions([polled], [local])
    expect(merged.map((s) => s.id)).toEqual(['a'])
    expect(merged[0]?.status).toBe('completed')
  })
})

describe('attentionFlip', () => {
  it('flags active → waiting transitions', () => {
    expect(attentionFlip('working', 'waiting')).toBe(true)
    expect(attentionFlip('starting', 'idle')).toBe(true)
  })

  it('ignores first sightings, active continuations, and terminal flips', () => {
    expect(attentionFlip(undefined, 'waiting')).toBe(false)
    expect(attentionFlip('working', 'working')).toBe(false)
    expect(attentionFlip('waiting', 'waiting')).toBe(false)
    expect(attentionFlip('working', 'completed')).toBe(false)
  })
})

describe('sidebarSlice', () => {
  it('shows everything when it fits', () => {
    expect(sidebarSlice(3, 10, 0)).toEqual({ start: 0, end: 3 })
  })

  it('windows around the selection when it overflows', () => {
    expect(sidebarSlice(20, 6, 0)).toEqual({ start: 0, end: 6 })
    expect(sidebarSlice(20, 6, 10)).toEqual({ start: 7, end: 13 })
    expect(sidebarSlice(20, 6, 19)).toEqual({ start: 14, end: 20 })
  })
})

describe('navSlice', () => {
  it('shows everything when it fits', () => {
    expect(navSlice(3, 5, 0)).toEqual({ start: 0, end: 3 })
  })

  it('holds still until the highlight reaches the second-to-last row', () => {
    expect(navSlice(10, 5, 0)).toEqual({ start: 0, end: 5 })
    expect(navSlice(10, 5, 3)).toEqual({ start: 0, end: 5 })
  })

  it('scrolls with the highlight parked on the second-to-last row', () => {
    expect(navSlice(10, 5, 4)).toEqual({ start: 1, end: 6 })
    expect(navSlice(10, 5, 5)).toEqual({ start: 2, end: 7 })
    expect(navSlice(10, 5, 7)).toEqual({ start: 4, end: 9 })
  })

  it('lets the last row hold the highlight at the end of the list', () => {
    expect(navSlice(10, 5, 8)).toEqual({ start: 5, end: 10 })
    expect(navSlice(10, 5, 9)).toEqual({ start: 5, end: 10 })
  })
})

function model(
  id: string,
  manufacturer: SupportedModel['manufacturer'],
  overrides: Partial<SupportedModel> = {},
): SupportedModel {
  return {
    id,
    display_name: id,
    manufacturer,
    is_default_agent_model: false,
    rate_card: {
      input_millicents_per_1m_tokens: 5_00_000,
      cache_write_5m_millicents_per_1m_tokens: 6_25_000,
      cache_write_1h_millicents_per_1m_tokens: 10_00_000,
      cache_read_millicents_per_1m_tokens: 50_000,
      output_millicents_per_1m_tokens: 25_00_000,
    },
    ...overrides,
  }
}

describe('rateDollars', () => {
  it('drops the cents on a whole dollar and keeps them otherwise', () => {
    expect(rateDollars(5_00_000)).toBe('$5')
    expect(rateDollars(75_000)).toBe('$0.75')
    expect(rateDollars(14_25_000)).toBe('$14.25')
    expect(rateDollars(0)).toBe('$0')
  })
})

describe('modelRate', () => {
  it('quotes the input and output lanes only', () => {
    expect(
      modelRate({
        input_millicents_per_1m_tokens: 3_00_000,
        cache_write_5m_millicents_per_1m_tokens: 3_75_000,
        cache_write_1h_millicents_per_1m_tokens: 6_00_000,
        cache_read_millicents_per_1m_tokens: 30_000,
        output_millicents_per_1m_tokens: 15_00_000,
      }),
    ).toEqual({ input: '$3', output: '$15' })
  })

  it('says nothing when the server sent no rate card', () => {
    expect(modelRate(undefined)).toBeNull()
    expect(modelRate(null)).toBeNull()
  })
})

describe('composerModelOptions', () => {
  it('gives the account default row the null id, in its own vendor group', () => {
    const options = composerModelOptions([
      model('claude-fable-5', 'anthropic'),
      model('claude-opus-5', 'anthropic', { is_default_agent_model: true }),
    ])
    expect(options.map((o) => [o.label, o.id, o.group])).toEqual([
      ['claude-fable-5', 'claude-fable-5', 'Anthropic'],
      ['claude-opus-5', null, 'Anthropic'],
    ])
  })

  it('groups by manufacturer, ranked, keeping the server order inside a group', () => {
    const options = composerModelOptions([
      model('gpt-5.6-sol', 'openai'),
      model('kimi-k3', 'moonshot'),
      model('claude-fable-5', 'anthropic', { is_default_agent_model: true }),
      model('gpt-5.6-luna', 'openai'),
      model('claude-sonnet-5', 'anthropic'),
    ])
    expect(options.map((o) => [o.group, o.label])).toEqual([
      ['Anthropic', 'claude-fable-5'],
      ['Anthropic', 'claude-sonnet-5'],
      ['OpenAI', 'gpt-5.6-sol'],
      ['OpenAI', 'gpt-5.6-luna'],
      ['Moonshot AI', 'kimi-k3'],
    ])
  })

  it('groups an unranked manufacturer last, under its raw name', () => {
    const options = composerModelOptions([
      model('some-new-model', 'nvidia' as SupportedModel['manufacturer']),
      model('claude-fable-5', 'anthropic'),
    ])
    expect(options.map((o) => o.group)).toEqual([null, 'Anthropic', 'nvidia'])
  })

  it('carries each row price as its two table cells', () => {
    const options = composerModelOptions([
      model('claude-opus-5', 'anthropic', { is_default_agent_model: true }),
      model('claude-haiku-4-5-20251001', 'anthropic', {
        rate_card: {
          input_millicents_per_1m_tokens: 1_00_000,
          cache_write_5m_millicents_per_1m_tokens: 1_25_000,
          cache_write_1h_millicents_per_1m_tokens: 2_00_000,
          cache_read_millicents_per_1m_tokens: 10_000,
          output_millicents_per_1m_tokens: 5_00_000,
        },
      }),
    ])
    expect(options[0].rate).toEqual({ input: '$5', output: '$25' })
    expect(options[1].rate).toEqual({ input: '$1', output: '$5' })
  })

  it('falls back to the built-in list when the server returns none', () => {
    expect(composerModelOptions([])).toEqual([...COMPOSER_MODELS])
  })

  it('quotes no price it cannot refresh in the built-in list', () => {
    expect(COMPOSER_MODELS.every((o) => !o.rate)).toBe(true)
  })

  it('heads the list with a bare Default row when no model claims the flag', () => {
    const options = composerModelOptions([model('claude-opus-5', 'anthropic')])
    expect(options[0]).toEqual({ id: null, label: 'Default', group: null })
    expect(options[1].label).toBe('claude-opus-5')
    expect(options[1].id).toBe('claude-opus-5')
  })
})

describe('composerPickerRows', () => {
  it('prints one heading per group, above the options it covers', () => {
    expect(
      composerPickerRows([
        { id: null, label: 'claude-opus-5', group: 'Agent default' },
        { id: 'claude-fable-5', label: 'claude-fable-5', group: 'Anthropic' },
        { id: 'claude-sonnet-5', label: 'claude-sonnet-5', group: 'Anthropic' },
        { id: 'gpt-5.6-sol', label: 'gpt-5.6-sol', group: 'OpenAI' },
      ]),
    ).toEqual([
      { kind: 'group', label: 'Agent default' },
      { kind: 'option', at: 0 },
      { kind: 'group', label: 'Anthropic' },
      { kind: 'option', at: 1 },
      { kind: 'option', at: 2 },
      { kind: 'group', label: 'OpenAI' },
      { kind: 'option', at: 3 },
    ])
  })

  it('heads a flat list with nothing at all', () => {
    expect(
      composerPickerRows([
        { id: null, label: 'Default' },
        { id: 'acme/api', label: 'acme/api' },
      ]),
    ).toEqual([
      { kind: 'option', at: 0 },
      { kind: 'option', at: 1 },
    ])
  })

  it('opens a group again when a later row returns to it', () => {
    expect(
      composerPickerRows([
        { id: 'a', label: 'a', group: 'Anthropic' },
        { id: 'b', label: 'b', group: 'OpenAI' },
        { id: 'c', label: 'c', group: 'Anthropic' },
      ]).filter((r) => r.kind === 'group'),
    ).toEqual([
      { kind: 'group', label: 'Anthropic' },
      { kind: 'group', label: 'OpenAI' },
      { kind: 'group', label: 'Anthropic' },
    ])
  })
})

describe('applyComposerChoices', () => {
  // Nothing picked: no agent, no environment name, a null pane — the base
  // request (and, with an agent, its config) is the whole message.
  const untouched = { agent: null, environment: null, model: null, pane: null }

  it('leaves the base request alone when nothing was picked', () => {
    const base = {
      prompt: 'hi',
      environment: { repositories: [{ owner: 'acme', name: 'api' }] },
    }
    expect(applyComposerChoices(base, untouched)).toEqual(base)
  })

  it('keeps the context repo and patches the model as a claude block', () => {
    const req = applyComposerChoices(
      { environment: { repositories: [{ owner: 'acme', name: 'api' }] } },
      { ...untouched, model: 'claude-opus-5' },
    )
    expect(req.claude).toEqual({ model: 'claude-opus-5' })
    expect(req.environment).toEqual({ repositories: [{ owner: 'acme', name: 'api' }] })
  })

  // A named environment ships as the string, which re-picks it wholesale: the
  // pane still matches it, so re-stating its lists could only say them worse.
  it('names a chosen environment on the request, over the pane', () => {
    const req = applyComposerChoices(
      { prompt: 'ship it' },
      {
        ...untouched,
        environment: 'env_1',
        pane: { ...EMPTY_PANE, variables: [{ name: 'A', value: '1' }] },
      },
    )
    expect(req).toEqual({ prompt: 'ship it', environment: 'env_1' })
  })

  it('carries an environment and a model through together', () => {
    const req = applyComposerChoices(
      { prompt: 'ship it' },
      { ...untouched, environment: 'env_1', model: 'claude-fable-5' },
    )
    expect(req).toEqual({
      prompt: 'ship it',
      environment: 'env_1',
      claude: { model: 'claude-fable-5' },
    })
  })

  it('starts from a picked agent config', () => {
    expect(applyComposerChoices({}, { ...untouched, agent: 'cfg_1' })).toEqual({
      from_config_id: 'cfg_1',
    })
  })

  // With an agent picked and the environment rows untouched, the config's own
  // environment rules: keeping the base request's detected-repo merge would
  // silently grow the config's checkout set.
  it('drops the base environment when an agent is picked and the rows are untouched', () => {
    const req = applyComposerChoices(
      { environment: { repositories: [{ owner: 'acme', name: 'api' }] } },
      { ...untouched, agent: 'cfg_1' },
    )
    expect(req).toEqual({ from_config_id: 'cfg_1' })
  })

  it('keeps a named environment (or the pane) alongside a picked agent', () => {
    expect(
      applyComposerChoices({}, { ...untouched, agent: 'cfg_1', environment: 'env_1' }),
    ).toEqual({ from_config_id: 'cfg_1', environment: 'env_1' })
    expect(
      applyComposerChoices({}, { ...untouched, agent: 'cfg_1', pane: EMPTY_PANE }).environment,
    ).toEqual({ repositories: [], variables: [], mcp_servers: [] })
  })

  it('does not mutate the request it was given', () => {
    const base = { prompt: 'hi' }
    applyComposerChoices(base, { ...untouched, environment: 'env_1' })
    expect(base).toEqual({ prompt: 'hi' })
  })

  // The whole point of the pane: without an environment name it IS the
  // sandbox, shipped as the request's own environment object.
  it('ships the whole pane when no environment is named', () => {
    const req = applyComposerChoices(
      {},
      {
        ...untouched,
        pane: {
          ...EMPTY_PANE,
          repositories: [{ fullName: 'acme/api', ref: 'main' }],
          variables: [{ name: 'NODE_ENV', value: 'production' }],
          mcpServers: [{ name: 'linear', command: null, url: null }],
        },
      },
    )
    expect(req).toEqual({
      environment: {
        repositories: [{ owner: 'acme', name: 'api', ref: 'main' }],
        variables: [{ name: 'NODE_ENV', value: 'production' }],
        mcp_servers: [{ name: 'linear' }],
      },
    })
  })

  // The [empty] pick is the pane emptied, and empty arrays are how "nothing"
  // is said over the bare ad-hoc base.
  it('clears every list for an empty pane', () => {
    const req = applyComposerChoices(
      { environment: { repositories: [{ owner: 'acme', name: 'api' }] } },
      { ...untouched, pane: EMPTY_PANE },
    )
    expect(req).toEqual({
      environment: { repositories: [], variables: [], mcp_servers: [] },
    })
  })

  it('omits the value of a variable that resolves from stored secrets', () => {
    const req = applyComposerChoices(
      {},
      { ...untouched, pane: { ...EMPTY_PANE, variables: [{ name: 'API_TOKEN', value: null }] } },
    )
    expect(req.environment).toMatchObject({ variables: [{ name: 'API_TOKEN' }] })
  })

  // Compute, image and hooks are scalars in a merging object, so only the set
  // fields ship — an unset one keeps whatever the server resolves.
  it('sends only the set compute fields', () => {
    const req = applyComposerChoices(
      {},
      { ...untouched, pane: { ...EMPTY_PANE, compute: { cpu: '4', memory: '16GB', timeout: '' } } },
    )
    expect(req.environment).toMatchObject({ compute: { cpu: 4, memory: '16GB' } })
  })

  it('sends only the set image fields', () => {
    const req = applyComposerChoices(
      {},
      { ...untouched, pane: { ...EMPTY_PANE, image: { dockerfile_append: '', setup: 'npm install' } } },
    )
    expect(req.environment).toMatchObject({ image: { setup: 'npm install' } })
  })

  it('sends only the set hook fields', () => {
    const req = applyComposerChoices(
      {},
      { ...untouched, pane: { ...EMPTY_PANE, hooks: { post_start: 'doppler setup', post_clone: '' } } },
    )
    expect(req.environment).toMatchObject({ hooks: { post_start: 'doppler setup' } })
  })

  // A server the pane was seeded with keeps its own entry, so a definition the
  // launcher's three fields can't hold survives a custom run.
  it('ships a seeded server verbatim, and builds the rest from their fields', () => {
    const seeded = { name: 'my-tools', command: 'npx', args: ['my-tools'], env: { A: '1' } }
    const req = applyComposerChoices(
      {},
      {
        ...untouched,
        pane: {
          ...EMPTY_PANE,
          mcpServers: [
            { name: 'my-tools', command: 'npx', url: null, raw: seeded },
            { name: 'docs', command: null, url: 'https://mcp.example.com' },
          ],
        },
      },
    )
    expect(req.environment).toMatchObject({
      mcp_servers: [seeded, { name: 'docs', url: 'https://mcp.example.com' }],
    })
  })
})

describe('environmentPane', () => {
  it('reads every field the pane shows off an environment config', () => {
    expect(
      environmentPane({
        repositories: [{ owner: 'acme', name: 'api', ref: 'main' }, { name: 'solo' }],
        variables: [{ name: 'A', value: '1' }, { name: 'B' }],
        mcp_servers: ['linear', { name: 'docs', url: 'https://x' }],
        compute: { cpu: 4, memory: '16GB' },
        image: { setup: 'npm ci' },
        hooks: { post_clone: 'make' },
      }),
    ).toEqual({
      repositories: [
        { fullName: 'acme/api', ref: 'main' },
        { fullName: 'solo', ref: null },
      ],
      variables: [
        { name: 'A', value: '1' },
        { name: 'B', value: null },
      ],
      mcpServers: [
        { name: 'linear', command: null, url: null, raw: 'linear' },
        { name: 'docs', command: null, url: 'https://x', raw: { name: 'docs', url: 'https://x' } },
      ],
      compute: { cpu: '4', memory: '16GB', timeout: '' },
      image: { dockerfile_append: '', setup: 'npm ci' },
      hooks: { post_start: '', post_clone: 'make' },
    })
  })

  it('is the empty pane for an environment that sets nothing, and for none at all', () => {
    expect(environmentPane({})).toEqual(EMPTY_PANE)
    expect(environmentPane(null)).toEqual(EMPTY_PANE)
  })

  // A script keeps its newlines here: the pane ships what it holds, and only its
  // row flattens (oneLine).
  it('keeps a multi-line script whole', () => {
    expect(environmentPane({ image: { setup: 'a\nb' } }).image.setup).toBe('a\nb')
  })
})

describe('resolveRepoFullName', () => {
  const connected = ['ellipsis-dev/ellipsis', 'ellipsis-dev/cli']

  // An environment YAML may write "name: ellipsis" with no owner, and that is the
  // same repository as the connected "ellipsis-dev/ellipsis" — one row, not two.
  it('resolves a bare name against the connected repositories', () => {
    expect(resolveRepoFullName('ellipsis', connected)).toBe('ellipsis-dev/ellipsis')
    expect(resolveRepoFullName('cli', connected)).toBe('ellipsis-dev/cli')
  })

  it('leaves an owner-qualified name and an unknown one alone', () => {
    expect(resolveRepoFullName('other-org/ellipsis', connected)).toBe('other-org/ellipsis')
    expect(resolveRepoFullName('mystery', connected)).toBe('mystery')
  })

  // Two owners with the same repo name would be a guess, so it stays as written.
  it('does not guess between two owners of the same name', () => {
    expect(resolveRepoFullName('api', ['acme/api', 'other/api'])).toBe('api')
  })
})

describe('environmentPane repository dedupe', () => {
  it('seeds an ownerless entry onto its connected row', () => {
    expect(
      environmentPane({ repositories: [{ name: 'ellipsis' }] }, ['ellipsis-dev/ellipsis'])
        .repositories,
    ).toEqual([{ fullName: 'ellipsis-dev/ellipsis', ref: null }])
  })
})

describe('scriptRowLines', () => {
  const script = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n')

  it('caps a long script and counts what it hid', () => {
    expect(scriptRowLines(script, false)).toEqual({
      lines: ['a', 'b', 'c', 'd', 'e'],
      hidden: 2,
    })
  })

  it('shows every line while the row is open', () => {
    expect(scriptRowLines(script, true).hidden).toBe(0)
    expect(scriptRowLines(script, true).lines).toHaveLength(7)
  })

  it('hides nothing from a short script', () => {
    expect(scriptRowLines('one\ntwo', false)).toEqual({ lines: ['one', 'two'], hidden: 0 })
  })
})

describe('paneEquals', () => {
  it('ignores the order a list was built in', () => {
    const a = {
      ...EMPTY_PANE,
      repositories: [{ fullName: 'acme/api', ref: null }, { fullName: 'acme/web', ref: null }],
    }
    const b = {
      ...EMPTY_PANE,
      repositories: [{ fullName: 'acme/web', ref: null }, { fullName: 'acme/api', ref: null }],
    }
    expect(paneEquals(a, b)).toBe(true)
  })

  it('sees a changed field, a dropped entry and an edited ref', () => {
    const base = { ...EMPTY_PANE, repositories: [{ fullName: 'acme/api', ref: null }] }
    expect(paneEquals(base, EMPTY_PANE)).toBe(false)
    expect(
      paneEquals(base, { ...EMPTY_PANE, repositories: [{ fullName: 'acme/api', ref: 'dev' }] }),
    ).toBe(false)
    expect(paneEquals(base, { ...base, compute: { ...EMPTY_COMPUTE, cpu: '4' } })).toBe(false)
  })
})

describe('mcpServerName', () => {
  it('reads the name off every shape the config admits', () => {
    expect(mcpServerName('linear')).toBe('linear')
    expect(mcpServerName({ name: 'docs', url: 'https://x' })).toBe('docs')
    expect(mcpServerName({})).toBe('')
  })
})

describe('oneLine', () => {
  it('collapses a script to the one line its row is', () => {
    expect(oneLine('npm ci\n  npm test\n')).toBe('npm ci npm test')
    expect(oneLine('')).toBe('')
  })
})

describe('builtInMcpServers', () => {
  it('lists only the connected integrations that back a built-in server', () => {
    expect(builtInMcpServers({ linear: { org: 'x' }, slack: null })).toEqual(['linear'])
    expect(builtInMcpServers({})).toEqual([])
    expect(builtInMcpServers({ linear: {}, slack: {} })).toEqual(['linear', 'slack'])
  })
})

describe('mcpServerEntry', () => {
  it('splits a command line into the stdio shape', () => {
    expect(
      mcpServerEntry({ name: 't', command: 'npx -y my-tools-mcp', url: null }),
    ).toEqual({ name: 't', command: 'npx', args: ['-y', 'my-tools-mcp'] })
    expect(mcpServerEntry({ name: 't', command: 'server-bin', url: null })).toEqual({
      name: 't',
      command: 'server-bin',
    })
  })

  it('builds the remote shape from a url, and a bare name from neither', () => {
    expect(mcpServerEntry({ name: 'd', command: null, url: 'https://x' })).toEqual({
      name: 'd',
      url: 'https://x',
    })
    expect(mcpServerEntry({ name: 'linear', command: null, url: null })).toEqual({
      name: 'linear',
    })
  })
})

describe('validateMcpServer', () => {
  it('requires a name and rejects command with url', () => {
    expect(validateMcpServer({ name: '', command: null, url: null })).toBeTruthy()
    expect(validateMcpServer({ name: 'x', command: 'c', url: 'u' })).toBeTruthy()
    expect(validateMcpServer({ name: 'x', command: 'c', url: null })).toBeNull()
    expect(validateMcpServer({ name: 'x', command: null, url: 'u' })).toBeNull()
    expect(validateMcpServer({ name: 'x', command: null, url: null })).toBeNull()
  })
})

describe('computeOverride', () => {
  it('parses cpu to a number and keeps the others as typed', () => {
    expect(computeOverride({ cpu: '4', memory: '16GB', timeout: '30m' })).toEqual({
      cpu: 4,
      memory: '16GB',
      timeout: '30m',
    })
  })

  it('drops blank and unparseable fields', () => {
    expect(computeOverride(EMPTY_COMPUTE)).toEqual({})
    expect(computeOverride({ cpu: '..', memory: ' ', timeout: '' })).toEqual({})
  })
})

describe('fieldsOverride', () => {
  it('keeps only the set fields, trimmed', () => {
    expect(fieldsOverride({ dockerfile_append: '', setup: ' npm install ' })).toEqual({
      setup: 'npm install',
    })
    expect(fieldsOverride(EMPTY_IMAGE)).toEqual({})
  })
})

describe('parseVariableEntry', () => {
  it('reads a bare name as a stored-secret lookup', () => {
    expect(parseVariableEntry(' API_TOKEN ')).toEqual({ name: 'API_TOKEN', value: null })
  })

  it('splits on the first equals, so a value may contain more', () => {
    expect(parseVariableEntry('DSN=https://a=b')).toEqual({ name: 'DSN', value: 'https://a=b' })
  })

  // Distinct from a bare name: the empty string is a legitimate value.
  it('reads a trailing equals as an empty value', () => {
    expect(parseVariableEntry('EMPTY=')).toEqual({ name: 'EMPTY', value: '' })
  })

  it('rejects a name the sandbox shell could not export', () => {
    expect(parseVariableEntry('not-a-name=1')).toHaveProperty('error')
    expect(parseVariableEntry('9LIVES=1')).toHaveProperty('error')
    expect(parseVariableEntry('   ')).toHaveProperty('error')
  })
})

describe('environmentSectionRows', () => {
  const input = {
    repoNames: ['acme/api'],
    checkedRepoNames: [] as string[],
    secretNames: ['API_TOKEN', 'NPM_TOKEN'],
    variables: [{ name: 'PORT', value: '3000' }],
    builtInMcpServers: ['linear'],
    mcpServers: [] as { name: string; command: string | null; url: string | null }[],
  }

  // Each section is its own flat walk: hover indexes start at 0 per section.
  it('lays each section out with its own hover indexes', () => {
    expect(environmentSectionRows(input, 'repositories')).toEqual([
      { kind: 'repo', fullName: 'acme/api', hover: 0 },
    ])
    expect(environmentSectionRows(input, 'mcpServers')).toEqual([
      { kind: 'mcpServer', name: 'linear', hover: 0 },
      { kind: 'addMcpServer', hover: 1 },
    ])
    expect(environmentSectionRows(input, 'variables')).toEqual([
      { kind: 'variable', name: 'API_TOKEN', hover: 0 },
      { kind: 'variable', name: 'NPM_TOKEN', hover: 1 },
      { kind: 'variable', name: 'PORT', hover: 2 },
      { kind: 'addVariable', hover: 3 },
    ])
    expect(environmentSectionRows(input, 'image')).toEqual([
      { kind: 'image', field: 'dockerfile_append', hover: 0 },
      { kind: 'image', field: 'setup', hover: 1 },
    ])
    expect(environmentSectionRows(input, 'hooks')).toEqual([
      { kind: 'hook', field: 'post_start', hover: 0 },
      { kind: 'hook', field: 'post_clone', hover: 1 },
    ])
    expect(environmentSectionRows(input, 'compute')).toEqual([
      { kind: 'compute', field: 'cpu', hover: 0 },
      { kind: 'compute', field: 'memory', hover: 1 },
      { kind: 'compute', field: 'timeout', hover: 2 },
    ])
  })

  // A server the pane carries whose name is also a built-in rides that row, like
  // the variables: one name, one row, whichever way it got in.
  it('gives a built-in server one row even once it is checked', () => {
    const rows = environmentSectionRows(
      {
        ...input,
        mcpServers: [
          { name: 'linear', command: null, url: null },
          { name: 'my-server', command: 'npx my-server', url: null },
        ],
      },
      'mcpServers',
    )
    expect(
      rows.filter((r) => r.kind === 'mcpServer').map((r) => (r as { name: string }).name),
    ).toEqual(['linear', 'my-server'])
  })

  // Same for a variable: checking a stored one adds it to the pane, so without
  // the union it would appear twice.
  it('gives a stored variable one row even once it is checked', () => {
    const rows = environmentSectionRows(
      { ...input, variables: [{ name: 'API_TOKEN', value: null }] },
      'variables',
    )
    expect(rows.filter((r) => 'name' in r && r.name === 'API_TOKEN')).toHaveLength(1)
  })

  // A variable an environment brought in that the account has no secret for
  // still gets a row: the section shows the whole sandbox, not just what is
  // stored.
  it('lists a variable the account holds no secret for', () => {
    const rows = environmentSectionRows(
      { ...input, secretNames: [], variables: [{ name: 'NODE_ENV', value: 'production' }] },
      'variables',
    )
    expect(rows.filter((r) => r.kind === 'variable')).toEqual([
      { kind: 'variable', name: 'NODE_ENV', hover: 0 },
    ])
  })

  // A checked repo grows a branch input row directly under it, so ↓ can land
  // there and type a ref.
  it('adds a branch row under a checked repo only', () => {
    const rows = environmentSectionRows(
      { ...input, repoNames: ['acme/api', 'acme/web'], checkedRepoNames: ['acme/api'] },
      'repositories',
    )
    expect(rows).toEqual([
      { kind: 'repo', fullName: 'acme/api', hover: 0 },
      { kind: 'repoRef', fullName: 'acme/api', hover: 1 },
      { kind: 'repo', fullName: 'acme/web', hover: 2 },
    ])
  })

  // An empty repo list (not landed yet, or none connected) opens onto nothing.
  it('has no rows while there are no repos', () => {
    expect(environmentSectionRows({ ...input, repoNames: [] }, 'repositories')).toEqual([])
  })
})

describe('environmentSectionAt', () => {
  const input = {
    repoNames: ['acme/api'],
    checkedRepoNames: ['acme/api'],
    secretNames: ['API_TOKEN'],
    variables: [] as { name: string; value: string | null }[],
    builtInMcpServers: [] as string[],
    mcpServers: [] as { name: string; command: string | null; url: string | null }[],
  }

  it('walks a section by its own hover index', () => {
    expect(environmentSectionAt(input, 'repositories', 0)).toEqual({
      kind: 'repo',
      fullName: 'acme/api',
    })
    expect(environmentSectionAt(input, 'repositories', 1)).toEqual({
      kind: 'repoRef',
      fullName: 'acme/api',
    })
    expect(environmentSectionAt(input, 'mcpServers', 0)).toEqual({ kind: 'addMcpServer' })
    expect(environmentSectionAt(input, 'variables', 0)).toEqual({
      kind: 'variable',
      name: 'API_TOKEN',
    })
    expect(environmentSectionAt(input, 'variables', 1)).toEqual({ kind: 'addVariable' })
    expect(environmentSectionAt(input, 'image', 0)).toEqual({
      kind: 'image',
      field: 'dockerfile_append',
    })
  })

  it("clamps a hover past the section's last row", () => {
    expect(environmentSectionAt(input, 'compute', 99)).toEqual({
      kind: 'compute',
      field: 'timeout',
    })
  })
})

describe('environmentSectionSummary', () => {
  const pane = {
    ...EMPTY_PANE,
    repositories: [
      { fullName: 'acme/api', ref: null },
      { fullName: 'acme/web', ref: 'dev' },
    ],
    variables: [{ name: 'API_TOKEN', value: null }],
    mcpServers: [{ name: 'linear', command: null, url: null }],
    compute: { cpu: '4', memory: '16GB', timeout: '' },
    image: { dockerfile_append: 'RUN true', setup: '' },
  }

  // What of the section is in the run, on one line: repos by bare name (a
  // pinned ref rides along), variables/image/hooks as counts, compute the way
  // humans quote machines.
  it('summarizes each section for its collapsed row', () => {
    expect(environmentSectionSummary(pane, 'repositories')).toBe('api, web@dev')
    expect(environmentSectionSummary(pane, 'mcpServers')).toBe('linear')
    expect(environmentSectionSummary(pane, 'variables')).toBe('1 set')
    expect(environmentSectionSummary(pane, 'image')).toBe('1 set')
    expect(environmentSectionSummary(pane, 'compute')).toBe('4 vCPU, 16 GiB')
  })

  it('is empty when the section holds nothing', () => {
    expect(environmentSectionSummary(EMPTY_PANE, 'repositories')).toBe('')
    expect(environmentSectionSummary(pane, 'hooks')).toBe('')
  })
})

describe('environmentOptions', () => {
  const environments = [
    { id: 'env_1', name: 'backend' },
    { id: 'env_2', name: 'web-e2e' },
  ]

  // The resting basic sandbox leads (index 0 is the untouched pick), the
  // built-in [empty] closes the list.
  it('leads with the basic sandbox and ends with [empty]', () => {
    const options = environmentOptions(environments)
    expect(options.map((o) => o.label)).toEqual([
      'basic sandbox',
      'backend',
      'web-e2e',
      '[empty]',
    ])
    expect(options[0].id).toBeNull()
  })

  // A synced environment's row explains where its definition lives.
  it('names the source file a synced environment came from', () => {
    const options = environmentOptions(
      environments,
      new Map([['env_1', 'acme/api/e.yaml @ abcdef1']]),
    )
    expect(options[1].label).toBe('backend (acme/api/e.yaml @ abcdef1)')
  })
})

describe('variableRowLabel', () => {
  // The name alone whenever the sandbox resolves the value; the VARIABLES
  // heading above the rows already says what these are.
  it('shows a value only when there is one', () => {
    expect(variableRowLabel('API_TOKEN', undefined)).toBe('API_TOKEN')
    expect(variableRowLabel('API_TOKEN', null)).toBe('API_TOKEN')
    expect(variableRowLabel('PORT', '3000')).toBe('PORT=3000')
    expect(variableRowLabel('EMPTY', '')).toBe('EMPTY=')
  })
})

describe('repositoryRefLabel', () => {
  // The branch row says which ref a start would clone: the typed one, else the
  // repo's default branch.
  it('shows the typed ref over the default branch', () => {
    expect(repositoryRefLabel('release', 'main')).toBe('release')
    expect(repositoryRefLabel(null, 'main')).toBe('main')
    expect(repositoryRefLabel(null, null)).toBeNull()
  })
})

describe('environmentSourceLabel', () => {
  const repoNames = new Map([[42, 'acme/api']])

  it('names the file and short sha a synced environment came from', () => {
    expect(
      environmentSourceLabel(
        {
          source_details: { repo_id: 42, path: 'agents/environments/dev.yaml', branch: 'main' },
          last_synced_commit_sha: 'abcdef1234567890',
        },
        repoNames,
      ),
    ).toBe('acme/api/agents/environments/dev.yaml @ abcdef1')
  })

  it('drops the sha when the API has none', () => {
    expect(
      environmentSourceLabel(
        { source_details: { repo_id: 42, path: 'e.yaml', branch: 'main' } },
        repoNames,
      ),
    ).toBe('acme/api/e.yaml')
  })

  // Only what the API already gave us: no source (API-managed), or a repo the
  // connected list can't name, says nothing rather than guessing.
  it('says nothing for an API-managed environment or an unknown repo', () => {
    expect(environmentSourceLabel({ source_details: null }, repoNames)).toBeNull()
    expect(
      environmentSourceLabel(
        { source_details: { repo_id: 7, path: 'e.yaml', branch: 'main' } },
        repoNames,
      ),
    ).toBeNull()
  })
})

describe('start request shaping', () => {
  it('parses a repository value into an environment entry', () => {
    expect(parseRepo('acme/api')).toEqual({ owner: 'acme', name: 'api' })
    expect(parseRepo('api')).toEqual({ name: 'api' })
    expect(() => parseRepo('a/b/c')).toThrow(/must be "name" or "owner\/name"/)
  })

  // Only the keys POST /v1/sessions accepts as per-session patches; a file's
  // trigger/input/ellipsis blocks describe a saved agent, not a run.
  it('maps an inline config onto the start request keys', () => {
    expect(
      startRequestFromConfig({
        ellipsis: { name: 'my-agent' },
        claude: { system: 'do it', model: 'claude-opus-5' },
        environment: { repositories: [{ name: 'api' }] },
        budget: { session: 5 },
        trigger: { type: 'cron', schedule: '* * * * *' },
        input: { json_schema: {} },
      }),
    ).toEqual({
      claude: { system: 'do it', model: 'claude-opus-5' },
      environment: { repositories: [{ name: 'api' }] },
      budget: { session: 5 },
    })
  })

  it('adds the detected repo to an environment override only when absent', () => {
    expect(withRepository(undefined, 'acme/api')).toEqual({
      repositories: [{ owner: 'acme', name: 'api' }],
    })
    expect(
      withRepository({ repositories: [{ owner: 'acme', name: 'api' }] }, 'acme/api'),
    ).toEqual({ repositories: [{ owner: 'acme', name: 'api' }] })
    // A bare-name entry counts as the same repository.
    expect(withRepository({ repositories: [{ name: 'api' }] }, 'acme/api')).toEqual({
      repositories: [{ name: 'api' }],
    })
  })

  it('leaves the other keys of an environment override in place', () => {
    expect(withRepository({ variables: [{ name: 'A' }] }, 'api')).toEqual({
      variables: [{ name: 'A' }],
      repositories: [{ name: 'api' }],
    })
  })
})

describe('paneWithRepository', () => {
  it('checks the repo once, and does nothing without one', () => {
    const pane = paneWithRepository(EMPTY_PANE, 'acme/api')
    expect(pane.repositories).toEqual([{ fullName: 'acme/api', ref: null }])
    expect(paneWithRepository(pane, 'acme/api')).toBe(pane)
    expect(paneWithRepository(pane, null)).toBe(pane)
  })
})
