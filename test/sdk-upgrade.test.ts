import { describe, expect, it } from 'vitest'
import type { SessionRecord } from '@ellipsis-dev/sdk'
import { budgetLines } from '../src/commands/usage'
import { recordText } from '../src/lib/steps'
import { buildStartOverride } from '../src/commands/session'
import { toHarness } from '../src/lib/args'
import { startRequestFromConfig } from '../src/lib/sessions'
import type { BudgetSummary } from '../src/lib/types'

const envelope = {
  id: 'record_1',
  session_id: 'session_1',
  turn_id: 'turn_1',
  session_message_id: null,
  created_at: '2026-09-10T12:00:00Z',
  feed_seq: 1,
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
  it('renders native Claude replies through the record listing', () => {
    const original = JSON.stringify(assistant)
    expect(recordText(assistant)).toBe('All tests pass.')
    expect(recordText(result)).toBe('All tests pass.')
    expect(JSON.stringify(assistant)).toBe(original)
  })

  it('renders native Codex replies', () => {
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
    expect(recordText(reply)).toBe('Done.')
  })

  it('falls back to the raw payload for an unknown record', () => {
    const unknown: SessionRecord = {
      ...envelope,
      kind: 'unknown',
      source: 'claude_code',
      record_type: 'system',
      record_format: 'claude_jsonl@2',
      payload: { future: true },
    }
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
  it('preserves the native prompt and Codex options from an automation file', () => {
    expect(startRequestFromConfig({
      ellipsis: { name: 'Code helper' },
      session: { codex: { model: 'gpt-6-astra', prompt: 'Keep changes small.', effort: 'high' }, budget: { session: 2 } },
    })).toEqual({ codex: { model: 'gpt-6-astra', prompt: 'Keep changes small.', effort: 'high' }, budget: 2 })
  })

  it('rejects retired configs and overrides instead of dropping instructions', () => {
    for (const config of [{ claude: { system: 'Do this.' } }, { harness: { type: 'claude_code' } }, { instructions: 'Do this.' }]) {
      expect(() => startRequestFromConfig(config)).toThrow(/no longer supported/)
      expect(() => buildStartOverride({ override: JSON.stringify(config) })).toThrow(/no longer supported/)
    }
    expect(() => startRequestFromConfig({})).toThrow(/exactly one/)
    expect(() => startRequestFromConfig({ claude_code: {}, codex: {} })).toThrow(/exactly one/)
    expect(() => buildStartOverride({ system: 'Be brief.' })).toThrow(/--system is no longer supported/)
  })

  it('validates the harness flag and replaces options on a switch', () => {
    expect(toHarness('codex')).toBe('codex')
    expect(() => toHarness('claude')).toThrow(/claude_code, codex/)
    expect(buildStartOverride({ harness: 'codex', model: 'gpt-6-astra' })).toEqual({ codex: { model: 'gpt-6-astra' } })
    expect(buildStartOverride({ override: 'claude_code:\n  max_turns: 3', harness: 'codex', model: 'gpt-6-astra' })).toEqual({ codex: { model: 'gpt-6-astra' } })
  })
})
