import type { Command } from 'commander'
import React from 'react'
import { render } from 'ink'
import { ApiClient } from '../lib/api'
import { requireToken, resolveApiBase, resolveAppBase } from '../lib/config'
import { runAction } from '../lib/output'
import { foldCosts, isConnectVisibleRecord, recordToItems, type CCEvent } from '../lib/events'
import { sessionUrl } from '../lib/urls'
import { resolveWsBase } from '../lib/ws'
import { ConnectApp } from '../ui/ConnectApp'
import type { AgentSession } from '../lib/types'

// `agent session connect [sessionId]` — the terminal window into a cloud
// session (documents/eng/SESSION_IDE.md §2.6, in the ellipsis monorepo).
//
// A pure /v1 client: it renders the conversation so far from the stored
// transcript, follows new output live over the session WebSocket, and sends
// what you type through POST /v1/sessions/{id}/messages — the same inbox that
// delivers webhook events to the agent's Claude Code stdin at the next turn
// boundary. It NEVER spawns or attaches a Claude Code process (a second
// writer on one CC session corrupts the transcript; the cloud worker is the
// single owner), so it works identically from a laptop and from inside the
// session's own sandbox, where ELLIPSIS_SESSION_ID makes the id optional.

// Where the session id comes from, in precedence order: the positional
// argument, then the in-sandbox ELLIPSIS_SESSION_ID. Pure, for tests.
export function resolveConnectSessionId(
  arg: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const id = arg ?? env.ELLIPSIS_SESSION_ID
  if (!id) {
    throw new Error(
      'provide a session id (find one with `agent session list`); inside an ' +
        'Ellipsis sandbox the current session is used automatically',
    )
  }
  return id
}

// Whether the composer can send to this session, and — when it can't — why.
// Only durable (keyed) sessions have an inbox loop to attend a message;
// single-shot and closed sessions open watch-only. Pure, for tests.
export function connectability(session: AgentSession): {
  canSend: boolean
  reason?: string
} {
  if (!session.session_key) {
    return {
      canSend: false,
      reason: 'this session is single-shot (no durable conversation) — opening watch-only',
    }
  }
  if (session.session_state === 'closed') {
    return {
      canSend: false,
      reason:
        'this conversation is closed (a new event on its surface starts a successor) — opening watch-only',
    }
  }
  return { canSend: true }
}

export function registerConnect(session: Command): void {
  session
    .command('connect [sessionId]')
    .description(
      'Connect to a cloud session: view the conversation, follow it live, and send messages',
    )
    .option('--no-records', 'skip replaying prior records on open')
    .option(
      '--no-input',
      'follow read-only: never open the composer, even on a keyed session (for non-interactive callers)',
    )
    .addHelpText(
      'after',
      `\nMessage mode: render the conversation, follow it live, and send lines through
the session inbox — single-writer-safe and usable headless / inside a sandbox.
Pass --no-input to follow read-only from a script or agent (no TTY needed).`,
    )
    .action(async (sessionId: string | undefined, opts: { records: boolean; input: boolean }) => {
      await runAction(async () => {
        const id = resolveConnectSessionId(sessionId)
        await runConnect(id, opts.records, !opts.input)
      })
    })
}

export async function runConnect(
  sessionId: string,
  showRecords: boolean,
  readOnly = false,
): Promise<void> {
  const api = new ApiClient()
  const token = requireToken()
  const wsBase = resolveWsBase(resolveApiBase())

  const [session, me] = await Promise.all([api.getAgentSession(sessionId), api.whoami()])
  const c = connectability(session)
  // --no-input forces watch-only even when the session would accept messages.
  const canSend = readOnly ? false : c.canSend
  const reason =
    readOnly && c.canSend ? 'read-only (--no-input) — following without the composer' : c.reason
  const url = sessionUrl(resolveAppBase(), me.customer_login, sessionId)

  // No scrollback preamble: the app owns the whole surface, Claude Code-style.
  // The banner (brand + version + session link) and the footer carry the
  // session identity/status; a watch-only reason surfaces as the app's notice.

  // Fetch the stored records to seed the transcript (unless --no-records), the
  // live-refresh cursor (so live updates only append what's new), and the
  // opening spend. Records are ordered by feed_seq (the shared transcript +
  // lifecycle feed). Lifecycle rows are filtered except the sandbox-ready
  // conversation note (isConnectVisibleRecord): connect shows the
  // conversation, and the live activity line + footer carry session state.
  const records = await api.getAgentSessionRecords(sessionId)
  const ordered = [...records].sort((a, b) => a.feed_seq - b.feed_seq)
  const initialMaxFeedSeq = ordered.reduce((m, s) => Math.max(m, s.feed_seq), 0)
  const initialItems = showRecords
    ? ordered
        .filter(isConnectVisibleRecord)
        .flatMap((st) => recordToItems(st, `s${st.feed_seq}`))
    : []
  const initialCost = foldCosts(ordered.map((st) => st.payload as CCEvent))

  // Written by the app when it exits because the conversation closed (terminal;
  // nothing left to reconnect to), so the detach sign-off below stays honest.
  const exitState = { closed: false }
  const app = render(
    React.createElement(ConnectApp, {
      api,
      token,
      sessionId,
      wsBase,
      canSend,
      initialItems,
      // Always advance the cursor past existing records: --no-records skips
      // *rendering* history, not re-streaming it live.
      initialMaxFeedSeq,
      initialStatus: session.surface?.status ?? session.status,
      sessionUrl: url,
      initialCost,
      initialNotice: reason ?? null,
      // The session's one model, fixed at creation (backend tokens_model).
      model: typeof session.tokens_model === 'string' ? session.tokens_model : null,
      exitState,
    }),
  )
  await app.waitUntilExit()

  if (canSend && !exitState.closed) {
    // The session keeps running after a detach; hand back the exact command
    // that re-opens this conversation.
    console.log(`\nresume with: agent session connect ${sessionId}`)
  }
}
