import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { SESSION_BAR_DEFAULTS } from '../src/lib/config'
import { SessionsApp } from '../src/ui/SessionsApp'
import type { AgentSession } from '../src/lib/types'
import { launchPage } from './screenshot'

// The composer shows a random fact; pin it so the text snapshots are stable.
vi.mock('../src/lib/facts', () => ({
  randomFact: () => 'A fixed fact for stable screenshots.',
}))

// The first two screenshot tests of the interactive UI, driven through the
// harness in screenshot.ts: assertions run on the emulated screen's text;
// each test also saves a PNG of the same grid to test/__screenshots__/ for
// human (and agent) review. All network edges are stubbed.

const h = React.createElement

function stubSession(id: string, prompt: string, minutesAgo: number): AgentSession {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString()
  return {
    id,
    status: 'waiting',
    prompt,
    source: 'cli',
    created_at: at,
    updated_at: at,
    last_activity_at: at,
    prompting: { enabled: true },
    agent: { config: { ellipsis: { name: null } }, config_id: null, override: null, source: 'platform_default' },
    tokens: { total: 12_400 },
    cost: { total: 42_000 },
  } as unknown as AgentSession
}

const SESSIONS = [
  stubSession('session_a', 'fix the login bug', 5),
  stubSession('session_b', 'write release notes', 60),
  stubSession('session_c', 'refactor the theme module', 300),
]

// A claude_code assistant-message record — what the chat renders as a ● prose
// row (same shape as connect-render.test.ts).
let seq = 0
function say(text: string): Record<string, unknown> {
  return {
    feed_seq: ++seq,
    source: 'claude_code',
    record_type: 'event',
    payload: {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
  }
}

const RECORDS: Record<string, Record<string, unknown>[]> = {
  session_a: [
    { feed_seq: ++seq, source: 'lifecycle', record_type: 'sandbox_ready', payload: {} },
    say('I found the login bug: the token refresh races the redirect.'),
    say('Fixed in auth.ts; opening a PR now.'),
  ],
}

// SessionsApp's whole API surface for these screens: the sidebar poll, the
// composer's three picker fetches, and the chat's session + records load.
// Empty picker lists are a real state (the composer falls back to its
// built-ins).
const api = {
  sessions: {
    list: async () => ({ items: SESSIONS }),
    get: async (id: string) => ({ session: SESSIONS.find((s) => s.id === id) }),
    records: async (id: string) => ({
      response: { records: RECORDS[id] ?? [], earliest_feed_seq: null, messages: [] },
    }),
  },
  agents: { configs: { list: async () => ({ configs: [] }) } },
  integrations: { github: { repos: async () => ({ repositories: [] }) } },
  models: { list: async () => ({ models: [] }) },
}

function app() {
  return h(SessionsApp, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api: api as any,
    openSocket: () => new Promise(() => {}),
    appBase: 'https://app.ellipsis.dev',
    customerLogin: 'acme',
    ghLogin: 'hunter',
    authorId: 1,
    detectedRepo: 'acme/cli',
    sessionBar: { ...SESSION_BAR_DEFAULTS },
    buildStartRequest: (prompt: string) => (prompt ? { prompt } : { idle_start: true }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
}

describe('interactive UI screenshots', () => {
  it('a bare `agent` opens on the new-session composer', async () => {
    const page = await launchPage(app())
    const screen = page.text()
    expect(screen).toContain('ellipsis.dev')
    expect(screen).toContain('@hunter in acme')
    // The composer panel: its three option rows and the detected repo as the
    // Repository row's resting value.
    expect(screen).toContain('Repository')
    expect(screen).toContain('acme/cli')
    expect(screen).toContain('Model')
    expect(screen).toMatchSnapshot()
    await page.png('new-session-composer')
    page.unmount()
  })

  it('esc opens the session picker; ↓ moves the highlight to the first session', async () => {
    const page = await launchPage(app())
    await page.press('escape')
    const picker = page.text()
    // The highlight opens on the pinned new-session row: its "+ " gutter is
    // replaced by the ▶ selection glyph while the cursor is on it.
    expect(picker).toContain('▶ New session')
    for (const s of SESSIONS) expect(picker).toContain(s.prompt as string)
    expect(picker).toMatchSnapshot()
    await page.png('sessions-picker')

    await page.press('down')
    const moved = page.text()
    // The ▶ selection glyph left the "+ New session" row and sits on the
    // newest session (sort is status band, then newest first).
    const cursorLine = moved.split('\n').find((l) => l.includes('▶'))
    expect(cursorLine).toBeDefined()
    expect(cursorLine).toContain('fix the login bug')
    expect(moved).toMatchSnapshot()
    await page.png('sessions-picker-down')
    page.unmount()
  })

  it('enter on a picked session opens its chat', async () => {
    const page = await launchPage(app())
    await page.press('escape')
    await page.press('down')
    await page.press('enter')
    const chat = page.text()
    // The picker's alt screen closed and the chat printed session_a's
    // transcript into the primary buffer, with the composer underneath.
    expect(chat).toContain('the token refresh races the redirect')
    expect(chat).toContain('opening a PR now')
    expect(chat).toContain('session_a')
    expect(chat).toMatchSnapshot()
    await page.png('session-chat-open')
    page.unmount()
  })
})
