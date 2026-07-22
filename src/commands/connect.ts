import type { Command } from 'commander'
import React from 'react'
import { render } from 'ink'
import { SessionTranscriptStore } from '@ellipsis-dev/sdk/store'
import { ApiClient } from '../lib/api'
import { requireToken, resolveApiBase, resolveAppBase } from '../lib/config'
import { runAction } from '../lib/output'
import { sessionUrl } from '../lib/urls'
import { makeOpenSocket, resolveWsBase } from '../lib/stream'
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
  // An extra opening notice from the caller — shown in the app instead of
  // printed beforehand, which would land in scrollback behind the app.
  startupNotice?: string,
  // The agent config name from the caller (e.g. `start --connect`, whose
  // start response carries resolved_config_name); when absent it is derived
  // from the fetched session. Shown in the footer meta line.
  configName?: string,
): Promise<void> {
  const api = new ApiClient()
  const token = requireToken()
  const openSocket = makeOpenSocket(token, resolveWsBase(resolveApiBase()))

  const [session, me] = await Promise.all([api.getAgentSession(sessionId), api.whoami()])
  const c = connectability(session)
  // --no-input forces watch-only even when the session would accept messages.
  const canSend = readOnly ? false : c.canSend
  const reason =
    readOnly && c.canSend ? 'read-only (--no-input) — following without the composer' : c.reason
  const notice = [startupNotice, reason].filter(Boolean).join(' · ') || null
  const url = sessionUrl(resolveAppBase(), me.customer_login, sessionId)
  // The config identity for the footer meta line: the caller's resolved name
  // first, then whatever the session itself carries.
  const config = configName ?? session.resolved_config_name ?? session.agent_config_id ?? null

  // No scrollback preamble: the app owns the whole surface, Claude Code-style.
  // The footer carries the session identity/status; a watch-only reason
  // surfaces as the app's notice.

  // Seed ONE transcript store with the stored records and the fetched session
  // — synthetic frames through the same ingest path the live stream uses, so
  // the first paint is instant and streamSession resumes past the seeded
  // cursor instead of replaying history. --no-records skips *rendering* the
  // seeded history (minRenderFeedSeq), not re-streaming it.
  const store = new SessionTranscriptStore()
  const page = await api.getAgentSessionRecordsPage(sessionId)
  const ordered = [...page.records].sort((a, b) => a.feed_seq - b.feed_seq)
  if (ordered.length) store.ingest({ type: 'records_append', records: ordered })
  store.ingest({ type: 'messages', messages: page.messages ?? [] })
  store.ingest({ type: 'session', session })

  // Written by the app when it exits because the conversation closed (terminal;
  // nothing left to reconnect to), so the detach sign-off below stays honest.
  const exitState = { closed: false }
  // Start the app at the top of a fresh window: newlines scroll whatever is on
  // screen (the shell prompt, anything a caller printed) into scrollback, then
  // the cursor homes to row 1. Without this the first paint begins mid-screen,
  // overflows the window, and the app's opening lines (the sandbox startup
  // notes) end up stranded above the fold.
  if (process.stdout.isTTY) {
    process.stdout.write('\n'.repeat(process.stdout.rows ?? 24) + '\x1b[H')
  }
  const app = render(
    React.createElement(ConnectApp, {
      api,
      sessionId,
      store,
      openSocket,
      canSend,
      minRenderFeedSeq: showRecords ? 0 : store.cursor,
      sessionUrl: url,
      initialNotice: notice,
      // The session's one model, fixed at creation (backend tokens_model).
      model: typeof session.tokens_model === 'string' ? session.tokens_model : null,
      configName: config,
      exitState,
    }),
  )
  await app.waitUntilExit()

  if (canSend && !exitState.closed) {
    // The session keeps running after a detach; hand back the exact command
    // that re-opens this conversation. No leading newline: the single row this
    // line scrolls is absorbed by the app's top padding (see ConnectApp), so
    // the sign-off never scrolls the app's first content line out of the window.
    console.log(`resume with: agent session connect ${sessionId}`)
  }
}
