import { describe, expect, it } from 'vitest'
import {
  clampLines,
  eventToItems,
  foldCosts,
  LineBuffer,
  parseEventLine,
  resultCostUsd,
  statusSystemLine,
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

describe('resultCostUsd', () => {
  it('returns the total_cost_usd of a result event', () => {
    expect(resultCostUsd({ type: 'result', total_cost_usd: 0.4381 })).toBe(0.4381)
  })

  it('is null for non-result events and results without a cost', () => {
    expect(resultCostUsd({ type: 'assistant' })).toBeNull()
    expect(resultCostUsd({ type: 'result' })).toBeNull()
  })
})

describe('foldCosts', () => {
  it('is all-null with no result events', () => {
    expect(foldCosts([{ type: 'assistant' }, { type: 'user' }])).toEqual({
      total: null,
      lastStep: null,
    })
  })

  it('makes the first turn cost the whole cumulative total', () => {
    expect(foldCosts([{ type: 'result', total_cost_usd: 0.32 }])).toEqual({
      total: 0.32,
      lastStep: 0.32,
    })
  })

  it('takes the latest total and the delta from the previous result as the last step', () => {
    // The cumulative result totals from the "u up" prod session: 0.41 then 0.44
    // → total 0.44, last turn 0.03.
    const events: CCEvent[] = [
      { type: 'result', total_cost_usd: 0.3224 },
      { type: 'result', total_cost_usd: 0.41 },
      { type: 'result', total_cost_usd: 0.4381 },
    ]
    const { total, lastStep } = foldCosts(events)
    expect(total).toBeCloseTo(0.4381, 4)
    expect(lastStep).toBeCloseTo(0.0281, 4)
  })

  it('never reports a negative last step if a total regresses', () => {
    const events: CCEvent[] = [
      { type: 'result', total_cost_usd: 0.5 },
      { type: 'result', total_cost_usd: 0.4 },
    ]
    expect(foldCosts(events).lastStep).toBe(0)
  })
})

describe('statusSystemLine', () => {
  it('maps surface statuses to Claude-Code-style lines', () => {
    expect(statusSystemLine('starting')).toBe('starting sandbox')
    expect(statusSystemLine('working')).toBe('agent working')
    expect(statusSystemLine('waiting')).toBe('waiting for your reply')
    expect(statusSystemLine('sleeping')).toBe('sleeping · your next message wakes it')
    expect(statusSystemLine('closed')).toBe('conversation closed')
    expect(statusSystemLine('failed')).toBe('session failed')
  })

  it('is null for an unknown status', () => {
    expect(statusSystemLine('nonsense')).toBeNull()
  })
})
