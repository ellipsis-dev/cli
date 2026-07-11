import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_API_BASE } from '../src/lib/constants'
import {
  activeHostName,
  addHost,
  clearActiveHostToken,
  deleteHost,
  getEnrolledRepos,
  listHosts,
  loadConfig,
  requireToken,
  resolveApiBase,
  resolveAppBase,
  resolveToken,
  setActiveHostToken,
  setEnrolledRepos,
  updateHost,
  useHost,
} from '../src/lib/config'

// Each test gets a throwaway ELLIPSIS_CONFIG_DIR so resolveToken/resolveApiBase
// read a known config file (or none) without touching the real ~/.config.
let dir: string

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config))
}

const ENV_KEYS = [
  'ELLIPSIS_API_TOKEN',
  'ELLIPSIS_API_BASE_URL',
  'ELLIPSIS_API_BASE',
  'ELLIPSIS_APP_BASE',
] as const

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ellipsis-cfg-'))
  process.env.ELLIPSIS_CONFIG_DIR = dir
  for (const k of ENV_KEYS) delete process.env[k]
})

afterEach(() => {
  delete process.env.ELLIPSIS_CONFIG_DIR
  for (const k of ENV_KEYS) delete process.env[k]
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveToken precedence', () => {
  it('explicit arg wins over env and config', () => {
    process.env.ELLIPSIS_API_TOKEN = 'env_tok'
    writeConfig({ token: 'file_tok' })
    expect(resolveToken('explicit_tok')).toBe('explicit_tok')
  })

  it('env wins over config file', () => {
    process.env.ELLIPSIS_API_TOKEN = 'env_tok'
    writeConfig({ token: 'file_tok' })
    expect(resolveToken()).toBe('env_tok')
  })

  it('falls back to the config file when no env token', () => {
    writeConfig({ token: 'file_tok' })
    expect(resolveToken()).toBe('file_tok')
  })

  it('returns undefined when nothing is set', () => {
    expect(resolveToken()).toBeUndefined()
  })

  it('treats an empty env token as unset', () => {
    process.env.ELLIPSIS_API_TOKEN = ''
    writeConfig({ token: 'file_tok' })
    expect(resolveToken()).toBe('file_tok')
  })
})

describe('requireToken', () => {
  it('succeeds with an env-only token (no config file, headless sandbox)', () => {
    process.env.ELLIPSIS_API_TOKEN = 'env_tok'
    expect(requireToken()).toBe('env_tok')
  })

  it('throws and mentions ELLIPSIS_API_TOKEN when no credential exists', () => {
    expect(() => requireToken()).toThrow(/ELLIPSIS_API_TOKEN/)
  })
})

describe('resolveApiBase precedence', () => {
  it('explicit arg wins over everything', () => {
    process.env.ELLIPSIS_API_BASE_URL = 'https://env.example'
    writeConfig({ apiBase: 'https://file.example' })
    expect(resolveApiBase('https://explicit.example')).toBe('https://explicit.example')
  })

  it('honors ELLIPSIS_API_BASE_URL over the config file', () => {
    process.env.ELLIPSIS_API_BASE_URL = 'https://env.example'
    writeConfig({ apiBase: 'https://file.example' })
    expect(resolveApiBase()).toBe('https://env.example')
  })

  it('accepts the legacy ELLIPSIS_API_BASE name as a fallback', () => {
    process.env.ELLIPSIS_API_BASE = 'https://legacy.example'
    expect(resolveApiBase()).toBe('https://legacy.example')
  })

  it('prefers ELLIPSIS_API_BASE_URL over the legacy ELLIPSIS_API_BASE', () => {
    process.env.ELLIPSIS_API_BASE_URL = 'https://new.example'
    process.env.ELLIPSIS_API_BASE = 'https://legacy.example'
    expect(resolveApiBase()).toBe('https://new.example')
  })

  it('falls back to the config file, then the default', () => {
    writeConfig({ apiBase: 'https://file.example' })
    expect(resolveApiBase()).toBe('https://file.example')
  })

  it('uses the default base when nothing is configured', () => {
    expect(resolveApiBase()).toBe(DEFAULT_API_BASE)
  })
})

