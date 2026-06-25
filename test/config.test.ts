import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_API_BASE } from '../src/lib/constants'
import { resolveApiBase, resolveToken, requireToken } from '../src/lib/config'

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
