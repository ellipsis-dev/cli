import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { USER_AGENT } from './constants'

// How the CLI is installed and kept current without a package manager. The
// release workflow publishes one tarball per target plus checksums.txt to
// GitHub Releases. install.sh (the first install) and `ellipsis update` (every
// later one) both download from there and verify the SHA-256 before swapping
// the binary in. The pure helpers come first so test/install.test.ts can cover
// them without touching the network or the disk.

export const RELEASES_BASE = 'https://github.com/ellipsis-dev/cli/releases'
export const BINARY_NAME = 'ellipsis'
// The short alias install.sh links next to the binary (`el` -> `ellipsis`).
export const ALIAS_NAME = 'el'

// The comment install.sh appends to the PATH line it writes into a shell
// startup file. `ellipsis uninstall` deletes exactly the lines carrying it, so
// the two must stay identical (test/install.test.ts checks).
export const PATH_MARKER = 'Ellipsis CLI installer'

// Every target release.yml builds (test/install.test.ts checks the workflow).
export const RELEASE_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
  'linux-x64-musl',
  'linux-arm64-musl',
] as const
export type ReleaseTarget = (typeof RELEASE_TARGETS)[number]

// Map Node's platform and arch names onto a release target, or undefined when
// no build exists for this machine.
export function releaseTarget(
  platform: string,
  arch: string,
  musl = false,
): ReleaseTarget | undefined {
  const os = platform === 'darwin' || platform === 'linux' ? platform : undefined
  const cpu = arch === 'x64' || arch === 'arm64' ? arch : undefined
  if (!os || !cpu) return undefined
  const name = `${os}-${cpu}${os === 'linux' && musl ? '-musl' : ''}`
  return (RELEASE_TARGETS as readonly string[]).includes(name) ? (name as ReleaseTarget) : undefined
}

export function tarballName(target: ReleaseTarget): string {
  return `${BINARY_NAME}-${target}.tar.gz`
}

// Asset URLs for one release, or for whatever GitHub currently calls latest.
// The latest redirect needs no API call, so CI never hits a rate limit.
export function releaseUrls(
  version: string | undefined,
  target: ReleaseTarget,
): { tarball: string; checksums: string } {
  const base = version
    ? `${RELEASES_BASE}/download/v${version}`
    : `${RELEASES_BASE}/latest/download`
  return { tarball: `${base}/${tarballName(target)}`, checksums: `${base}/checksums.txt` }
}

// checksums.txt is `sha256sum` output: one `<hex>  <file>` line per asset.
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim())
    if (m) out.set(m[2], m[1].toLowerCase())
  }
  return out
}

// Numeric compare of x.y.z strings (a leading v is ignored): negative when a
// is older than b, zero when equal, positive when a is newer.
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, '')
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

// GitHub answers /releases/latest with a redirect to /releases/tag/v<x.y.z>;
// the version is the tail of that URL.
export function versionFromReleaseUrl(url: string): string | undefined {
  const m = /\/tag\/v?(\d+\.\d+\.\d+)\/?$/.exec(url)
  return m?.[1]
}

// Drop the lines install.sh added to a startup file, and nothing else. The
// installer wrote a blank line before its own, so that goes too: repeated
// install and uninstall cycles must not grow the file.
export function stripInstallerLines(content: string): string {
  const lines = content.split('\n')
  if (!lines.some((line) => line.includes(PATH_MARKER))) return content
  const out: string[] = []
  for (const line of lines) {
    if (line.includes(PATH_MARKER)) {
      if (out.length > 0 && out[out.length - 1] === '') out.pop()
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

// Where the running executable came from decides what update and uninstall
// may do: only a binary the installer put down is theirs to replace or delete.
export type InstallKind = 'binary' | 'source' | 'homebrew'

export function installKind(execPath: string): InstallKind {
  const name = basename(execPath).replace(/\.exe$/i, '')
  if (['node', 'bun', 'bun-profile', 'tsx'].includes(name)) return 'source'
  if (execPath.includes('/Cellar/')) return 'homebrew'
  return 'binary'
}

// Every startup file install.sh may have written; uninstall scans them all.
export function startupFiles(home: string): string[] {
  return [
    join(home, '.zshrc'),
    join(home, '.bashrc'),
    join(home, '.bash_profile'),
    join(home, '.bash_login'),
    join(home, '.profile'),
    join(home, '.config', 'fish', 'config.fish'),
  ]
}

// ---- everything below touches the machine or the network ------------------

// musl (Alpine and friends) needs its own build; its dynamic loader is the tell.
export function isMusl(): boolean {
  if (process.platform !== 'linux') return false
  try {
    return readdirSync('/lib').some((f) => /^ld-musl-.*\.so\.1$/.test(f))
  } catch {
    return false
  }
}

export async function fetchLatestVersion(): Promise<string> {
  const res = await fetch(`${RELEASES_BASE}/latest`, {
    method: 'HEAD',
    redirect: 'manual',
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  })
  const location = res.headers.get('location') ?? res.url
  const version = versionFromReleaseUrl(location)
  if (!version) {
    throw new Error(
      `could not read the latest version from ${RELEASES_BASE}/latest (HTTP ${res.status})`,
    )
  }
  return version
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(180_000),
  })
  if (!res.ok) throw new Error(`download failed: ${url} (HTTP ${res.status})`)
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// Download release `version` for `target`, verify it, and swap it in over the
// running executable. The new file is staged in the same directory so the
// final rename is atomic: the old binary is never left half written.
export async function replaceBinary(
  execPath: string,
  version: string,
  target: ReleaseTarget,
): Promise<void> {
  const urls = releaseUrls(version, target)
  const name = tarballName(target)
  const work = mkdtempSync(join(tmpdir(), `${BINARY_NAME}-update-`))
  const staged = join(dirname(execPath), `.${BINARY_NAME}.update.${process.pid}`)
  try {
    await downloadTo(urls.checksums, join(work, 'checksums.txt'))
    await downloadTo(urls.tarball, join(work, name))
    const expected = parseChecksums(readFileSync(join(work, 'checksums.txt'), 'utf8')).get(name)
    if (!expected) throw new Error(`checksums.txt for ${version} has no entry for ${name}`)
    const actual = sha256File(join(work, name))
    if (actual !== expected) {
      throw new Error(`checksum mismatch for ${name}: expected ${expected}, got ${actual}`)
    }
    execFileSync('tar', ['-xzf', join(work, name), '-C', work], { stdio: 'pipe' })
    const extracted = join(work, BINARY_NAME)
    if (!existsSync(extracted)) throw new Error(`${name} does not contain ${BINARY_NAME}`)
    copyFileSync(extracted, staged)
    chmodSync(staged, 0o755)
    renameSync(staged, execPath)
  } finally {
    rmSync(work, { recursive: true, force: true })
    rmSync(staged, { force: true })
  }
}
