import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ALIAS_NAME,
  compareVersions,
  installKind,
  parseChecksums,
  PATH_MARKER,
  RELEASE_TARGETS,
  releaseTarget,
  releaseUrls,
  stripInstallerLines,
  versionFromReleaseUrl,
} from '../src/lib/install'
import { checkIsDue, updateNudge } from '../src/lib/update-check'

const repoFile = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

describe('releaseTarget', () => {
  it('maps node platform and arch names onto the published targets', () => {
    expect(releaseTarget('darwin', 'arm64')).toBe('darwin-arm64')
    expect(releaseTarget('darwin', 'x64')).toBe('darwin-x64')
    expect(releaseTarget('linux', 'x64')).toBe('linux-x64')
    expect(releaseTarget('linux', 'arm64')).toBe('linux-arm64')
  })

  it('picks the musl build only on linux', () => {
    expect(releaseTarget('linux', 'x64', true)).toBe('linux-x64-musl')
    expect(releaseTarget('linux', 'arm64', true)).toBe('linux-arm64-musl')
    expect(releaseTarget('darwin', 'arm64', true)).toBe('darwin-arm64')
  })

  it('returns undefined where nothing is built', () => {
    expect(releaseTarget('win32', 'x64')).toBeUndefined()
    expect(releaseTarget('linux', 'ia32')).toBeUndefined()
  })
})

describe('releaseUrls', () => {
  it('pins a version under /download/v<version>', () => {
    expect(releaseUrls('2.30.0', 'linux-x64')).toEqual({
      tarball: 'https://github.com/ellipsis-dev/cli/releases/download/v2.30.0/ellipsis-linux-x64.tar.gz',
      checksums: 'https://github.com/ellipsis-dev/cli/releases/download/v2.30.0/checksums.txt',
    })
  })

  it('uses the latest redirect when no version is given, so no API call is needed', () => {
    expect(releaseUrls(undefined, 'darwin-arm64').tarball).toBe(
      'https://github.com/ellipsis-dev/cli/releases/latest/download/ellipsis-darwin-arm64.tar.gz',
    )
  })
})

describe('parseChecksums', () => {
  it('reads sha256sum output into a name to digest map', () => {
    const a = 'a'.repeat(64)
    const b = 'B'.repeat(64)
    const text = `${a}  ellipsis-linux-x64.tar.gz\n${b} *ellipsis-darwin-arm64.tar.gz\n\nnot a checksum line\n`
    const sums = parseChecksums(text)
    expect(sums.get('ellipsis-linux-x64.tar.gz')).toBe(a)
    expect(sums.get('ellipsis-darwin-arm64.tar.gz')).toBe('b'.repeat(64))
    expect(sums.size).toBe(2)
  })
})

describe('compareVersions', () => {
  it('orders numerically per component', () => {
    expect(compareVersions('2.31.0', '2.30.0')).toBeGreaterThan(0)
    expect(compareVersions('2.30.10', '2.30.9')).toBeGreaterThan(0)
    expect(compareVersions('3.0.0', '2.99.99')).toBeGreaterThan(0)
    expect(compareVersions('2.29.0', '2.30.0')).toBeLessThan(0)
  })

  it('treats a leading v and a missing component as nothing', () => {
    expect(compareVersions('v2.30.0', '2.30.0')).toBe(0)
    expect(compareVersions('2.30', '2.30.0')).toBe(0)
  })
})

describe('versionFromReleaseUrl', () => {
  it('reads the tag off the latest redirect', () => {
    expect(versionFromReleaseUrl('https://github.com/ellipsis-dev/cli/releases/tag/v2.30.0')).toBe(
      '2.30.0',
    )
    expect(versionFromReleaseUrl('https://github.com/ellipsis-dev/cli/releases/tag/2.30.0/')).toBe(
      '2.30.0',
    )
  })

  it('returns undefined when the URL is not a tag page', () => {
    expect(versionFromReleaseUrl('https://github.com/ellipsis-dev/cli/releases')).toBeUndefined()
    expect(versionFromReleaseUrl('')).toBeUndefined()
  })
})

