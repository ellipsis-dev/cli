import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { DEFAULT_API_BASE } from './constants'

// TODO(security): move the token to the OS keychain (e.g. keytar) before GA.
// A 0600 file under ~/.config is fine for the skeleton, not for shipping.
// Resolved lazily (not at import) so ELLIPSIS_CONFIG_DIR is honored at runtime.
function configDir(): string {
  return process.env.ELLIPSIS_CONFIG_DIR ?? join(homedir(), '.config', 'ellipsis')
}

function configFile(): string {
  return join(configDir(), 'config.json')
}

export interface CliConfig {
  token?: string
  apiBase?: string
  // Repositories ("owner/name") enrolled for laptop transcript sync — the
  // per-repo opt-in consent gate for `agent session sync`. A sync whose cwd
  // resolves to a repo outside this set is a silent no-op.
  enrolledRepos?: string[]
}

export function loadConfig(): CliConfig {
  const file = configFile()
  if (!existsSync(file)) return {}
  return JSON.parse(readFileSync(file, 'utf8')) as CliConfig
}

export function saveConfig(config: CliConfig): void {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(configFile(), JSON.stringify(config, null, 2), { mode: 0o600 })
}

// Credential precedence (highest wins): explicit arg → environment → config
// file → default. The environment layer lets a pre-provisioned token + base URL
// (e.g. injected into an Ellipsis cloud sandbox) drive the CLI headlessly, with
// no `agent login` and no config file on disk.

// Token from the environment, if set. Used for non-interactive/sandbox auth.
export function envToken(): string | undefined {
  return process.env.ELLIPSIS_API_TOKEN || undefined
}

// Base URL from the environment. Accepts ELLIPSIS_API_BASE_URL (the name the
// sandbox injector uses) and, for back-compat, ELLIPSIS_API_BASE.
export function envApiBase(): string | undefined {
  return process.env.ELLIPSIS_API_BASE_URL || process.env.ELLIPSIS_API_BASE || undefined
}

// Resolve the token across all layers; `explicit` (a CLI arg) wins when given.
export function resolveToken(explicit?: string): string | undefined {
  return explicit ?? envToken() ?? loadConfig().token
}

// Resolve the base URL across all layers; `explicit` wins, default is the floor.
export function resolveApiBase(explicit?: string): string {
  return explicit ?? envApiBase() ?? loadConfig().apiBase ?? DEFAULT_API_BASE
}

// Resolve the dashboard (web app) base URL for building clickable links.
// ELLIPSIS_APP_BASE wins; otherwise derive it from the API base by swapping the
// `api` host label for `app` (api.ellipsis.dev -> app.ellipsis.dev,
// beta-api.ellipsis.dev -> beta-app.ellipsis.dev), so a beta API base yields a
// beta dashboard link. An unrecognized base (e.g. a custom host without `api`)
// is returned unchanged — set ELLIPSIS_APP_BASE for those.
export function resolveAppBase(apiBase?: string): string {
  const explicit = process.env.ELLIPSIS_APP_BASE
  if (explicit) return explicit.replace(/\/+$/, '')
  const base = (apiBase ?? resolveApiBase()).replace(/\/+$/, '')
  return base.replace('://api.', '://app.').replace('-api.', '-app.')
}

export function requireToken(): string {
  const token = resolveToken()
  if (!token) {
    throw new Error(
      'Not logged in. Run `agent login` first, or set ELLIPSIS_API_TOKEN.',
    )
  }
  return token
}
