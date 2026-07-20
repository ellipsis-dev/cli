import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { DEFAULT_API_BASE } from './constants'

// TODO(security): move host tokens to the OS keychain (e.g. keytar) before GA.
// A 0600 file under ~/.config is fine for the skeleton, not for shipping — and
// multi-host means several tokens on disk, so this matters more now.
// Resolved lazily (not at import) so ELLIPSIS_CONFIG_DIR is honored at runtime.
// ~/.ellipsis (not ~/.config/ellipsis): the CLI creates it itself directly
// under $HOME, so it can never inherit a root-owned ~/.config left behind by
// an old `sudo` install — the most common first-run EACCES on macOS.
export function configDir(): string {
  return process.env.ELLIPSIS_CONFIG_DIR ?? join(homedir(), '.ellipsis')
}

function configFile(): string {
  return join(configDir(), 'config.json')
}

// Where pre-0.17 installs kept the config. Read-only fallback so the move to
// ~/.ellipsis doesn't log anyone out; the first saveConfig writes the new
// location and it wins from then on.
function legacyConfigFile(): string {
  return join(homedir(), '.config', 'ellipsis', 'config.json')
}

// One Ellipsis instance the CLI can target (prod, beta, or a self-hosted
// deployment). `apiBase` is the /v1 host; `appBase` is the dashboard host used
// to build clickable links and the login verification URL — derived from
// `apiBase` by default (api. -> app.), but stored explicitly so a self-hosted
// instance whose dashboard host isn't a mechanical swap can set it directly
// (`agent host add … --app-base`). `token` is the credential minted against
// THIS instance; `enrolledRepos` is this instance's laptop-sync consent set.
export interface Host {
  apiBase: string
  appBase?: string
  token?: string
  enrolledRepos?: string[]
}

// The config file (v2): a named set of hosts plus which one is active. Commands
// resolve against the active host unless an env var / explicit arg overrides.
export interface CliConfig {
  version: 2
  activeHost?: string
  hosts: Record<string, Host>
}

// The pre-hosts (v1) file shape — a single flat instance. Kept only so
// loadConfig can migrate an existing install in place (a shipped CLI must not
// silently drop a user's stored token when the schema changes).
interface CliConfigV1 {
  token?: string
  apiBase?: string
  enrolledRepos?: string[]
}

// Swap the `api` host label for `app` (api.ellipsis.dev -> app.ellipsis.dev,
// beta-api.ellipsis.dev -> beta-app.ellipsis.dev). An unrecognized host (a
// self-hosted deployment whose dashboard isn't a mechanical swap) is returned
// unchanged — set the app base explicitly via `agent host … --app-base`.
export function deriveAppBase(apiBase: string): string {
  const base = apiBase.replace(/\/+$/, '')
  return base.replace('://api.', '://app.').replace('-api.', '-app.')
}

// A friendly default name for a host seeded from a bare API base: the prod URL
// is "prod", a `<label>-api.ellipsis.dev` base is "<label>" (beta-api -> beta),
// anything else is "default". Users can rename with `agent host set --rename`.
export function hostNameForBase(apiBase: string): string {
  const base = apiBase.replace(/\/+$/, '')
  if (base === DEFAULT_API_BASE) return 'prod'
  const m = base.match(/^https?:\/\/([a-z0-9-]+)-api\.ellipsis\.dev$/i)
  if (m) return m[1].toLowerCase()
  return 'default'
}