describe('stripInstallerLines', () => {
  const line = `export PATH="$HOME/.local/bin:$PATH" # ${PATH_MARKER}`

  it('removes the installer line and the blank line written before it', () => {
    const before = `alias ll='ls -l'\n\n${line}\n`
    expect(stripInstallerLines(before)).toBe(`alias ll='ls -l'\n`)
  })

  it('keeps everything else, including blank lines that are not ours', () => {
    const before = `a\n\n\n${line}\nb\n\nc\n`
    expect(stripInstallerLines(before)).toBe(`a\n\nb\n\nc\n`)
  })

  it('returns the content untouched when there is nothing to remove', () => {
    const before = `export PATH="$HOME/bin:$PATH"\n`
    expect(stripInstallerLines(before)).toBe(before)
  })

  it('handles a file whose last line is ours and has no trailing newline', () => {
    expect(stripInstallerLines(`a\n${line}`)).toBe('a')
  })
})

describe('installKind', () => {
  it('recognises a source run by the runtime name', () => {
    expect(installKind('/usr/local/bin/node')).toBe('source')
    expect(installKind('/Users/me/.bun/bin/bun')).toBe('source')
  })

  it('recognises a Homebrew cellar path', () => {
    expect(installKind('/opt/homebrew/Cellar/agent/2.30.0/bin/agent')).toBe('homebrew')
    expect(installKind('/home/linuxbrew/.linuxbrew/Cellar/agent/2.30.0/bin/agent')).toBe('homebrew')
  })

  it('treats anything else as an installed binary', () => {
    expect(installKind('/Users/me/.local/bin/ellipsis')).toBe('binary')
    expect(installKind('/usr/local/bin/ellipsis')).toBe('binary')
  })
})

describe('checkIsDue', () => {
  const now = new Date('2026-09-25T12:00:00Z')

  it('is due with no record, a stale record, or a broken one', () => {
    expect(checkIsDue(undefined, now)).toBe(true)
    expect(checkIsDue({ checkedAt: '2026-09-24T11:00:00Z' }, now)).toBe(true)
    expect(checkIsDue({ checkedAt: 'garbage' }, now)).toBe(true)
  })

  it('is not due within a day of the last check', () => {
    expect(checkIsDue({ checkedAt: '2026-09-25T01:00:00Z' }, now)).toBe(false)
  })
})

describe('updateNudge', () => {
  it('names both versions when the remembered latest is newer', () => {
    const msg = updateNudge({ checkedAt: 'x', latest: '2.31.0' }, '2.30.0')
    expect(msg).toContain('2.31.0')
    expect(msg).toContain('2.30.0')
    expect(msg).toContain('ellipsis update')
  })

  it('stays quiet when there is nothing newer', () => {
    expect(updateNudge(undefined, '2.30.0')).toBeUndefined()
    expect(updateNudge({ checkedAt: 'x' }, '2.30.0')).toBeUndefined()
    expect(updateNudge({ checkedAt: 'x', latest: '2.30.0' }, '2.30.0')).toBeUndefined()
    expect(updateNudge({ checkedAt: 'x', latest: '2.29.0' }, '2.30.0')).toBeUndefined()
  })
})

// The shell installer and the release workflow are not TypeScript, so the
// constants they share with the binary are checked here instead.
describe('install.sh and release.yml agree with the binary', () => {
  it('install.sh writes the same PATH marker uninstall looks for', () => {
    expect(repoFile('install.sh')).toContain(`PATH_MARKER="${PATH_MARKER}"`)
  })

  it('install.sh links the same alias name uninstall removes', () => {
    expect(repoFile('install.sh')).toContain(`ALIAS="${ALIAS_NAME}"`)
  })

  it('release.yml builds exactly the targets the binary knows about', () => {
    const workflow = repoFile('.github/workflows/release.yml')
    const loops = [...workflow.matchAll(/for t in ([^;]+); do/g)].map((m) =>
      m[1].split(/\s+/).filter(Boolean).sort(),
    )
    expect(loops.length).toBeGreaterThan(0)
    for (const targets of loops) expect(targets).toEqual([...RELEASE_TARGETS].sort())
  })
})
