import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildCreateRequest,
  formatFinding,
  parsePullRequest,
  splitRepo,
} from '../src/commands/review'
import { currentBranch, reviewBranchName } from '../src/lib/laptop'
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

  it('forwards the config, model, and budget overrides', () => {
    const req = buildCreateRequest('1', {
      ...START_DEFAULTS,
      repo: 'o/r',
      config: 'agent_abc',
      model: 'claude-opus-4-8',
      budget: 5,
    })
    expect(req.config_id).toBe('agent_abc')
    expect(req.model).toBe('claude-opus-4-8')
    expect(req.budget).toBe(5)
  })

  it('posts by default, and --no-post turns it off', () => {
    expect(buildCreateRequest('1', { ...START_DEFAULTS, repo: 'o/r' }).post).toBe(true)
    expect(
      buildCreateRequest('1', { ...START_DEFAULTS, repo: 'o/r', post: false }).post,
    ).toBe(false)
  })
})

describe('buildCreateRequest — the local path', () => {
  it('pushes a sidecar branch and pins the range end to the pushed commit', () => {
    const { work: cwd, remote } = scratchRepo('feature/thing')
    writeFileSync(join(cwd, 'a.txt'), 'dirty\n')

    const req = buildCreateRequest(undefined, { ...START_DEFAULTS, cwd })

    // The sidecar, never the branch you're working on.
    expect(req.branch).toBe('ellipsis/review/feature/thing')
    expect(currentBranch(cwd)).toBe('feature/thing')
    // The pushed snapshot pins the head: GitHub's reported PR head lags a
    // force-push to the sidecar.
    expect(req.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(req.pull_request_number).toBeUndefined()
    // The commit really landed on the remote (read the bare repo directly —
    // the fetch URL is a real GitHub URL this test can't reach).
    const pushed = execFileSync('git', ['-C', remote, 'show-ref'], {
      encoding: 'utf8',
    })
    expect(pushed).toContain('refs/heads/ellipsis/review/feature/thing')
  })

  it('never posts a local review, even without --no-post', () => {
    const { work: cwd } = scratchRepo()
    // Reviewing unfinished work must not leave comments on a pull request, so
    // the terminal-only default does not depend on the caller remembering.
    expect(buildCreateRequest(undefined, { ...START_DEFAULTS, cwd }).post).toBe(false)
  })

  it('snapshots a clean tree too (HEAD), so a review needs no dirty edit', () => {
    const { work: cwd } = scratchRepo()
    const head = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    expect(buildCreateRequest(undefined, { ...START_DEFAULTS, cwd }).sha).toBe(head)
  })

  it('reviews an already-pushed branch without touching git', () => {
    const { work: cwd } = scratchRepo()
    const req = buildCreateRequest(undefined, {
      ...START_DEFAULTS,
      cwd,
      branch: 'someone/elses-branch',
    })
    expect(req.branch).toBe('someone/elses-branch')
    // Nothing was pushed, so there is no snapshot SHA to pin.
    expect(req.sha).toBeUndefined()
  })

  it('explains itself on a detached HEAD instead of guessing a branch', () => {
    const { work: cwd } = scratchRepo()
    execFileSync('git', ['-C', cwd, 'checkout', '--detach'], { stdio: 'ignore' })
    expect(() => buildCreateRequest(undefined, { ...START_DEFAULTS, cwd })).toThrow(
      /detached HEAD/,
    )
  })

  it('needs a repo when there is no git remote to infer one from', () => {
    expect(() =>
      buildCreateRequest(undefined, { ...START_DEFAULTS, cwd: mkdtempSync(join(tmpdir(), 'bare-')) }),
    ).toThrow(/--repo/)
  })
})

describe('reviewBranchName', () => {
  it('prefixes the sidecar so it is obvious what it is in a branch list', () => {
    expect(reviewBranchName('hunter/my-feature')).toBe('ellipsis/review/hunter/my-feature')
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
