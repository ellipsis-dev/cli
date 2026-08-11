import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  buildCreateRequest,
  formatFinding,
  parsePullRequest,
  splitRepo,
  starterPipeline,
} from '../src/commands/review'
import type { Finding } from '../src/lib/types'

// A throwaway repo with an origin remote, so the local path's git work runs for
// real instead of being mocked. The "remote" is a bare repo on disk — good
// enough for `push` and for repoFromCwd's remote parsing.
function scratchRepo(branch = 'feature/thing'): { work: string; remote: string } {
  const root = mkdtempSync(join(tmpdir(), 'agent-review-'))
  const remote = join(root, 'remote.git')
  const work = join(root, 'work')
  execFileSync('git', ['init', '--bare', '-b', 'main', remote])
  execFileSync('git', ['init', '-b', 'main', work])
  const git = (...args: string[]) => execFileSync('git', ['-C', work, ...args])
  git('config', 'user.email', 'ci@example.com')
  git('config', 'user.name', 'ci')
  // An https URL so repoFromCwd resolves owner/name; the push target is set
  // separately below, since that URL isn't reachable.
  git('remote', 'add', 'origin', 'https://github.com/ellipsis-dev/scratch.git')
  git('remote', 'set-url', '--push', 'origin', remote)
  writeFileSync(join(work, 'a.txt'), 'one\n')
  git('add', '.')
  git('commit', '-m', 'first')
  git('checkout', '-b', branch)
  return { work, remote }
}

const START_DEFAULTS = { post: true, wait: true, json: false }

describe('buildCreateRequest — an existing pull request', () => {
  it('sends owner and repo as separate fields, never owner/name', () => {
    const req = buildCreateRequest('5975', {
      ...START_DEFAULTS,
      repo: 'ellipsis-dev/ellipsis',
    })
    expect(req.owner).toBe('ellipsis-dev')
    expect(req.repo).toBe('ellipsis')
    expect(req.pull_request_number).toBe(5975)
    expect(req.branch).toBeUndefined()
  })

  it('defaults to incremental — only the commits since the last review', () => {
    const req = buildCreateRequest('1', { ...START_DEFAULTS, repo: 'o/r' })
    expect(req.scope.kind).toBe('incremental')
  })

  it('--full re-reviews the whole pull request', () => {
    const req = buildCreateRequest('1', { ...START_DEFAULTS, repo: 'o/r', full: true })
    expect(req.scope.kind).toBe('full')
  })

  it('passes a pinned range through as SHAs', () => {
    const req = buildCreateRequest('1', {
      ...START_DEFAULTS,
      repo: 'o/r',
      watermark: 'aaaa111',
      head: 'bbbb222',
    })
    expect(req.scope.watermark).toBe('aaaa111')
    expect(req.scope.head).toBe('bbbb222')
  })

  it('posts by default, and --no-post turns it off', () => {
    expect(buildCreateRequest('1', { ...START_DEFAULTS, repo: 'o/r' }).post).toBe(true)
    expect(
      buildCreateRequest('1', { ...START_DEFAULTS, repo: 'o/r', post: false }).post,
    ).toBe(false)
  })
})

describe('buildCreateRequest — repository resolution', () => {
  it('needs a repo when there is no git remote to infer one from', () => {
    expect(() =>
      buildCreateRequest('123', { ...START_DEFAULTS, cwd: mkdtempSync(join(tmpdir(), 'bare-')) }),
    ).toThrow(/--repo/)
  })
})

describe('parsePullRequest', () => {
  it('accepts the three spellings people paste', () => {
    expect(parsePullRequest('5975')).toBe(5975)
    expect(parsePullRequest('#5975')).toBe(5975)
    expect(parsePullRequest('https://github.com/ellipsis-dev/ellipsis/pull/5975')).toBe(5975)
  })

  it('teaches the fix when `review` swallowed a bare prompt', () => {
    // `agent review the auth changes` reaches here because the verb reserves
    // the word — the error has to name the quoted form.
    expect(() => parsePullRequest('the')).toThrow(/quote it/)
  })
})

describe('splitRepo', () => {
  it('rejects anything that is not exactly owner/name', () => {
    expect(splitRepo('o/r')).toEqual({ owner: 'o', name: 'r' })
    expect(() => splitRepo('just-a-name')).toThrow(/owner\/name/)
    expect(() => splitRepo('a/b/c')).toThrow(/owner\/name/)
  })
})

describe('formatFinding', () => {
  const base: Finding = {
    path: 'src/auth.py',
    start_line: 42,
    end_line: 42,
    side: 'RIGHT',
    severity: 4,
    category: 'security',
    claim: 'Missing authz check.',
    evidence: '',
    suggested_fix: null,
    confidence: null,
    extra: {},
    anchor: 'valid',
    snapped_from: null,
    in_scope: true,
  }

  it('leads with a greppable path:line and the severity', () => {
    expect(formatFinding(base)).toContain('src/auth.py:42  [4/5 security]')
  })

  it('renders a multi-line anchor as a range', () => {
    expect(formatFinding({ ...base, end_line: 48 })).toContain('src/auth.py:42-48')
  })

  it('includes the evidence and the suggested fix', () => {
    const out = formatFinding({
      ...base,
      evidence: 'no membership assert',
      suggested_fix: 'assert_membership(user)',
    })
    expect(out).toContain('no membership assert')
    expect(out).toContain('assert_membership(user)')
  })

  it('flags a finding that was recorded but never posted inline', () => {
    const out = formatFinding({ ...base, anchor: 'not_commentable' })
    expect(out).toContain('outside the diff')
  })
})

describe('starterPipeline', () => {
  it('marks the file as a pipeline, not an agent', () => {
    expect(starterPipeline('cli code review')).toContain('kind: code_review')
  })

  it('parses as YAML and only sets keys the schema allows', () => {
    const parsed = parse(starterPipeline('cli code review')) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['budget', 'ellipsis'])
    expect(parsed.ellipsis).toMatchObject({ version: 'v1', kind: 'code_review' })
  })

  // Location is the scope now, so naming repositories is a sync error anywhere
  // but the org-wide copy — the scaffold must never emit the key.
  it('omits pull_requests.repositories, which would be a sync error', () => {
    expect(starterPipeline('cli code review')).not.toContain('repositories:')
  })

  // Deleted from the schema, which forbids unknown keys.
  it('omits include_default_reviewers', () => {
    expect(starterPipeline('cli code review')).not.toContain('include_default_reviewers')
  })

  it('names the pipeline so a reader knows what it covers', () => {
    const parsed = parse(starterPipeline('backend code review')) as {
      ellipsis: { name: string }
    }
    expect(parsed.ellipsis.name).toBe('backend code review')
  })

  it('documents both legal paths and no others', () => {
    const text = starterPipeline('cli code review')
    expect(text).toContain('code_review.yaml')
    expect(text).toContain('.ellipsis/code_review.yaml')
    expect(text).not.toContain('agents/')
  })
})
