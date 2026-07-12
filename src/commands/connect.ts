import type { Command } from 'commander'
import React from 'react'
import { render } from 'ink'
import { ApiClient } from '../lib/api'
import { requireToken, resolveApiBase, resolveAppBase } from '../lib/config'
import { runAction } from '../lib/output'
import { eventToItems, type CCEvent, type TranscriptItem } from '../lib/events'
import { sessionUrl } from '../lib/urls'
import { resolveWsBase } from '../lib/ws'
import { ConnectApp } from '../ui/ConnectApp'
import type { AgentSession, AgentStep } from '../lib/types'

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
      reason:
        'this session is single-shot (no durable conversation) — opening watch-only',
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
    .option('--no-steps', 'skip replaying prior steps on open')
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
    .action(async (sessionId: string | undefined, opts: { steps: boolean; input: boolean }) => {
      await runAction(async () => {
        const id = resolveConnectSessionId(sessionId)
        await runConnect(id, opts.steps, !opts.input)
      })
    })
}

export async function runConnect(
  sessionId: string,
  showSteps: boolean,
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

  // A compact header printed once above the live transcript.
  console.log(`${session.id} · ${session.status}`)
  console.log(sessionUrl(resolveAppBase(), me.customer_login, sessionId))
  if (session.agent_config_id) console.log(`config ${session.agent_config_id}`)
  if (reason) console.log(reason)
  if (canSend) {
    console.log('type to send · /stop ends the turn · /exit or Ctrl+C detaches')
  }

  // Fetch the stored steps to seed the transcript (unless --no-steps) and to
  // set the live-refresh cursor, so the live updates only append what's new.
  // The step `data` is the same Claude Code event shape the UI renders live.
  const steps = await api.getAgentSessionSteps(sessionId)
  const initialMaxStepIndex = steps.reduce((m, s) => Math.max(m, s.step_index), -1)
  const initialItems = showSteps ? stepsToItems(steps) : []

  const app = render(
    React.createElement(ConnectApp, {
      api,
      token,
      sessionId,
      wsBase,
      canSend,
      initialItems,
      // Always advance the cursor past existing steps: --no-steps skips
      // *rendering* history, not re-streaming it live.
      initialMaxStepIndex,
      initialStatus: session.status,
    }),
  )
  await app.waitUntilExit()

  if (canSend) {
    console.log('\ndetached — the session keeps running (reconnect with the same command)')
  }
}

// Flatten stored steps into transcript items, in chronological order — the
// stored `data` is the same Claude Code event shape as the live stream.
function stepsToItems(steps: AgentStep[]): TranscriptItem[] {
  const ordered = [...steps].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.step_index - b.step_index,
  )
  const items: TranscriptItem[] = []
  for (const step of ordered) {
    items.push(...eventToItems(step.data as CCEvent, `s${step.step_index}`))
  }
  return items
}
