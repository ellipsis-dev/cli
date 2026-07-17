import { describe, expect, it } from 'vitest'
import {
  clampLines,
  collapseToolRuns,
  pendingToolCalls,
  eventToItems,
  foldCosts,
  LineBuffer,
  parseEventLine,
  resultCostUsd,
  statusActivityText,
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
          {
            type: 'tool_use',
            name: 'Read',
            input: { file_path: 'src/auth.ts' },
          },
        ],
      },
    }
    const items = eventToItems(event, 's1')
    expect(items.map((i) => i.kind)).toEqual(['thinking', 'assistant', 'tool'])
    expect(items[0].gutter).toBe('✻')
    expect(items[2]).toMatchObject({
      kind: 'tool',
      gutter: '●',
      text: 'Read',
      detail: '(src/auth.ts)',
    })
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
    expect(item).toMatchObject({
      kind: 'tool_result',
      gutter: '⎿',
      text: 'file contents',
      spaceBefore: false,
    })
  })

  it('unwraps nested text blocks in a tool_result and marks errors', () => {
    const event: CCEvent = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            is_error: true,
            content: [{ type: 'text', text: 'boom' }],
          },
        ],
      },
    }
    const [item] = eventToItems(event, 's3')
    expect(item.text).toBe('boom')
    expect(item.isError).toBe(true)
  })

  it('renders a human user message with a › gutter (not as a tool result)', () => {
    const event: CCEvent = {
      type: 'user',
      message: { content: 'please add tests' },
    }
    const [item] = eventToItems(event, 's4')
    expect(item).toMatchObject({
      kind: 'user',
      gutter: '›',
      text: 'please add tests',
      spaceBefore: true,
    })
  })

  it('summarizes a result event with duration and cost', () => {
    const event: CCEvent = {
      type: 'result',
      duration_ms: 12300,
      total_cost_usd: 0.042,
    }
    const [item] = eventToItems(event, 's5')
    expect(item.kind).toBe('summary')
    expect(item.text).toBe('turn complete · 12.3s · $0.04')
  })

  it('renders nothing for system events (CC emits an init per query — noise)', () => {
    expect(eventToItems({ type: 'system', subtype: 'init', model: 'claude-opus-4-8' }, 's6')).toEqual([])
    expect(eventToItems({ type: 'system', subtype: 'status' }, 's6b')).toEqual([])
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

describe('collapseToolRuns', () => {
  const tool = (key: string, name: string): Parameters<typeof collapseToolRuns>[0][number] => ({
    key,
    kind: 'tool',
    text: name,
    gutter: '●',
  })
  const result = (key: string): Parameters<typeof collapseToolRuns>[0][number] => ({
    key,
    kind: 'tool_result',
    text: 'ok',
    gutter: '⎿',
  })
  const prose = (key: string, text: string): Parameters<typeof collapseToolRuns>[0][number] => ({
    key,
    kind: 'assistant',
    text,
  })

  it('folds a run of Bash calls into one shell-command summary', () => {
    const out = collapseToolRuns([
      prose('a', 'Checking.'),
      tool('t1', 'Bash'),
      result('r1'),
      tool('t2', 'Bash'),
      result('r2'),
      prose('b', 'Done.'),
    ])
    expect(out.map((i) => i.kind)).toEqual(['assistant', 'notice', 'assistant'])
    expect(out[1].text).toBe('Ran 2 shell commands')
  })

  it('singular for one call, and names mixed tools', () => {
    expect(collapseToolRuns([tool('t1', 'Bash'), result('r1')])[0].text).toBe(
      'Ran 1 shell command',
    )
    const mixed = collapseToolRuns([tool('t1', 'Bash'), result('r1'), tool('t2', 'Grep')])
    expect(mixed[0].text).toBe('Ran 2 tool calls (Bash, Grep)')
  })

  it('counts files for all-Read runs and splits groups on prose between them', () => {
    const out = collapseToolRuns([
      tool('t1', 'Read'),
      result('r1'),
      prose('a', 'Now the fix.'),
      tool('t2', 'Bash'),
      result('r2'),
    ])
    expect(out.map((i) => i.text)).toEqual(['Read 1 file', 'Now the fix.', 'Ran 1 shell command'])
  })

  it('passes non-tool items through untouched', () => {
    const items = [prose('a', 'Hello.')]
    expect(collapseToolRuns(items)).toEqual(items)
  })
})

describe('pendingToolCalls', () => {
  const tool = (key: string, name: string, detail?: string): Parameters<typeof pendingToolCalls>[0][number] => ({
    key,
    kind: 'tool',
    text: name,
    detail,
    gutter: '●',
  })
  const result = (key: string): Parameters<typeof pendingToolCalls>[0][number] => ({
    key,
    kind: 'tool_result',
    text: 'ok',
    gutter: '⎿',
  })
  const prose = (key: string): Parameters<typeof pendingToolCalls>[0][number] => ({
    key,
    kind: 'assistant',
    text: 'hi',
  })
  const summary = (key: string): Parameters<typeof pendingToolCalls>[0][number] => ({
    key,
    kind: 'summary',
    text: 'turn complete',
  })

  it('reports a call whose result has not arrived', () => {
    const pending = pendingToolCalls([prose('a'), tool('t1', 'Bash', '(pytest -q)')])
    expect(pending).toHaveLength(1)
    expect(pending[0].text).toBe('Bash')
  })

  it('clears once the result lands, FIFO for parallel calls', () => {
    expect(pendingToolCalls([tool('t1', 'Bash'), result('r1')])).toHaveLength(0)
    const two = pendingToolCalls([tool('t1', 'Bash'), tool('t2', 'Grep'), result('r1')])
    expect(two.map((t) => t.text)).toEqual(['Grep'])
  })

  it('resets on any non-tool item, so an errored old turn never reads as running', () => {
    expect(pendingToolCalls([tool('t1', 'Bash'), summary('s1')])).toHaveLength(0)
    expect(pendingToolCalls([tool('t1', 'Bash'), prose('a')])).toHaveLength(0)
  })
})

describe('statusActivityText', () => {
  it('labels the infrastructure phases for the ✻ activity line', () => {
    expect(statusActivityText('scheduled')).toBe('Waiting for a worker')
    expect(statusActivityText('starting')).toBe('Starting sandbox')
    expect(statusActivityText('retrying')).toBe('Retrying after a transient error')
  })

  it('is null for working (the whimsy label takes over) and calm states', () => {
    expect(statusActivityText('working')).toBeNull()
    expect(statusActivityText('waiting')).toBeNull()
    expect(statusActivityText('sleeping')).toBeNull()
    expect(statusActivityText('closed')).toBeNull()
    expect(statusActivityText('failed')).toBeNull()
    expect(statusActivityText('nonsense')).toBeNull()
  })
})
