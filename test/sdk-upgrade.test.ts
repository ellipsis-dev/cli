import { describe, expect, it } from 'vitest'
import type { SessionRecord } from '@ellipsis-dev/sdk'
import { SessionTranscriptStore } from '@ellipsis-dev/sdk/store'
import { budgetLines } from '../src/commands/usage'
import {
  chatTurnsToItems,
  foldRecordCosts,
  undisplayedRecordCount,
} from '../src/lib/chatItems'
import { recordText } from '../src/lib/steps'
import { buildStartOverride } from '../src/commands/session'
import { toHarness } from '../src/lib/args'
import {
  applyComposerChoices,
  composerModelChoice,
  composerModelOptions,
  startRequestFromConfig,
} from '../src/lib/sessions'
import type { BudgetSummary, SupportedModel } from '../src/lib/types'

const envelope = {
  id: 'record_1',
  session_id: 'session_1',
  session_execution_id: 'execution_1',
  agent_turn_id: 'turn_1',
  sandbox_id: 'sandbox_1',
  session_message_id: null,
  created_at: '2026-09-10T12:00:00Z',
  feed_seq: 1,
  stream_seq: 1,
  cost: null,
  duration: null,
  model: null,
  tokens_info: null,
  tools: null,
}

const assistant: SessionRecord = {
  ...envelope,
  kind: 'claude_code',
  source: 'claude_code',
  record_format: 'claude_jsonl@1',
  record_type: 'assistant',
  payload: {
    type: 'assistant',
    message: {
      type: 'message',
      id: 'message_1',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'All tests pass.' }],
    },
  },
}

const result: SessionRecord = {
  ...envelope,
  id: 'record_2',
  feed_seq: 2,
  stream_seq: 2,
  kind: 'claude_code',
  source: 'claude_code',
  record_format: 'claude_jsonl@1',
  record_type: 'result',
  payload: {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 2000,
    duration_api_ms: 1800,
    num_turns: 1,
    total_cost_usd: 0.12,
    result: 'All tests pass.',
  },
}

describe('native session records', () => {
  it('renders native Claude replies through the CLI transcript and record listing', () => {
    const original = JSON.stringify(assistant)
    const store = new SessionTranscriptStore()
    store.ingest({ type: 'records_append', records: [assistant, result] })
    expect(chatTurnsToItems(store.chatTurns()).map((item) => item.text)).toEqual([
      'All tests pass.',
    ])
    expect(recordText(assistant)).toBe('All tests pass.')
    expect(recordText(result)).toBe('All tests pass.')
    expect(undisplayedRecordCount([assistant, result], 0)).toBe(0)
    expect(JSON.stringify(assistant)).toBe(original)
  })

  it('keeps the cost footer populated for native and archived Claude results', () => {
    const archived: SessionRecord = {
      ...envelope,
      kind: 'claude_sdk',
      source: 'claude_code',
      record_format: 'claude_sdk@1',
      record_type: 'result',
      payload: {
        kind: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1000,
        duration_api_ms: 800,
        num_turns: 1,
        cost_usd: 0.08,
      },
    }
    expect(foldRecordCosts([archived, result])).toMatchObject({
      total: 0.2,
      lastStep: 0.12,
    })
  })

  it('renders native Codex replies and ignores successful turn completion', () => {
    const reply: SessionRecord = {
      ...envelope,
      kind: 'codex_app_server',
      source: 'codex',
      record_format: 'codex_app_server@1',
      record_type: 'item/completed',
      payload: {
        method: 'item/completed',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_1',
          item: { type: 'agentMessage', id: 'message_1', text: 'Done.' },
        },
      },
    }
    const done: SessionRecord = {
      ...reply,
      id: 'record_2',
      feed_seq: 2,
      record_type: 'turn/completed',
      payload: {
        method: 'turn/completed',
        params: {
          threadId: 'thread_1',
          turn: { id: 'turn_1', status: 'completed', items: [] },
        },
      },
    }
    const store = new SessionTranscriptStore()
    store.ingest({ type: 'records_append', records: [reply, done] })
    expect(chatTurnsToItems(store.chatTurns()).map((item) => item.text)).toEqual([
      'Done.',
    ])
    expect(recordText(reply)).toBe('Done.')
    expect(undisplayedRecordCount([reply, done], 0)).toBe(0)
  })

  it('ignores native bookkeeping but still warns about unknown records from a known producer', () => {
    const system: SessionRecord = {
      ...assistant,
      record_type: 'system',
      payload: { type: 'system', subtype: 'init' },
    }
    const unknown: SessionRecord = {
      ...envelope,
      kind: 'unknown',
      source: 'claude_code',
      record_type: 'system',
      record_format: 'claude_jsonl@2',
      payload: { future: true },
    }
    expect(undisplayedRecordCount([system], 0)).toBe(0)
    expect(undisplayedRecordCount([system, unknown], 0)).toBe(1)
    expect(recordText(unknown)).toBe('{"future":true}')
  })
})