describe('resolveAppBase', () => {
  it('derives the prod app base from the prod api base', () => {
    expect(resolveAppBase('https://api.ellipsis.dev')).toBe('https://app.ellipsis.dev')
  })

  it('derives the beta app base from the beta api base', () => {
    expect(resolveAppBase('https://beta-api.ellipsis.dev')).toBe('https://beta-app.ellipsis.dev')
  })

  it('strips a trailing slash', () => {
    expect(resolveAppBase('https://api.ellipsis.dev/')).toBe('https://app.ellipsis.dev')
  })

  it('ELLIPSIS_APP_BASE overrides derivation', () => {
    process.env.ELLIPSIS_APP_BASE = 'http://localhost:3000/'
    expect(resolveAppBase('https://api.ellipsis.dev')).toBe('http://localhost:3000')
  })

  it('returns an unrecognized base unchanged', () => {
    expect(resolveAppBase('http://localhost:5000')).toBe('http://localhost:5000')
  })

  it('falls back to the resolved api base when no arg is given', () => {
    process.env.ELLIPSIS_API_BASE_URL = 'https://beta-api.ellipsis.dev'
    expect(resolveAppBase()).toBe('https://beta-app.ellipsis.dev')
  })

  it('prefers the active host stored appBase over derivation', () => {
    addHost('acme', 'https://ellipsis.acme.internal', 'https://dashboard.acme.internal')
    // The API host has no `api.`/`-api.` label to swap, so derivation would
    // return it unchanged (the wrong dashboard); the explicit app base wins.
    expect(resolveAppBase()).toBe('https://dashboard.acme.internal')
  })
})

describe('host management', () => {
  it('add registers a host, switches to it, and derives its app base', () => {
    addHost('beta', 'https://beta-api.ellipsis.dev')
    expect(activeHostName()).toBe('beta')
    expect(resolveApiBase()).toBe('https://beta-api.ellipsis.dev')
    expect(resolveAppBase()).toBe('https://beta-app.ellipsis.dev')
  })

  it('use switches the active host; commands resolve against it', () => {
    addHost('beta', 'https://beta-api.ellipsis.dev')
    addHost('prod', 'https://api.ellipsis.dev')
    expect(activeHostName()).toBe('prod')
    useHost('beta')
    expect(resolveApiBase()).toBe('https://beta-api.ellipsis.dev')
  })

  it('use throws for an unknown host', () => {
    expect(() => useHost('nope')).toThrow(/No such host/)
  })

  it('tokens are stored per host and survive a switch', () => {
    addHost('beta', 'https://beta-api.ellipsis.dev')
    setActiveHostToken('beta_tok')
    addHost('prod', 'https://api.ellipsis.dev')
    setActiveHostToken('prod_tok')
    expect(resolveToken()).toBe('prod_tok')
    useHost('beta')
    expect(resolveToken()).toBe('beta_tok')
  })

  it('delete removes the host and clears active when it was active', () => {
    addHost('beta', 'https://beta-api.ellipsis.dev')
    deleteHost('beta')
    expect(listHosts()).toHaveLength(0)
    expect(activeHostName()).toBeUndefined()
  })

  it('set renames a host and keeps it active', () => {
    addHost('beta', 'https://beta-api.ellipsis.dev')
    updateHost('beta', { rename: 'staging' })
    expect(activeHostName()).toBe('staging')
    expect(listHosts().map((h) => h.name)).toEqual(['staging'])
  })

  it('logout clears only the active host token, keeping the entry', () => {
    addHost('beta', 'https://beta-api.ellipsis.dev')
    setActiveHostToken('beta_tok')
    clearActiveHostToken()
    expect(resolveToken()).toBeUndefined()
    expect(activeHostName()).toBe('beta') // entry survives
  })

  it('enrolled repos are scoped to the active host', () => {
    addHost('beta', 'https://beta-api.ellipsis.dev')
    setEnrolledRepos(['acme/api'])
    addHost('prod', 'https://api.ellipsis.dev')
    expect(getEnrolledRepos()).toEqual([])
    useHost('beta')
    expect(getEnrolledRepos()).toEqual(['acme/api'])
  })
})

describe('v1 -> v2 config migration', () => {
  it('folds a flat {token, apiBase} into one active host', () => {
    writeConfig({ token: 'file_tok', apiBase: 'https://beta-api.ellipsis.dev' })
    const cfg = loadConfig()
    expect(cfg.version).toBe(2)
    expect(cfg.activeHost).toBe('beta')
    expect(cfg.hosts.beta).toMatchObject({
      apiBase: 'https://beta-api.ellipsis.dev',
      appBase: 'https://beta-app.ellipsis.dev',
      token: 'file_tok',
    })
    expect(resolveToken()).toBe('file_tok')
  })

  it('names a prod-based v1 config "prod"', () => {
    writeConfig({ token: 'file_tok' }) // no apiBase -> prod default
    expect(loadConfig().activeHost).toBe('prod')
  })

  it('carries enrolled repos onto the migrated host', () => {
    writeConfig({ apiBase: 'https://api.ellipsis.dev', enrolledRepos: ['acme/api'] })
    expect(getEnrolledRepos()).toEqual(['acme/api'])
  })

  it('an empty v1 config migrates to no hosts', () => {
    writeConfig({})
    const cfg = loadConfig()
    expect(cfg.hosts).toEqual({})
    expect(cfg.activeHost).toBeUndefined()
  })
})
