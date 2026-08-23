import { describe, expect, it } from 'vitest'
import React from 'react'
import { SESSION_BAR_DEFAULTS } from '../src/lib/config'
import { SessionsApp } from '../src/ui/SessionsApp'
import type { AgentSession } from '../src/lib/types'
import { launchPage } from './screenshot'

// Render tests of the interactive UI, driven through the harness in
// screenshot.ts: assertions run on the emulated screen's text. All network
// edges are stubbed.

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

// SessionsApp's whole API surface for these screens: the session-list poll,
// the launcher's three picker fetches, and the chat's session + records load.
// Empty picker lists are a real state (the launcher falls back to its
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
  it('a bare `agent` opens on the launcher', async () => {
    const page = await launchPage(app())
    const screen = page.text()
    expect(screen).toContain('connected to ellipsis.dev as @hunter in acme')
    // The option rows: the detected repo as the Repository row's resting value.
    expect(screen).toContain('Repository: acme/cli')
    expect(screen).toContain('Agent: Default')
    expect(screen).toContain('Model:')
    // The latest sessions, under the prompt.
    for (const s of SESSIONS) expect(screen).toContain(s.prompt as string)
    expect(screen).toMatchSnapshot()
    page.unmount()
  })

  it('↓ from the prompt moves the highlight into the session list', async () => {
    const page = await launchPage(app())
    await page.press('down')
    const moved = page.text()
    // The ▶ selection glyph left the prompt and sits on the newest session
    // (sort is status band, then newest first).
    const cursorLine = moved.split('\n').find((l) => l.includes('▶'))
    expect(cursorLine).toBeDefined()
    expect(cursorLine).toContain('fix the login bug')
    expect(moved).toMatchSnapshot()
    page.unmount()
  })

  it('enter on a picked session opens its chat', async () => {
    const page = await launchPage(app())
    await page.press('down')
    await page.press('enter')
    const chat = page.text()
    // The launcher gave way to session_a's chat: its transcript printed into
    // the primary buffer, with the composer underneath.
    expect(chat).toContain('the token refresh races the redirect')
    expect(chat).toContain('opening a PR now')
    expect(chat).toContain('session_a')
    expect(chat).toMatchSnapshot()
    page.unmount()
  })

  it('esc in the chat returns to the launcher', async () => {
    const page = await launchPage(app())
    await page.press('down')
    await page.press('enter')
    await page.press('escape')
    const back = page.text()
    expect(back).toContain('connected to ellipsis.dev as @hunter in acme')
    expect(back).toContain('Repository: acme/cli')
    page.unmount()
  })
})
