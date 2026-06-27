import { describe, expect, it } from 'vitest'
import { configUrl, runUrl } from '../src/lib/urls'

describe('runUrl', () => {
  it('builds the run detail path scoped by account login', () => {
    expect(runUrl('https://app.ellipsis.dev', 'octocat', 'run_8f2c')).toBe(
      'https://app.ellipsis.dev/octocat/agents/runs/run_8f2c',
    )
  })

  it('encodes the login and run id', () => {
    expect(runUrl('https://app.ellipsis.dev', 'a/b', 'r d')).toBe(
      'https://app.ellipsis.dev/a%2Fb/agents/runs/r%20d',
    )
  })
})

describe('configUrl', () => {
  it('builds the agent (config) detail path scoped by account login', () => {
    expect(configUrl('https://app.ellipsis.dev', 'octocat', 'cfg_123')).toBe(
      'https://app.ellipsis.dev/octocat/agents/cfg_123',
    )
  })
})
