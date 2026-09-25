import { join } from 'node:path'
import type { Command } from 'commander'
import { api, APIError } from '../lib/api'
import { deviceLogin, openBrowser, persistToken } from '../lib/auth'
import {
  activeHost,
  activeHostName,
  clearActiveHostToken,
  clearAllTokens,
  configDir,
  envToken,
  resolveApiBase,
  resolveAppBase,
} from '../lib/config'
import { apiRoutes } from '../lib/help'
import { printJson } from '../lib/output'
import type { WhoAmI } from '../lib/types'
import { cliAuthUrl } from '../lib/urls'

// Where the credential the CLI is about to use came from. Mirrors the
// precedence in resolveToken: the environment beats the config file.
export type TokenSource = 'env' | 'config' | 'none'

export function tokenSource(envSet: boolean, stored: boolean): TokenSource {
  if (envSet) return 'env'
  if (stored) return 'config'
  return 'none'
}

// One line per fact the server knows about the credential. Prefers the GitHub
// login over the bare numeric user id when the server resolved a gh_user.
export function renderIdentity(me: WhoAmI): void {
  console.log(`customer:  ${me.customer_login} (${me.customer_id})`)
  if (me.gh_user) console.log(`user:      ${me.gh_user.login} (${me.user_id})`)
  else if (me.user_id) console.log(`user:      ${me.user_id}`)
  if (me.api_key_id) console.log(`api key:   ${me.api_key_id}`)
  if (me.sandbox_id) console.log(`sandbox:   ${me.sandbox_id}`)
}

export function registerAuth(program: Command): void {
  const auth = program
    .command('auth')
    .description('Log in, log out, and check the credential the CLI is using')

  auth
    .command('login')
    .description('Authenticate against the active host via the device-code flow')
    .option('--no-browser', 'do not auto-open the verification URL (for headless or SSH)')
    .action(async (opts: { browser?: boolean }) => {
      try {
        const { token } = await deviceLogin(api(), {
          onPrompt: (start) => {
            // Build the approval URL from the app base of the host the CLI is
            // pointed at, NOT the server's verification_uri_complete: the
            // backend defaults that to prod, so a beta or self-hosted login
            // would otherwise be sent to the prod dashboard, where the code
            // can't be approved. See cliAuthUrl and resolveAppBase.
            const verificationUrl = cliAuthUrl(resolveAppBase(), start.user_code)
            console.log('To authenticate, open this URL and approve the request:')
            console.log(`  ${verificationUrl}`)
            console.log(`Verification code: ${start.user_code}`)
            if (opts.browser !== false) {
              openBrowser(verificationUrl)
            }
            console.log('Waiting for approval…')
          },
        })
        persistToken(token)
        console.log('✓ Logged in.')
      } catch (err) {
        console.error(`login failed: ${(err as Error).message}`)
        process.exitCode = 1
      }
    })

  auth
    .command('logout')
    .description("Remove the active host's stored token, or every host's with --all")
    .option('--all', 'clear the stored token for every host, not just the active one')
    .action((opts: { all?: boolean }) => {
      // Clear only the on-disk token(s); the host entries (api/app base) stay
      // so the next `agent auth login` targets the same instance.
      if (opts.all) {
        clearAllTokens()
      } else {
        clearActiveHostToken()
      }
      // A token supplied via ELLIPSIS_API_TOKEN (e.g. inside a sandbox) lives
      // in the environment and keeps working: don't claim to have cleared what
      // we can't.
      const envNote = process.env.ELLIPSIS_API_TOKEN
        ? ' ELLIPSIS_API_TOKEN is still set in the environment, so that session stays active until it is unset.'
        : ''
      const scope = opts.all ? 'all hosts' : (activeHostName() ?? 'the active host')
      console.log(`Removed stored credentials for ${scope}.${envNote}`)
    })

  apiRoutes(
    auth
      .command('status')
      .description('Show the active host, where the credential came from, and who it belongs to'),
    'GET /v1/identity',
  )
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await status(opts.json === true)
    })
}

// Exit 1 whenever the CLI could not make an authenticated call, so a CI step
// can use `agent auth status` as its readiness check.
async function status(json: boolean): Promise<void> {
  const host = activeHostName() ?? null
  const apiBase = resolveApiBase()
  const source = tokenSource(envToken() !== undefined, activeHost()?.token !== undefined)
  const sourceLabel =
    source === 'env'
      ? 'ELLIPSIS_API_TOKEN'
      : source === 'config'
        ? join(configDir(), 'config.json')
        : 'none'

  let identity: WhoAmI | null = null
  let error: string | undefined
  if (source === 'none') {
    error = 'Not logged in. Run `agent auth login`, or set ELLIPSIS_API_TOKEN.'
  } else {
    try {
      identity = await api().identity()
    } catch (err) {
      if (err instanceof APIError && err.status === 401) {
        error =
          source === 'env'
            ? 'The server rejected ELLIPSIS_API_TOKEN. Check the token, or unset it and run `agent auth login`.'
            : 'The stored token is invalid or has expired. Run `agent auth login` again.'
      } else if (err instanceof APIError) {
        error = `${err.status} ${err.message}`
      } else {
        // Network, DNS, or connection failure: never got an HTTP response.
        error = `cannot reach ${apiBase}: ${(err as Error).message}`
      }
    }
  }

  if (json) {
    printJson({
      host,
      api_base: apiBase,
      token_source: source,
      authenticated: identity !== null,
      identity,
      ...(error ? { error } : {}),
    })
  } else {
    console.log(`host:      ${host ?? 'none'}`)
    console.log(`api:       ${apiBase}`)
    console.log(`token:     ${sourceLabel}`)
    if (identity) renderIdentity(identity)
    if (error) console.error(error)
  }
  if (!identity) process.exitCode = 1
}
