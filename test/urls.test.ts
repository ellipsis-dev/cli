import { describe, expect, it } from 'vitest'
import { cliAuthUrl, configUrl, hyperlink, sessionUrl } from '../src/lib/urls'

describe('sessionUrl', () => {
  it('builds the session detail path scoped by account login', () => {
    expect(sessionUrl('https://app.ellipsis.dev', 'octocat', 'session_8f2c')).toBe(
      'https://app.ellipsis.dev/octocat/sessions/session_8f2c',
    )
  })

  it('encodes the login and session id', () => {
    expect(sessionUrl('https://app.ellipsis.dev', 'a/b', 's d')).toBe(
      'https://app.ellipsis.dev/a%2Fb/sessions/s%20d',
    )
  })
})

describe('configUrl', () => {
  it('builds the agent (config) detail path scoped by account login', () => {
    expect(configUrl('https://app.ellipsis.dev', 'octocat', 'cfg_123')).toBe(
      'https://app.ellipsis.dev/octocat/agents/configs/cfg_123',
    )
  })
})

describe('cliAuthUrl', () => {
  it('builds the approval page url against the given app base', () => {
    expect(cliAuthUrl('https://app.ellipsis.dev', 'PMLJ-VMN2')).toBe(
      'https://app.ellipsis.dev/cli-auth?code=PMLJ-VMN2',
    )
  })

  it('tracks the app base host, so a beta base yields a beta approval url', () => {
    expect(cliAuthUrl('https://beta-app.ellipsis.dev', 'PMLJ-VMN2')).toBe(
      'https://beta-app.ellipsis.dev/cli-auth?code=PMLJ-VMN2',
    )
  })
})

describe('hyperlink', () => {
  const ESC = String.fromCharCode(27)

  it('wraps the label in an OSC 8 escape on a TTY', () => {
    const url = 'https://app.ellipsis.dev/octocat/sessions/session_8f2c'
    expect(hyperlink(url, 'session_8f2c', true)).toBe(
      `${ESC}]8;;${url}${ESC}\\session_8f2c${ESC}]8;;${ESC}\\`,
    )
  })

  it('returns the bare label off a TTY, so piped output stays clean', () => {
    expect(hyperlink('https://x', 'label', false)).toBe('label')
  })
})
