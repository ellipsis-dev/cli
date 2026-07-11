import type { Command } from 'commander'
import { createInterface } from 'node:readline'
import { ApiClient, ApiError } from '../lib/api'
import { requireToken, resolveApiBase, resolveAppBase } from '../lib/config'
import { runAction } from '../lib/output'
import { formatStepLine } from '../lib/steps'
import { sessionUrl } from '../lib/urls'
import {
  resolveWsBase,
  streamSession,
  StreamUnavailableError,
  type StreamFrame,
} from '../lib/ws'
import { attachTerminal, describeTerminalClose, isCleanClose } from '../lib/terminal'
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
    .option('--no-backlog', 'skip printing the stored transcript on open')
    .option(
      '--raw',
      "attach a raw PTY to the agent's live terminal (the pixel-perfect TUI; needs an interactive terminal)",
    )
    .addHelpText(
      'after',
      `\nDefault (message mode): render the conversation, follow it live, and send lines
through the session inbox — single-writer-safe and usable headless / inside a
sandbox. --raw takes over your terminal and drives the agent's live TUI
directly (detach with ${'Ctrl-]'}); it needs a running sandbox and a real TTY.`,
    )
    .action(async (sessionId: string | undefined, opts: { backlog: boolean; raw?: boolean }) => {
      await runAction(async () => {
        const id = resolveConnectSessionId(sessionId)
        if (opts.raw) {
          await runConnectRaw(id)
          return
        }
        await runConnect(id, opts.backlog)
      })
    })
}

// The raw-PTY attach: take over the terminal and bridge it to the session's
// live ttyd (documents/eng/INTERACTIVE_SESSIONS.md §5). Shared by `connect
// --raw` and `session start --connect`. Assumes the sandbox is live; the
// backend closes with a curated reason (surfaced below) when it isn't.
export async function runConnectRaw(sessionId: string): Promise<void> {
  const token = requireToken()
  const wsBase = resolveWsBase(resolveApiBase())
  const result = await attachTerminal({ token, sessionId, wsBase })
  // The bridge has restored the terminal; report on a fresh line.
  process.stdout.write('\r\n')
  if (isCleanClose(result.code)) {
    console.log('detached — the session keeps running (reconnect with the same command)')
    return
  }
  console.log(`✗ ${describeTerminalClose(result.code, result.reason)}`)
  process.exitCode = 1
}

async function runConnect(sessionId: string, backlog: boolean): Promise<void> {
  const api = new ApiClient()
  const token = requireToken()
  const wsBase = resolveWsBase(resolveApiBase())

  const [session, me] = await Promise.all([api.getAgentSession(sessionId), api.whoami()])
  const { canSend, reason } = connectability(session)

  console.log(`session:  ${session.id} (${session.status})`)
  if (session.agent_config_id) console.log(`config:   ${session.agent_config_id}`)
  console.log(`url:      ${sessionUrl(resolveAppBase(), me.customer_login, sessionId)}`)
  if (reason) console.log(reason)

  if (backlog) {
    const steps = await api.getAgentSessionSteps(sessionId)
    if (steps.length > 0) {
      const ordered = [...steps].sort(
        (a, b) => a.created_at.localeCompare(b.created_at) || a.step_index - b.step_index,
      )
      console.log('')
      for (const step of ordered) console.log(formatStepLine(step))
    }
  }

  if (!canSend) {
    // Watch-only: follow the live stream to its terminal frame and exit.
    console.log('')
    await followOnce(token, sessionId, wsBase, 0, (line) => console.log(line))
    return
  }

  console.log('')
  console.log(
    '── connected: type to send (delivered at the next turn boundary), ' +
      '/stop ends the current turn, Ctrl+C detaches ──',
  )

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' })
  const abort = new AbortController()
  // The live-output cursor, carried across stream re-attaches so an idle→wake
  // transition (the previous execution's stream ends with `done`) resumes
  // without dropping or repeating frames.
  let afterSeq = 0
  let streaming = false

  // Print a line "above" the composer: clear the prompt line, write, redraw
  // the prompt with whatever the user had typed.
  const printAbove = (line: string): void => {
    process.stdout.write('\r\x1b[K')
    console.log(line)
    rl.prompt(true)
  }

  // Follow the session's live output until the current execution finishes.
  // A keyed session going terminal is NOT the end of the conversation — it
  // idles out between turns — so we report it quietly and re-attach on the
  // next send instead of exiting.
  const pump = (): void => {
    if (streaming) return
    streaming = true
    void followOnce(token, sessionId, wsBase, afterSeq, printAbove, abort.signal, (seq) => {
      afterSeq = Math.max(afterSeq, seq)
    })
      .then((ended) => {
        if (ended && !abort.signal.aborted) {
          printAbove('· agent idle — a message wakes it')
        }
      })
      .catch((err: unknown) => {
        if (err instanceof StreamUnavailableError) {
          printAbove(`· live stream unavailable (${err.message}) — messages still send`)
        } else {
          printAbove(`✗ stream error: ${(err as Error).message}`)
        }
      })
      .finally(() => {
        streaming = false
      })
  }
  pump()

  const detach = (): void => {
    abort.abort()
    rl.close()
    console.log('\ndetached — the session keeps running (reconnect with the same command)')
  }

  rl.on('SIGINT', detach)
  rl.on('line', (raw) => {
    const text = raw.trim()
    if (!text) {
      rl.prompt()
      return
    }
    if (text === '/exit' || text === '/quit') {
      detach()
      return
    }
    void (async () => {
      try {
        if (text === '/stop') {
          const s = await api.stopAgentSession(sessionId)
          printAbove(`✓ stop requested (${s.status}) — the conversation survives`)
          return
        }
        await api.sendSessionMessage(sessionId, text)
        printAbove('· sent — delivered at the next turn boundary')
        pump() // re-attach if the previous execution had ended
      } catch (err) {
        // 409s carry human-readable reasons (closed, budget floor); show as-is.
        printAbove(`✗ ${err instanceof ApiError ? err.detail : (err as Error).message}`)
      }
    })()
  })
  rl.prompt()

  // Keep the process alive until the user detaches.
  await new Promise<void>((resolve) => rl.on('close', resolve))
}

// One streaming attach: renders frames as display lines until the current
// execution's terminal frame. Resolves true when the stream ended normally
// (terminal `done`), false on abort. Collapses repeated status frames (the
// server's keepalive) exactly like `session get --watch`.
async function followOnce(
  token: string,
  sessionId: string,
  wsBase: string,
  afterSeq: number,
  print: (line: string) => void,
  signal?: AbortSignal,
  onSeq?: (seq: number) => void,
): Promise<boolean> {
  let lastStatus: string | undefined
  const onFrame = (frame: StreamFrame): void => {
    if (typeof frame.seq === 'number') onSeq?.(frame.seq)
    switch (frame.type) {
      case 'status':
        if (frame.status !== lastStatus) {
          lastStatus = frame.status
          print(`· ${frame.status}`)
        }
        break
      case 'stdout':
      case 'stderr':
        if (frame.data) {
          for (const line of frame.data.split('\n')) {
            if (line.trim()) print(line)
          }
        }
        break
      case 'error':
        print(`✗ ${frame.message ?? frame.data ?? 'stream error'}`)
        break
      case 'done':
        break // reported by the caller
    }
  }
  const outcome = await streamSession({ token, sessionId, wsBase, afterSeq, onFrame, signal })
  if (outcome.type === 'error') {
    print(`✗ ${outcome.message}`)
    return true
  }
  return outcome.type === 'done'
}
