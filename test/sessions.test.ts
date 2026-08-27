import { describe, expect, it } from 'vitest'
import {
  applyComposerChoices,
  attentionFlip,
  COMPOSER_MODELS,
  composerModelOptions,
  composerPickerRows,
  connectability,
  effectiveEnvironmentDefault,
  environmentOptions,
  environmentPickerAt,
  environmentPickerRows,
  environmentRowSummary,
  filterSessions,
  mergeVariables,
  parseVariableEntry,
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
  const untouched = {
    environment: null,
    model: null,
    emptyEnvironment: false,
    baseVariables: [],
    customVariables: [],
  }

  it('leaves the base request alone when nothing was picked', () => {
    expect(applyComposerChoices({ prompt: 'hi', repository: 'acme/api' }, untouched)).toEqual({
      prompt: 'hi',
      repository: 'acme/api',
    })
  })

  it('keeps the context repo, which picks the repo rung of the defaults ladder', () => {
    const req = applyComposerChoices(
      { repository: 'acme/api' },
      { ...untouched, model: 'claude-opus-5' },
    )
    expect(req.override).toEqual({ claude: { model: 'claude-opus-5' } })
    expect(req.repository).toBe('acme/api')
  })

  it('names a chosen environment on the request, not in the override', () => {
    const req = applyComposerChoices({ prompt: 'ship it' }, { ...untouched, environment: 'env_1' })
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
      override: { claude: { model: 'claude-fable-5' } },
    })
  })

  // The launcher never sends a config source, so the server can't 400 the
  // config + environment combination.
  it('never sends a config id', () => {
    const req = applyComposerChoices({}, { ...untouched, environment: 'env_1' })
    expect(req).not.toHaveProperty('config_id')
  })

  it('does not mutate the request it was given', () => {
    const base = { repository: 'acme/api' }
    applyComposerChoices(base, { ...untouched, environment: 'env_1' })
    expect(base).toEqual({ repository: 'acme/api' })
  })

  // The whole point of the custom section: an override array REPLACES the
  // resolved list, so the picked environment's own variables have to ride along
  // or adding one would silently drop the rest.
  it('ships the picked environment variables alongside a custom one', () => {
    const req = applyComposerChoices(
      {},
      {
        ...untouched,
        environment: 'env_1',
        baseVariables: [{ name: 'NODE_ENV', value: 'production' }],
        customVariables: [{ name: 'SENTRY_DSN', value: 'https://x' }],
      },
    )
    expect(req).toEqual({
      environment: 'env_1',
      override: {
        environment: {
          variables: [
            { name: 'NODE_ENV', value: 'production' },
            { name: 'SENTRY_DSN', value: 'https://x' },
          ],
        },
      },
    })
  })

  it('sends no variables override while the custom section is empty', () => {
    const req = applyComposerChoices(
      {},
      { ...untouched, environment: 'env_1', baseVariables: [{ name: 'NODE_ENV', value: 'x' }] },
    )
    expect(req).toEqual({ environment: 'env_1' })
  })

  it('omits the value of a variable that resolves from stored secrets', () => {
    const req = applyComposerChoices(
      {},
      { ...untouched, customVariables: [{ name: 'API_TOKEN', value: null }] },
    )
    expect(req.override).toEqual({ environment: { variables: [{ name: 'API_TOKEN' }] } })
  })

  // "[empty]" names no environment, so the ladder would still resolve one:
  // clearing the lists is what actually empties the sandbox.
  it('clears every list for the [empty] pick, and drops the base variables', () => {
    const req = applyComposerChoices(
      { repository: 'acme/api' },
      {
        ...untouched,
        emptyEnvironment: true,
        baseVariables: [{ name: 'NODE_ENV', value: 'production' }],
      },
    )
    expect(req).toEqual({
      repository: 'acme/api',
      override: { environment: { repositories: [], mcp_servers: [], variables: [] } },
    })
  })
})

