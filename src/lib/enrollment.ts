// Per-repo enrollment for laptop transcript sync.
//
// Consent is per-repo opt-in, never account-wide (LOCAL_CLAUDE_CODE.md §7.1):
// `agent session sync` resolves the cwd's git remote to an "owner/name" repo
// and silently no-ops unless that repo is in the enrolled set. The set lives in
// the CLI config file on the developer's machine — enrollment is a local,
// developer-owned decision, not server state.

import { execFileSync } from 'node:child_process'
import { loadConfig, saveConfig } from './config'

// Parse a git remote URL to "owner/name". Handles the two shapes GitHub
// actually emits: ssh (git@github.com:owner/name.git) and https
// (https://github.com/owner/name.git). Returns undefined for anything else —
// an unrecognized remote means "not enrolled", never a crash.
export function parseRepoFromRemoteUrl(url: string): string | undefined {
  const trimmed = url.trim().replace(/\.git$/, '')
  const ssh = trimmed.match(/^[\w.-]+@[\w.-]+:([\w.-]+\/[\w.-]+)$/)
  if (ssh) return ssh[1]
  const https = trimmed.match(/^https?:\/\/[\w.-]+\/([\w.-]+\/[\w.-]+)$/)
  if (https) return https[1]
  return undefined
}

// Resolve the repo ("owner/name") for a working directory via its `origin`
// remote. Undefined when the cwd isn't in a git repo, has no origin, or the
// remote URL isn't a recognizable GitHub-style URL.
export function repoForCwd(cwd: string): string | undefined {
  try {
    const url = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return parseRepoFromRemoteUrl(url)
  } catch {
    return undefined
  }
}

export function enrolledRepos(): string[] {
  return loadConfig().enrolledRepos ?? []
}

export function isEnrolled(repo: string): boolean {
  return enrolledRepos().some((r) => r.toLowerCase() === repo.toLowerCase())
}

export function enrollRepo(repo: string): void {
  const config = loadConfig()
  const repos = config.enrolledRepos ?? []
  if (!repos.some((r) => r.toLowerCase() === repo.toLowerCase())) {
    repos.push(repo)
  }
  saveConfig({ ...config, enrolledRepos: repos })
}

export function unenrollRepo(repo: string): void {
  const config = loadConfig()
  const repos = (config.enrolledRepos ?? []).filter(
    (r) => r.toLowerCase() !== repo.toLowerCase(),
  )
  saveConfig({ ...config, enrolledRepos: repos })
}
