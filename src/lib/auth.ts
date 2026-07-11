import { spawn } from 'node:child_process'
import { ApiClient } from './api'
import { setActiveHostToken } from './config'
import type { CliAuthStart } from './types'

export interface DeviceLoginHandlers {
  // Called once the codes are minted, before polling begins. The caller prints
  // the user code + verification URL so the human can approve in the dashboard.
  onPrompt: (start: CliAuthStart) => void
  // Called on each poll while still pending, so the caller can show progress.
  onPending?: () => void
}

export interface DeviceLoginResult {
  token: string
}

// Drives the device-code flow end to end (start -> poll -> persist token).
// See documents/eng/ELLIPSIS_API_AND_CLI.md §5 in the backend repo.
export async function deviceLogin(
  api: ApiClient,
  handlers: DeviceLoginHandlers,
): Promise<DeviceLoginResult> {
  const start = await api.startCliAuth()
  handlers.onPrompt(start)

  const intervalMs = Math.max(1, start.interval) * 1000
  const deadline = nowMs() + start.expires_in * 1000

  while (nowMs() < deadline) {
    await sleep(intervalMs)
    const poll = await api.pollCliAuth(start.device_code)
    switch (poll.status) {
      case 'pending':
        handlers.onPending?.()
        continue
      case 'approved':
        if (!poll.access_token) {
          throw new Error('Approved, but no token was returned by the server.')
        }
        return { token: poll.access_token }
      case 'denied':
        throw new Error('Authorization was denied.')
      case 'expired':
        throw new Error('The login request expired before it was approved.')
      case 'already_claimed':
        throw new Error('This login request was already completed elsewhere.')
      default:
        throw new Error(`Unexpected poll status: ${poll.status as string}`)
    }
  }
  throw new Error('Timed out waiting for approval.')
}

// Persists the token on the active host (seeding one at the resolved base if
// the user logged in before adding a host), so a token minted against one
// instance is never silently reused against another.
export function persistToken(token: string): void {
  setActiveHostToken(token)
}

// Best-effort browser open; never throws (headless/SSH sessions just won't have
// a browser, and the user can open the printed URL manually).
export function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // ignore — the URL is printed regardless
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nowMs(): number {
  return Date.now()
}
