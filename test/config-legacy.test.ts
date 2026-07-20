import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The ~/.config/ellipsis fallback only engages when ELLIPSIS_CONFIG_DIR is
// unset, so unlike config.test.ts these tests can't isolate via that env var.
// Instead homedir() is mocked into a throwaway directory per test.
let home: string
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>()
  return { ...os, homedir: () => home }
})

import { loadConfig, resolveToken, setActiveHostToken } from '../src/lib/config'

function writeLegacyConfig(contents: string): void {
  const dir = join(home, '.config', 'ellipsis')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), contents)
}

function newConfigFile(): string {
  return join(home, '.ellipsis', 'config.json')
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ellipsis-home-'))
  delete process.env.ELLIPSIS_CONFIG_DIR
  delete process.env.ELLIPSIS_API_TOKEN
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('legacy ~/.config/ellipsis fallback', () => {
  it('reads a legacy config when ~/.ellipsis has none', () => {
    writeLegacyConfig(JSON.stringify({ token: 'legacy_tok' }))
    expect(resolveToken()).toBe('legacy_tok')
  })

  it('prefers ~/.ellipsis over the legacy location once it exists', () => {
    writeLegacyConfig(JSON.stringify({ token: 'legacy_tok' }))
    mkdirSync(join(home, '.ellipsis'), { recursive: true })
    writeFileSync(newConfigFile(), JSON.stringify({ token: 'new_tok' }))
    expect(resolveToken()).toBe('new_tok')
  })

  it('migrates to ~/.ellipsis on the first write, keeping legacy state', () => {
    writeLegacyConfig(
      JSON.stringify({ token: 'legacy_tok', enrolledRepos: ['acme/api'] }),
    )
    setActiveHostToken('fresh_tok')
    expect(existsSync(newConfigFile())).toBe(true)
    const saved = JSON.parse(readFileSync(newConfigFile(), 'utf8'))
    expect(saved.hosts.prod).toMatchObject({
      token: 'fresh_tok',
      enrolledRepos: ['acme/api'],
    })
    expect(resolveToken()).toBe('fresh_tok')
  })

  it('starts fresh when the legacy file is unreadable garbage', () => {
    writeLegacyConfig('not json{{')
    expect(loadConfig()).toEqual({ version: 2, hosts: {} })
  })

  it('ELLIPSIS_CONFIG_DIR disables the fallback entirely', () => {
    writeLegacyConfig(JSON.stringify({ token: 'legacy_tok' }))
    const isolated = mkdtempSync(join(tmpdir(), 'ellipsis-cfg-'))
    process.env.ELLIPSIS_CONFIG_DIR = isolated
    try {
      expect(resolveToken()).toBeUndefined()
    } finally {
      delete process.env.ELLIPSIS_CONFIG_DIR
      rmSync(isolated, { recursive: true, force: true })
    }
  })
})
