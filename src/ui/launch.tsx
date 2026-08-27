import React from 'react'
import { render } from 'ink'
import { api } from '../lib/api'
import { requireToken, resolveApiBase, resolveAppBase, sessionBar } from '../lib/config'
import { repoFromCwd } from '../lib/git'
import { makeOpenSocket, resolveWsBase } from '../lib/stream'
import { applyDetectedThemeMode } from '../lib/terminalBackground'
import type { StartAgentSessionRequest } from '../lib/types'
import { SessionsApp } from './SessionsApp'

// Launches the multi-session UI (sidebar + chat) — the shared destination of
// a bare `agent`, `agent "prompt"`, and `agent session connect <id>`. The
// caller decides what the main pane opens on (a focused session or the
// new-session composer) and how composer-spawned sessions start.

export interface SessionsUiOptions {
  // Focus this session's chat on open; omit for the new-session composer.
  initialSessionId?: string
  // The start response's resolved config name + a caveat for that chat.
  initialConfigName?: string
  initialNotice?: string
  // Builds the POST /sessions request for a composer-spawned session; the
  // typed text rides as the prompt. Entry points bake their flags in here.
  buildStartRequest: (prompt: string) => StartAgentSessionRequest
}

// Whether this invocation can host the interactive multi-session UI at all:
// it needs a real TTY on both ends (raw-mode keyboard + a sized window).
// Headless callers (scripts, sandboxes, --no-input) keep the solo renderer.
export function canHostSessionsUi(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

// The composer-spawned session's start request when the entry point brings
// no flags of its own (connect, and the composer inside a prompt-shorthand
// UI): default-config resolution with the detected repository, exactly like
// a bare `agent` start.
//
// An empty prompt starts the session idle instead: the sandbox spins up and
// Claude Code waits at its prompt, so the first composer message opens turn 0
// (a local `claude` with no argument).
export function defaultStartRequest(prompt: string): StartAgentSessionRequest {
  // A promptless start opens idle by definition (the server-side contract
  // since #6394): Claude Code waits at its prompt for the first message.
  const req: StartAgentSessionRequest = {}
  if (prompt) req.prompt = prompt
  const contextRepo = repoFromCwd(process.cwd())
  if (contextRepo) req.repository = contextRepo
  return req
}

export async function runSessionsUi(options: SessionsUiOptions): Promise<void> {
  const client = api()
  const token = requireToken()
  const openSocket = makeOpenSocket(token, resolveWsBase(resolveApiBase()))
  // Pick the palette for this terminal's background before the first frame.
  const [me] = await Promise.all([client.me(), applyDetectedThemeMode()])

  // No screen-clearing dance: the chat prints its settled transcript into THIS
  // terminal's scrollback (see ConnectApp), so the conversation grows down the
  // terminal from wherever the shell prompt left off, like ordinary command
  // output. Homing the cursor would throw away the scrollback it relies on.
  const app = render(
    React.createElement(SessionsApp, {
      api: client,
      openSocket,
      appBase: resolveAppBase(),
      customerLogin: me.customer_login,
      ghLogin: me.gh_user?.login ?? null,
      authorId: me.gh_user?.id ?? null,
      detectedRepo: repoFromCwd(process.cwd()) ?? null,
      initialSessionId: options.initialSessionId,
      initialConfigName: options.initialConfigName,
      initialNotice: options.initialNotice,
      sessionBar: sessionBar(),
      buildStartRequest: options.buildStartRequest,
    }),
    // exitOnCtrlC off: the app handles ctrl+c itself (first press interrupts a
    // running turn, second quits), which ink's default teardown would preempt.
    { exitOnCtrlC: false },
  )
  // Same revoked-TTY guard as the solo connect: when the terminal is torn
  // down abruptly, stdin's fd stays open but polls fire forever; unmount on
  // the stream's failure events and on reparenting to init.
  const detach = (): void => app.unmount()
  process.stdin.on('error', detach)
  process.stdin.on('end', detach)
  process.stdin.on('close', detach)
  const orphanWatch = setInterval(() => {
    if (process.ppid === 1) app.unmount()
  }, 2000)
  orphanWatch.unref()
  try {
    await app.waitUntilExit()
  } finally {
    clearInterval(orphanWatch)
    process.stdin.off('error', detach)
    process.stdin.off('end', detach)
    process.stdin.off('close', detach)
  }
}
