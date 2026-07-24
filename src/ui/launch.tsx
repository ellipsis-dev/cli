import React from 'react'
import { render } from 'ink'
import { ApiClient } from '../lib/api'
import { requireToken, resolveApiBase, resolveAppBase } from '../lib/config'
import { repoFromCwd } from '../lib/laptop'
import { makeOpenSocket, resolveWsBase } from '../lib/stream'
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
  // Builds the POST /v1/sessions request for a composer-spawned session; the
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
export function defaultStartRequest(prompt: string): StartAgentSessionRequest {
  const req: StartAgentSessionRequest = { prompt }
  const contextRepo = repoFromCwd(process.cwd())
  if (contextRepo) req.repository = contextRepo
  return req
}

export async function runSessionsUi(options: SessionsUiOptions): Promise<void> {
  const api = new ApiClient()
  const token = requireToken()
  const openSocket = makeOpenSocket(token, resolveWsBase(resolveApiBase()))
  const me = await api.whoami()

  // Start at the top of a fresh window: scroll whatever is on screen into
  // scrollback, then home the cursor (same dance as the solo connect).
  if (process.stdout.isTTY) {
    process.stdout.write('\n'.repeat(process.stdout.rows ?? 24) + '\x1b[H')
  }
  const app = render(
    React.createElement(SessionsApp, {
      api,
      openSocket,
      appBase: resolveAppBase(),
      customerLogin: me.customer_login,
      authorId: me.gh_user?.id ?? null,
      initialSessionId: options.initialSessionId,
      initialConfigName: options.initialConfigName,
      initialNotice: options.initialNotice,
      buildStartRequest: options.buildStartRequest,
    }),
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