function migrate(raw: unknown): CliConfig {
  const obj = (raw ?? {}) as Record<string, unknown>
  if (obj.version === 2 && obj.hosts) return obj as unknown as CliConfig
  // v1 -> v2: fold the single flat instance into one seeded, active host.
  const v1 = obj as CliConfigV1
  const hosts: Record<string, Host> = {}
  let activeHost: string | undefined
  if (v1.token || v1.apiBase || (v1.enrolledRepos && v1.enrolledRepos.length > 0)) {
    const apiBase = (v1.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')
    const name = hostNameForBase(apiBase)
    hosts[name] = {
      apiBase,
      appBase: deriveAppBase(apiBase),
      ...(v1.token ? { token: v1.token } : {}),
      ...(v1.enrolledRepos ? { enrolledRepos: v1.enrolledRepos } : {}),
    }
    activeHost = name
  }
  return { version: 2, activeHost, hosts }
}

export function loadConfig(): CliConfig {
  const file = configFile()
  if (existsSync(file)) return migrate(JSON.parse(readFileSync(file, 'utf8')))
  // No config at the current path: fall back to the legacy XDG location, but
  // only for the default dir — an explicit ELLIPSIS_CONFIG_DIR must resolve
  // exactly (tests and sandboxes rely on that isolation).
  if (!process.env.ELLIPSIS_CONFIG_DIR) {
    const legacy = legacyConfigFile()
    if (existsSync(legacy)) {
      try {
        return migrate(JSON.parse(readFileSync(legacy, 'utf8')))
      } catch {
        // Unreadable legacy file (often a root-owned ~/.config from an old
        // sudo run — the problem ~/.ellipsis exists to avoid). Start fresh.
      }
    }
  }
  return { version: 2, hosts: {} }
}

export function saveConfig(config: CliConfig): void {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(configFile(), JSON.stringify(config, null, 2), { mode: 0o600 })
}

// --- host management --------------------------------------------------------

export interface HostEntry {
  name: string
  host: Host
  active: boolean
}

export function listHosts(): HostEntry[] {
  const cfg = loadConfig()
  return Object.entries(cfg.hosts).map(([name, host]) => ({
    name,
    host,
    active: name === cfg.activeHost,
  }))
}

export function activeHost(): Host | undefined {
  const cfg = loadConfig()
  return cfg.activeHost ? cfg.hosts[cfg.activeHost] : undefined
}

export function activeHostName(): string | undefined {
  return loadConfig().activeHost
}

// Register (or overwrite) a host and switch to it — `add` is how you both
// create a host and make it the target. appBase defaults to the derived host.
export function addHost(name: string, apiBase: string, appBase?: string): void {
  const cfg = loadConfig()
  const api = apiBase.replace(/\/+$/, '')
  cfg.hosts[name] = {
    ...cfg.hosts[name],
    apiBase: api,
    appBase: (appBase ?? deriveAppBase(api)).replace(/\/+$/, ''),
  }
  cfg.activeHost = name
  saveConfig(cfg)
}

export function useHost(name: string): void {
  const cfg = loadConfig()
  if (!cfg.hosts[name]) throw new Error(`No such host: ${name}. See \`agent host list\`.`)
  cfg.activeHost = name
  saveConfig(cfg)
}

export function deleteHost(name: string): void {
  const cfg = loadConfig()
  if (!cfg.hosts[name]) throw new Error(`No such host: ${name}. See \`agent host list\`.`)
  delete cfg.hosts[name]
  if (cfg.activeHost === name) cfg.activeHost = undefined
  saveConfig(cfg)
}

// Edit an existing host: change its API/app base and/or rename it. Renaming the
// active host keeps it active under the new name.
export function updateHost(
  name: string,
  patch: { apiBase?: string; appBase?: string; rename?: string },
): void {
  const cfg = loadConfig()
  const host = cfg.hosts[name]
  if (!host) throw new Error(`No such host: ${name}. See \`agent host list\`.`)
  if (patch.apiBase !== undefined) host.apiBase = patch.apiBase.replace(/\/+$/, '')
  if (patch.appBase !== undefined) host.appBase = patch.appBase.replace(/\/+$/, '')
  if (patch.rename !== undefined && patch.rename !== name) {
    if (cfg.hosts[patch.rename]) throw new Error(`A host named ${patch.rename} already exists.`)
    delete cfg.hosts[name]
    cfg.hosts[patch.rename] = host
    if (cfg.activeHost === name) cfg.activeHost = patch.rename
  }
  saveConfig(cfg)
}

// Ensure there IS an active host, seeding one at the resolved base (env or
// prod default) if the user logged in / enrolled before adding a host. Returns
// the active host's name. This is what makes a bare `agent login` work.
export function ensureActiveHost(): string {
  const cfg = loadConfig()
  if (cfg.activeHost && cfg.hosts[cfg.activeHost]) return cfg.activeHost
  const apiBase = resolveApiBase()
  const name = hostNameForBase(apiBase)
  cfg.hosts[name] = cfg.hosts[name] ?? { apiBase, appBase: deriveAppBase(apiBase) }
  cfg.activeHost = name
  saveConfig(cfg)
  return name
}

export function setActiveHostToken(token: string): void {
  const name = ensureActiveHost()
  const cfg = loadConfig()
  cfg.hosts[name].token = token
  saveConfig(cfg)
}

export function clearActiveHostToken(): void {
  const cfg = loadConfig()
  if (cfg.activeHost && cfg.hosts[cfg.activeHost]) {
    delete cfg.hosts[cfg.activeHost].token
    saveConfig(cfg)
  }
}

export function clearAllTokens(): void {
  const cfg = loadConfig()
  for (const host of Object.values(cfg.hosts)) delete host.token
  saveConfig(cfg)
}

export function getEnrolledRepos(): string[] {
  return (activeHost()?.enrolledRepos ?? []).map((r) => r.toLowerCase())
}

export function setEnrolledRepos(repos: string[]): void {
  const name = ensureActiveHost()
  const cfg = loadConfig()
  cfg.hosts[name].enrolledRepos = repos
  saveConfig(cfg)
}

// --- credential / URL resolution --------------------------------------------
//
// Precedence (highest wins): explicit arg → environment → active host → default.
// The environment layer lets a pre-provisioned token + base URL (e.g. injected
// into an Ellipsis cloud sandbox) drive the CLI headlessly, with no `agent
// login`, no host, and no config file on disk.

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
  return explicit ?? envToken() ?? activeHost()?.token
}

// Resolve the API base across all layers; `explicit` wins, prod is the floor.
export function resolveApiBase(explicit?: string): string {
  return explicit ?? envApiBase() ?? activeHost()?.apiBase ?? DEFAULT_API_BASE
}

// Resolve the dashboard (web app) base URL for building clickable links and the
// login verification URL. ELLIPSIS_APP_BASE wins (an escape hatch); otherwise,
// with no explicit apiBase, use the active host's stored appBase (server-learned
// or explicitly set); failing that, derive it from the resolved API base.
export function resolveAppBase(apiBase?: string): string {
  const explicit = process.env.ELLIPSIS_APP_BASE
  if (explicit) return explicit.replace(/\/+$/, '')
  if (apiBase === undefined) {
    const host = activeHost()
    if (host?.appBase) return host.appBase.replace(/\/+$/, '')
  }
  const base = (apiBase ?? resolveApiBase()).replace(/\/+$/, '')
  return deriveAppBase(base)
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
