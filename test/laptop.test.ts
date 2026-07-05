import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeHookStats,
  hookStatsPath,
  readHookStats,
  readSyncLog,
  recordSyncOutcome,
  spooledPendingCount,
  syncLogPath,
  type HookSyncStats,
  type SyncLogEntry,
} from '../src/lib/laptop'

// Each test gets a throwaway ELLIPSIS_CONFIG_DIR so the hook activity log and
// stats object are written to a known place, never the real ~/.config.
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ellipsis-hooks-'))
  process.env.ELLIPSIS_CONFIG_DIR = dir
})

afterEach(() => {
  delete process.env.ELLIPSIS_CONFIG_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('recordSyncOutcome / readSyncLog', () => {
  it('appends one JSONL entry per attempt with a timestamp', () => {
    recordSyncOutcome({ outcome: 'synced', cc_session_id: 'cc1', repo: 'o/r', reason: 'stop', session_id: 's1', event_count: 3 })
    recordSyncOutcome({ outcome: 'spooled', cc_session_id: 'cc2', repo: 'o/r', reason: 'session_end', error: 'fetch failed' })
    const entries = readSyncLog()
    expect(entries).toHaveLength(2)
    expect(entries[0].outcome).toBe('synced')
    expect(entries[0].session_id).toBe('s1')
    expect(entries[1].outcome).toBe('spooled')
    expect(entries[1].error).toBe('fetch failed')
    expect(Date.parse(entries[0].ts)).not.toBeNaN()
  })

  it('skips torn lines instead of failing', () => {
    recordSyncOutcome({ outcome: 'synced', session_id: 's1' })
    writeFileSync(syncLogPath(), readFileSync(syncLogPath(), 'utf8') + '{"truncat')
    expect(readSyncLog()).toHaveLength(1)
  })

  it('returns [] when nothing has been logged', () => {
    expect(readSyncLog()).toEqual([])
    expect(readHookStats()).toBeUndefined()
  })
})

describe('stats object', () => {
  it('is rewritten on every attempt and readable as plain JSON', () => {
    recordSyncOutcome({ outcome: 'synced', session_id: 's1', event_count: 2 })
    recordSyncOutcome({ outcome: 'rejected', error: 'boom' })
    expect(existsSync(hookStatsPath())).toBe(true)
    const stats = JSON.parse(readFileSync(hookStatsPath(), 'utf8')) as HookSyncStats
    expect(stats.last_outcome).toBe('rejected')
    expect(stats.last_error).toBe('boom')
    expect(stats.synced_24h).toBe(1)
    expect(stats.failed_24h).toBe(1)
    expect(stats.total_synced).toBe(1)
    expect(stats.recent_session_ids).toEqual(['s1'])
    expect(readHookStats()).toEqual(stats)
  })

  it('does not count skipped_unenrolled as a failure', () => {
    recordSyncOutcome({ outcome: 'skipped_unenrolled', error: 'not enrolled' })
    const stats = readHookStats()
    expect(stats?.failed_24h).toBe(0)
    expect(stats?.synced_24h).toBe(0)
    expect(stats?.last_outcome).toBe('skipped_unenrolled')
  })

  it('carries total_synced forward across writes', () => {
    recordSyncOutcome({ outcome: 'synced', session_id: 's1' })
    recordSyncOutcome({ outcome: 'synced', session_id: 's2' })
    recordSyncOutcome({ outcome: 'spooled', error: 'offline' })
    expect(readHookStats()?.total_synced).toBe(2)
  })
})

describe('computeHookStats', () => {
  const entry = (over: Partial<SyncLogEntry>): SyncLogEntry => ({
    ts: new Date().toISOString(),
    outcome: 'synced',
    ...over,
  })

  it('windows 24h counts and dedupes recent session ids (newest first)', () => {
    const now = new Date('2026-07-05T12:00:00Z')
    const old = '2026-07-01T12:00:00Z'
    const fresh = '2026-07-05T11:00:00Z'
    const stats = computeHookStats(
      [
        entry({ ts: old, session_id: 'old' }),
        entry({ ts: fresh, session_id: 'a' }),
        entry({ ts: fresh, session_id: 'a' }),
        entry({ ts: fresh, outcome: 'rejected', error: 'nope' }),
        entry({ ts: fresh, session_id: 'b' }),
      ],
      7,
      now,
    )
    expect(stats.synced_24h).toBe(3)
    expect(stats.failed_24h).toBe(1)
    expect(stats.total_synced).toBe(7)
    expect(stats.recent_session_ids).toEqual(['b', 'a', 'old'])
    expect(stats.last_outcome).toBe('synced')
    expect(stats.last_error).toBe('nope')
  })

  it('counts pending spool files', () => {
    mkdirSync(join(dir, 'spool'), { recursive: true })
    writeFileSync(join(dir, 'spool', 'cc1.json'), '{}')
    writeFileSync(join(dir, 'spool', 'ignored.txt'), '')
    expect(spooledPendingCount()).toBe(1)
    expect(computeHookStats([], 0).spooled_pending).toBe(1)
  })
})
