import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'

// TODO(security): move the token to the OS keychain (e.g. keytar) before GA.
// A 0600 file under ~/.config is fine for the skeleton, not for shipping.
const CONFIG_DIR = process.env.ELLIPSIS_CONFIG_DIR ?? join(homedir(), '.config', 'ellipsis')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

export interface CliConfig {
  token?: string
  apiBase?: string
}

export function loadConfig(): CliConfig {
  if (!existsSync(CONFIG_FILE)) return {}
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as CliConfig
}

export function saveConfig(config: CliConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 })
}

export function requireToken(): string {
  const { token } = loadConfig()
  if (!token) {
    throw new Error('Not logged in. Run `agent login` first.')
  }
  return token
}