describe('budgetLines', () => {
  // Only the fields used by this read-only summary; policy and alert editing
  // remain outside the command's scope.
  const budget = (credit: number, spent: number): BudgetSummary =>
    ({
      as_of: '2026-09-10T12:00:00Z',
      credit_balance_usd: credit,
      credit_exhausted: credit <= 0,
      windows: [1, 7, 28].map((days) => ({
        window_days: days,
        spent_usd: spent,
        limit_usd: 10,
        remaining_usd: 10 - spent,
        fraction_used: spent / 10,
        exhausted: spent >= 10,
        platform_max_usd: 100,
      })),
    }) as BudgetSummary

  it('shows prepaid credit separately from every trailing budget window', () => {
    const lines = budgetLines(budget(25, 2.5))
    expect(lines[0]).toBe('credit:     $25.00')
    expect(lines).toContain('trailing 1 day: $2.50 of $10.00 (25.0%), $7.50 remaining')
    expect(lines).toContain('trailing 7 days: $2.50 of $10.00 (25.0%), $7.50 remaining')
    expect(lines).toContain('trailing 28 days: $2.50 of $10.00 (25.0%), $7.50 remaining')
  })

  it('preserves negative balances and flags exhausted credit and budgets', () => {
    const lines = budgetLines(budget(-0.25, 12))
    expect(lines[0]).toBe('credit:     $-0.25 (exhausted)')
    expect(lines).toContain(
      'trailing 1 day: $12.00 of $10.00 (120.0%), $-2.00 remaining (exhausted)',
    )
  })
})

describe('explicit harness requests', () => {
  it('preserves instructions and Codex options from an automation file', () => {
    const instructions = ['Keep changes small.', { file: 'AGENTS.md' }]
    expect(
      startRequestFromConfig({
        ellipsis: { name: 'Code helper' },
        session: {
          harness: { type: 'codex', model: 'gpt-6-astra', effort: 'high' },
          instructions,
          budget: { session: 2 },
        },
      }),
    ).toEqual({
      harness: { type: 'codex', model: 'gpt-6-astra', effort: 'high' },
      instructions,
      budget: 2,
    })
  })

  it('rejects legacy configs and overrides instead of dropping their instructions', () => {
    expect(() => startRequestFromConfig({ claude: { system: 'Do this.' } })).toThrow(
      /move system to instructions/,
    )
    expect(() => buildStartOverride({ override: 'claude:\n  system: Do this.' })).toThrow(
      /move system to instructions/,
    )
    expect(() => startRequestFromConfig({ instructions: 'Do this.' })).toThrow(
      /harness.type/,
    )
  })

  it('switches native options cleanly while keeping shared instructions', () => {
    const base = {
      harness: {
        type: 'claude_code' as const,
        model: 'claude-opus-5',
        max_turns: 5,
        effort: 'max' as const,
      },
      instructions: 'Keep changes small.',
    }
    const unchanged = applyComposerChoices(base, {
      environment: { kind: 'empty' },
      model: 'claude-fable-5',
      harness: 'claude_code',
    })
    expect(unchanged.harness).toEqual({ ...base.harness, model: 'claude-fable-5' })
    const changed = applyComposerChoices(base, {
      environment: { kind: 'empty' },
      model: 'gpt-6-astra',
      harness: 'codex',
    })
    expect(changed.harness).toEqual({ type: 'codex', model: 'gpt-6-astra' })
    expect(changed.instructions).toBe(base.instructions)
    expect(base.harness.max_turns).toBe(5)
  })

  it('keeps the certified harness and concrete model on a Codex default row', () => {
    const model: SupportedModel = {
      id: 'gpt-6-astra',
      display_name: 'GPT-6 Astra',
      harness: 'codex',
      capabilities: [],
      manufacturer: 'openai',
      is_default_agent_model: true,
      rate_card: {
        input_millicents_per_1m_tokens: 0,
        output_millicents_per_1m_tokens: 0,
        cache_write_5m_millicents_per_1m_tokens: 0,
        cache_write_1h_millicents_per_1m_tokens: 0,
        cache_read_millicents_per_1m_tokens: 0,
      },
    }
    const [row] = composerModelOptions([model])
    expect(row.id).toBeNull()
    expect(composerModelChoice(row)).toEqual({ harness: 'codex', model: 'gpt-6-astra' })
  })

  it('validates the harness flag and maps shared instructions separately', () => {
    expect(toHarness('codex')).toBe('codex')
    expect(() => toHarness('claude')).toThrow(/claude_code, codex/)
    expect(
      buildStartOverride({ harness: 'codex', model: 'gpt-6-astra', system: 'Be brief.' }),
    ).toEqual({
      harness: { type: 'codex', model: 'gpt-6-astra' },
      instructions: 'Be brief.',
    })
    expect(
      buildStartOverride({
        override:
          'harness:\n  type: claude_code\n  max_turns: 3\ninstructions: Keep this.',
        harness: 'codex',
        model: 'gpt-6-astra',
      }),
    ).toEqual({
      harness: { type: 'codex', model: 'gpt-6-astra' },
      instructions: 'Keep this.',
    })
  })
})
