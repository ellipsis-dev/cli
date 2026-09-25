import { describe, expect, it } from 'vitest'
import { parseRepo, startRequestFromConfig, withContextRepository } from '../src/lib/sessions'

describe('start request shaping', () => {
  it('parses a repository value into an environment entry', () => {
    expect(parseRepo('acme/api')).toEqual({ owner: 'acme', name: 'api' })
    expect(parseRepo('api')).toEqual({ name: 'api' })
    expect(() => parseRepo('a/b/c')).toThrow(/must be "name" or "owner\/name"/)
  })

  // Only the keys POST /v1/sessions accepts; an automation file's
  // trigger/input/ellipsis blocks describe a saved automation, not a run, and
  // its session keys live under `session:`.
  it('maps an automation file onto the start request keys', () => {
    expect(
      startRequestFromConfig({
        ellipsis: { name: 'my-agent' },
        trigger: { type: 'cron', schedule: '* * * * *' },
        input: { json_schema: {} },
        session: {
          claude_code: { model: 'claude-opus-5', prompt: 'do it' },
          environment: { repositories: [{ name: 'api' }] },
          budget: { session: 5 },
        },
      }),
    ).toEqual({
      claude_code: { model: 'claude-opus-5', prompt: 'do it' },
      environment: { repositories: [{ name: 'api' }] },
      budget: 5,
    })
  })

  it('accepts a bare session config too', () => {
    expect(
      startRequestFromConfig({
        claude_code: { prompt: 'do it' },
        budget: { session: 2 },
        trigger: { type: 'cron', schedule: '* * * * *' },
      }),
    ).toEqual({ claude_code: { prompt: 'do it' }, budget: 2 })
  })

  // The context repo rides the request's additive `repositories` key and
  // never touches the environment block: an environment OBJECT is the whole
  // sandbox, so a repo put there would replace the default instead of joining it.
  it('adds the detected repo to the request only when absent', () => {
    expect(withContextRepository({}, 'acme/api')).toEqual({ repositories: ['acme/api'] })
    const already = { repositories: ['acme/api'] }
    expect(withContextRepository(already, 'acme/api')).toBe(already)
    expect(withContextRepository({ repositories: ['acme/web'] }, 'acme/api')).toEqual({
      repositories: ['acme/web', 'acme/api'],
    })
  })

  it('leaves the environment block alone', () => {
    expect(withContextRepository({ environment: 'env_1' }, 'api')).toEqual({
      environment: 'env_1',
      repositories: ['api'],
    })
  })

  it('rejects a malformed repository', () => {
    expect(() => withContextRepository({}, 'a/b/c')).toThrow(/owner\/name/)
  })
})
