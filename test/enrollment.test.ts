import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  enrollRepo,
  enrolledRepos,
  isEnrolled,
  parseRepoFromRemoteUrl,
  unenrollRepo,
} from '../src/lib/enrollment'

describe('parseRepoFromRemoteUrl', () => {
  it('parses ssh remotes', () => {
    expect(parseRepoFromRemoteUrl('git@github.com:ellipsis-dev/cli.git')).toBe(
      'ellipsis-dev/cli',
    )
    expect(parseRepoFromRemoteUrl('git@github.com:ellipsis-dev/cli')).toBe(
      'ellipsis-dev/cli',
    )
  })

  it('parses https remotes', () => {
    expect(
      parseRepoFromRemoteUrl('https://github.com/ellipsis-dev/ellipsis.git'),
    ).toBe('ellipsis-dev/ellipsis')
    expect(parseRepoFromRemoteUrl('https://github.com/a/b\n')).toBe('a/b')
  })

  it('rejects unrecognizable urls', () => {
    expect(parseRepoFromRemoteUrl('/local/path/repo')).toBeUndefined()
    expect(parseRepoFromRemoteUrl('https://example.com/only-one-segment')).toBeUndefined()
  })
})

describe('enrollment set', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ellipsis-test-'))
    process.env.ELLIPSIS_CONFIG_DIR = dir
  })

  afterEach(() => {
    delete process.env.ELLIPSIS_CONFIG_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  it('enrolls, checks (case-insensitively), and unenrolls', () => {
    expect(enrolledRepos()).toEqual([])
    enrollRepo('ellipsis-dev/cli')
    enrollRepo('ellipsis-dev/cli') // idempotent
    expect(enrolledRepos()).toEqual(['ellipsis-dev/cli'])
    expect(isEnrolled('Ellipsis-Dev/CLI')).toBe(true)
    unenrollRepo('ELLIPSIS-DEV/cli')
    expect(isEnrolled('ellipsis-dev/cli')).toBe(false)
  })
})
