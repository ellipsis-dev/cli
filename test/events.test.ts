import { describe, expect, it } from 'vitest'
import {
  clampLines,
  eventToItems,
  LineBuffer,
  parseEventLine,
  summarizeToolInput,
  type CCEvent,
} from '../src/lib/events'

describe('LineBuffer', () => {
  it('emits only complete lines and buffers the trailing partial', () => {
    const buf = new LineBuffer()
    expect(buf.push('{"a":1}\n{"b":2}')).toEqual(['{"a":1}'])
    expect(buf.push('\n{"c"')).toEqual(['{"b":2}'])
    expect(buf.push(':3}\n')).toEqual(['{"c":3}'])
  })

  it('reassembles a single event split across frames', () => {
    const buf = new LineBuffer()
    expect(buf.push('{"ty')).toEqual([])
    expect(buf.push('pe":"x"}')).toEqual([])
    expect(buf.push('\n')).toEqual(['{"type":"x"}'])
  })

  it('flush releases a trailing partial once', () => {
    const buf = new LineBuffer()
    buf.push('tail')
    expect(buf.flush()).toEqual(['tail'])
    expect(buf.flush()).toEqual([])
  })
})

describe('parseEventLine', () => {
  it('parses a JSON object', () => {
    expect(parseEventLine('{"type":"result"}')).toEqual({ type: 'result' })
  })

  it('returns null for blank, non-JSON, or non-object lines', () => {
    expect(parseEventLine('   ')).toBeNull()
    expect(parseEventLine('not json')).toBeNull()
    expect(parseEventLine('[1,2,3]')).toBeNull()
    expect(parseEventLine('"a string"')).toBeNull()
  })
})

describe('summarizeToolInput', () => {
  it('shows the file path for file tools', () => {
    expect(summarizeToolInput('Read', { file_path: 'src/auth.ts' })).toBe('src/auth.ts')
    expect(summarizeToolInput('Edit', { file_path: 'a.ts', old_string: 'x' })).toBe('a.ts')
  })

  it('shows the command for Bash and the pattern for Grep', () => {
    expect(summarizeToolInput('Bash', { command: 'ls -la' })).toBe('ls -la')
    expect(summarizeToolInput('Grep', { pattern: 'foo', path: 'src' })).toBe('foo in src')
  })

  it('falls back to compact JSON for unknown tools', () => {
    expect(summarizeToolInput('Mystery', { a: 1 })).toBe('{"a":1}')
    expect(summarizeToolInput('Mystery', {})).toBe('')
  })
})

describe('eventToItems', () => {
  it('renders assistant text, thinking, and tool calls as grouped items', () => {
    const event: CCEvent = {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'checking the auth flow' },
          { type: 'text', text: 'Reading the file.' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'src/auth.ts' } },
        ],
      },
    }
    const items = eventToItems(event, 's1')
    expect(items.map((i) => i.kind)).toEqual(['thinking', 'assistant', 'tool'])
    expect(items[0].gutter).toBe('✻')
    expect(items[2]).toMatchObject({ kind: 'tool', gutter: '●', text: 'Read', detail: '(src/auth.ts)' })
    // Unique keys within one event.
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length)
  })

  it('groups a tool_result under the call with a ⎿ gutter', () => {
    const event: CCEvent = {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }],
      },
    }
    const [item] = eventToItems(event, 's2')
    expect(item).toMatchObject({ kind: 'tool_result', gutter: '⎿', text: 'file contents', spaceBefore: false })
  })

  it('unwraps nested text blocks in a tool_result and marks errors', () => {
    const event: CCEvent = {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'boom' }] },
        ],
      },
    }
    const [item] = eventToItems(event, 's3')
    expect(item.text).toBe('boom')
    expect(item.isError).toBe(true)
  })

  it('renders a human user message with a › gutter (not as a tool result)', () => {
    const event: CCEvent = { type: 'user', message: { content: 'please add tests' } }
    const [item] = eventToItems(event, 's4')
    expect(item).toMatchObject({ kind: 'user', gutter: '›', text: 'please add tests', spaceBefore: true })
  })

  it('summarizes a result event with duration and cost', () => {
    const event: CCEvent = { type: 'result', duration_ms: 12300, total_cost_usd: 0.042 }
    const [item] = eventToItems(event, 's5')
    expect(item.kind).toBe('summary')
    expect(item.text).toBe('turn complete · 12.3s · $0.04')
  })

  it('renders a system init line', () => {
    const event: CCEvent = { type: 'system', subtype: 'init', model: 'claude-opus-4-8' }
    const [item] = eventToItems(event, 's6')
    expect(item.kind).toBe('system')
    expect(item.text).toContain('claude-opus-4-8')
  })

  it('produces no items for an empty assistant turn', () => {
    expect(eventToItems({ type: 'assistant', message: { content: [] } }, 's7')).toEqual([])
  })
})

describe('clampLines', () => {
  it('leaves short bodies untouched', () => {
    expect(clampLines('a\nb', 6)).toEqual({ body: 'a\nb', more: 0 })
  })

  it('clamps long bodies and counts the remainder', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')
    const { body, more } = clampLines(text, 6)
    expect(body.split('\n')).toHaveLength(6)
    expect(more).toBe(4)
  })
})