describe('mergeVariables', () => {
  it('appends a custom variable after the environment own', () => {
    expect(
      mergeVariables([{ name: 'A', value: '1' }], [{ name: 'B', value: '2' }]),
    ).toEqual([
      { name: 'A', value: '1' },
      { name: 'B', value: '2' },
    ])
  })

  // Two entries with one name would leave the server to break the tie, so a
  // custom repeat of a base name edits it in place instead.
  it('lets a custom variable override a base one in place', () => {
    expect(
      mergeVariables(
        [
          { name: 'A', value: '1' },
          { name: 'B', value: '2' },
        ],
        [{ name: 'A', value: 'mine' }],
      ),
    ).toEqual([
      { name: 'A', value: 'mine' },
      { name: 'B', value: '2' },
    ])
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

describe('environmentPickerRows', () => {
  const input = {
    optionCount: 2,
    secretNames: ['API_TOKEN', 'NPM_TOKEN'],
    customVariables: [{ name: 'PORT', value: '3000' }],
  }

  // Options, divider, heading, the stored variables, what was typed here, the
  // add button. Only the pickable rows carry a hover index.
  it('lays the list out and numbers only the pickable rows', () => {
    expect(environmentPickerRows(input)).toEqual([
      { kind: 'option', at: 0, hover: 0 },
      { kind: 'option', at: 1, hover: 1 },
      { kind: 'divider', label: 'custom environment' },
      { kind: 'heading', label: 'variables' },
      { kind: 'secret', name: 'API_TOKEN', hover: 2 },
      { kind: 'secret', name: 'NPM_TOKEN', hover: 3 },
      { kind: 'variable', name: 'PORT', hover: 4 },
      { kind: 'addVariable', hover: 5 },
    ])
  })

  // Checking a stored variable adds it to customVariables, so without this it
  // would appear twice — once as the checkbox, once as a typed entry.
  it('gives a stored variable one row even once it is checked', () => {
    const rows = environmentPickerRows({
      ...input,
      customVariables: [{ name: 'API_TOKEN', value: null }],
    })
    expect(rows.filter((r) => 'name' in r && r.name === 'API_TOKEN')).toHaveLength(1)
  })
})

describe('environmentPickerAt', () => {
  const input = {
    optionCount: 2,
    secretNames: ['API_TOKEN'],
    customVariables: [] as { name: string; value: string | null }[],
  }

  it('walks options, then the stored variables, then the add button', () => {
    expect(environmentPickerAt(input, 1)).toEqual({ kind: 'option', at: 1 })
    expect(environmentPickerAt(input, 2)).toEqual({ kind: 'secret', name: 'API_TOKEN' })
    expect(environmentPickerAt(input, 3)).toEqual({ kind: 'addVariable' })
  })

  it('clamps a hover past the last row', () => {
    expect(environmentPickerAt(input, 99)).toEqual({ kind: 'addVariable' })
  })
})

describe('environmentOptions', () => {
  const environments = [
    { id: 'env_1', name: 'backend' },
    { id: 'env_2', name: 'web-e2e' },
  ]

  // Every rung the environment holds is named on its row, so the list says why
  // one of them is checked.
  it('tags each environment with the default rungs it holds', () => {
    const { options, picked } = environmentOptions(
      environments,
      { account: 'env_1', repositories: { 'acme/api': 'env_2' } },
      'acme/api',
    )
    expect(options.map((o) => o.label)).toEqual([
      'backend (account default)',
      'web-e2e (default for acme/api)',
      '[empty]',
    ])
    // The repo rung wins for the repo we are standing in.
    expect(picked).toBe(1)
  })

  it('checks the account rung outside a repo with a default', () => {
    const { options, picked } = environmentOptions(
      environments,
      { account: 'env_1', repositories: {} },
      null,
    )
    expect(options[picked].id).toBe('env_1')
  })

  // Only then is there no name to show, so the server's own resolution stands.
  it('adds a Default row when no rung resolves', () => {
    const { options, picked } = environmentOptions(
      environments,
      { account: null, repositories: {} },
      'acme/api',
    )
    expect(options[0]).toEqual({ id: null, label: 'Default' })
    expect(picked).toBe(0)
  })

  it('adds the Default row while the ladder has not landed', () => {
    const { options, picked } = environmentOptions(environments, null, 'acme/api')
    expect(options[picked]).toEqual({ id: null, label: 'Default' })
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

describe('environmentRowSummary', () => {
  it('states the pick alone until the custom section adds something', () => {
    expect(environmentRowSummary('backend-sandbox', [])).toBe('backend-sandbox')
    expect(environmentRowSummary('backend-sandbox', [{ name: 'A', value: '1' }])).toBe(
      'backend-sandbox +1 variable',
    )
    expect(
      environmentRowSummary('backend-sandbox', [
        { name: 'A', value: '1' },
        { name: 'B', value: null },
      ]),
    ).toBe('backend-sandbox +2 variables')
  })
})

describe('effectiveEnvironmentDefault', () => {
  const ladder = { account: 'env_account', repositories: { 'Acme/API': 'env_repo' } }

  it('prefers the repo rung over the account rung', () => {
    expect(effectiveEnvironmentDefault(ladder, 'acme/api')).toEqual({
      id: 'env_repo',
      rung: 'repo',
    })
  })

  it('falls back to the account rung for another repo, and outside a repo', () => {
    expect(effectiveEnvironmentDefault(ladder, 'acme/web')).toEqual({
      id: 'env_account',
      rung: 'account',
    })
    expect(effectiveEnvironmentDefault(ladder, null)).toEqual({
      id: 'env_account',
      rung: 'account',
    })
  })

  it('resolves nothing when no rung is set (the basic sandbox)', () => {
    expect(effectiveEnvironmentDefault({ account: null, repositories: {} }, 'acme/api')).toBeNull()
  })
})
