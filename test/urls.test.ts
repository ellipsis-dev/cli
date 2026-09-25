import { describe, expect, it } from 'vitest'
import { appLoginUrl, automationUrl, cliAuthUrl, sessionUrl } from '../src/lib/urls'

describe('sessionUrl', () => {
  it('builds the account page link with the session query param', () => {
    expect(sessionUrl('https://app.ellipsis.dev', 'octocat', 'session_8f2c')).toBe(
      'https://app.ellipsis.dev/octocat?session=session_8f2c',
    )
  })

  it('encodes the login and session id', () => {
    expect(sessionUrl('https://app.ellipsis.dev', 'a/b', 's d')).toBe(
      'https://app.ellipsis.dev/a%2Fb?session=s%20d',
    )
  })
})

describe('automationUrl', () => {
  it('builds the automation detail path scoped by account login', () => {
    expect(automationUrl('https://app.ellipsis.dev', 'octocat', 'agent_123')).toBe(
      'https://app.ellipsis.dev/octocat/automations/agent_123',
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

describe('appLoginUrl', () => {
  it('builds the dashboard sign-in page url', () => {
    expect(appLoginUrl('https://app.ellipsis.dev')).toBe('https://app.ellipsis.dev/login')
  })

  it('tracks the app base host, so a beta base yields a beta sign-in url', () => {
    expect(appLoginUrl('https://beta-app.ellipsis.dev')).toBe(
      'https://beta-app.ellipsis.dev/login',
    )
  })
})
