// Reading the local checkout: which repo and branch the cwd is on, so
// commands can default their --repo to where they were run.

import { execFileSync } from 'node:child_process'

function git(cwd: string, ...args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}

// "owner/name" from a git remote URL (ssh or https, with or without .git).
export function repoFromRemoteUrl(url: string): string | undefined {
  const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/)
  return m ? `${m[1]}/${m[2]}` : undefined
}

export function repoFromCwd(cwd: string): string | undefined {
  const url = git(cwd, 'remote', 'get-url', 'origin')
  return url ? repoFromRemoteUrl(url) : undefined
}
