// Spool-and-retry for laptop transcript sync (LOCAL_CLAUDE_CODE.md §7.1).
//
// A sync that fails for network-ish reasons is written to a spool directory
// (one file per CC session — every sync is a whole snapshot, so the latest
// payload supersedes any earlier spooled one) and re-attempted opportunistically
// before the next successful sync. 4xx rejections are never spooled: they will
// not succeed on retry.

import { join } from 'node:path'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import type { ApiClient } from './api'
import { ApiError } from './api'
import type { SyncSessionRequest } from './types'

// Keep the spool bounded: a laptop that is offline for a long stretch should
// not accumulate unbounded transcript snapshots.
const MAX_SPOOLED = 50

function spoolDir(): string {
  const base =
    process.env.ELLIPSIS_CONFIG_DIR ?? join(homedir(), '.config', 'ellipsis')
  return join(base, 'spool')
}

export function spoolSync(payload: SyncSessionRequest): void {
  const dir = spoolDir()
  mkdirSync(dir, { recursive: true })
  // One file per CC session: the latest snapshot supersedes earlier ones.
  const safeName = payload.cc_session_id.replace(/[^A-Za-z0-9._-]/g, '_')
  writeFileSync(join(dir, `${safeName}.json`), JSON.stringify(payload), {
    mode: 0o600,
  })
  // Evict oldest beyond the cap.
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime)
  for (const { f } of files.slice(0, Math.max(0, files.length - MAX_SPOOLED))) {
    rmSync(join(dir, f), { force: true })
  }
}

// Retry every spooled sync. A 4xx drops the file (it will never succeed); any
// other failure stops the flush — the network is likely still down, and the
// next sync retries again. Returns how many spooled syncs were delivered.
export async function flushSpool(api: ApiClient): Promise<number> {
  const dir = spoolDir()
  if (!existsSync(dir)) return 0
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
  let delivered = 0
  for (const f of files) {
    const path = join(dir, f)
    let payload: SyncSessionRequest
    try {
      payload = JSON.parse(readFileSync(path, 'utf8')) as SyncSessionRequest
    } catch {
      rmSync(path, { force: true })
      continue
    }
    try {
      await api.syncSession(payload)
      rmSync(path, { force: true })
      delivered += 1
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) {
        rmSync(path, { force: true })
        continue
      }
      break
    }
  }
  return delivered
}
