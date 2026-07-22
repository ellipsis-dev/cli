import { describe, expect, it } from 'vitest'
import { deriveSandboxState, hookPhrase, sandboxPhaseLine } from '../src/ui/ConnectApp'

let seq = 0
function rec(recordType: string, payload: Record<string, unknown> = {}, source = 'lifecycle') {
  return { feed_seq: ++seq, source, record_type: recordType, payload }
}

describe('deriveSandboxState', () => {
  it('returns null before any sandbox lifecycle record', () => {
    expect(deriveSandboxState([], 0)).toBeNull()
    expect(deriveSandboxState([rec('assistant', {}, 'claude_code')], 0)).toBeNull()
  })

  it('accumulates chunked setup output into one step per hook, in order', () => {
    const state = deriveSandboxState(
      [
        rec('sandbox_starting'),
        rec('sandbox_setup_output', { hook: 'image.setup', chunk: 0, lines: ['a'] }),
        rec('sandbox_setup_output', { hook: 'image.setup', chunk: 1, lines: ['b', 'c'] }),
        rec('sandbox_setup_output', { hook: 'post_clone', chunk: 0, lines: ['d'] }),
      ],
      0,
    )
    expect(state).not.toBeNull()
    expect(state?.ready).toBe(false)
    expect(state?.steps.map((s) => s.hook)).toEqual(['image.setup', 'post_clone'])
    expect(state?.steps[0].lines).toEqual(['a', 'b', 'c'])
    expect(state?.steps[0].label).toBe('Building image')
    expect(state?.steps[1].lines).toEqual(['d'])
  })

  it('marks ready and keeps the steps once sandbox_ready lands', () => {
    const state = deriveSandboxState(
      [
        rec('sandbox_starting'),
        rec('sandbox_setup_output', { hook: 'post_clone', chunk: 0, lines: ['x'] }),
        rec('sandbox_ready', { repositories: ['o/r'], cache_tier: 'exact' }),
      ],
      0,
    )
    expect(state?.ready).toBe(true)
    expect(state?.steps).toHaveLength(1)
  })

  it('resets on a new sandbox_starting so a wake tells a fresh story', () => {
    const state = deriveSandboxState(
      [
        rec('sandbox_starting'),
        rec('sandbox_setup_output', { hook: 'image.setup', chunk: 0, lines: ['old'] }),
        rec('sandbox_ready', {}),
        rec('sandbox_starting'),
        rec('sandbox_setup_output', { hook: 'post_start', chunk: 0, lines: ['new'] }),
      ],
      0,
    )
    expect(state?.ready).toBe(false)
    expect(state?.steps.map((s) => s.hook)).toEqual(['post_start'])
    expect(state?.steps[0].lines).toEqual(['new'])
  })

  it('ignores records at or below the render cursor (--no-records)', () => {
    const starting = rec('sandbox_starting')
    const ready = rec('sandbox_ready', {})
    expect(deriveSandboxState([starting, ready], ready.feed_seq)).toBeNull()
  })
})

describe('sandboxPhaseLine', () => {
  it('is null with no state or no steps yet', () => {
    expect(sandboxPhaseLine(null)).toBeNull()
    expect(sandboxPhaseLine({ steps: [], ready: false })).toBeNull()
  })

  it('shows only the current phase with its latest log line', () => {
    expect(
      sandboxPhaseLine({
        steps: [
          { hook: 'image.setup', label: 'Building image', lines: ['a'] },
          { hook: 'post_clone', label: 'Post-clone setup', lines: ['bun install', 'done'] },
        ],
        ready: false,
      }),
    ).toBe('Post-clone setup… · done')
  })

  it('rewrites to Ready! once the box is up', () => {
    expect(sandboxPhaseLine({ steps: [], ready: true })).toBe('Ready!')
  })
})

describe('hookPhrase', () => {
  it('maps known hooks and passes unknown ones through', () => {
    expect(hookPhrase('image.setup')).toBe('Building image')
    expect(hookPhrase('post_clone')).toBe('Post-clone setup')
    expect(hookPhrase('custom.hook')).toBe('custom.hook')
  })
})
