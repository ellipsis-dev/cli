// `agent hooks …` — install the Claude Code hooks that power laptop transcript
// sync, and manage per-repo enrollment (the consent gate `agent session sync`
// checks before uploading anything).

import type { Command } from 'commander'
import {
  claudeSettingsPath,
  installHooks,
  installedHookEvents,
  uninstallHooks,
} from '../lib/hooks'
import {
  enrollRepo,
  enrolledRepos,
  isEnrolled,
  repoForCwd,
  unenrollRepo,
} from '../lib/enrollment'
import { runAction } from '../lib/output'

// Resolve the repo argument: explicit "owner/name", else the cwd's remote.
function resolveRepoArg(repo?: string): string {
  if (repo) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Error(`"${repo}" is not an owner/name repo`)
    }
    return repo
  }
  const fromCwd = repoForCwd(process.cwd())
  if (!fromCwd) {
    throw new Error(
      'not inside a git repo with a recognizable GitHub remote — pass the repo explicitly (owner/name)',
    )
  }
  return fromCwd
}

export function registerHooks(program: Command): void {
  const hooks = program
    .command('hooks')
    .description('Claude Code hooks for syncing local session transcripts to Ellipsis')

  hooks
    .command('install')
    .description(
      'Install the Stop + SessionEnd hooks in ~/.claude/settings.json (and enroll the current repo)',
    )
    .option('--no-enroll', 'install the hooks without enrolling the current repo')
    .action(async (opts: { enroll?: boolean }) => {
      await runAction(async () => {
        const path = installHooks()
        console.log(`installed Stop + SessionEnd sync hooks in ${path}`)
        if (opts.enroll === false) return
        const repo = repoForCwd(process.cwd())
        if (!repo) {
          console.log(
            'no GitHub repo detected in the current directory — run `agent hooks enroll` inside each repo you want synced.',
          )
          return
        }
        if (isEnrolled(repo)) {
          console.log(`repo ${repo} is already enrolled for transcript sync`)
          return
        }
        enrollRepo(repo)
        console.log(
          `enrolled ${repo} for transcript sync — Claude Code sessions in this repo now sync to Ellipsis.`,
        )
      })
    })

  hooks
    .command('uninstall')
    .description('Remove the sync hooks from ~/.claude/settings.json (enrollment is kept)')
    .action(async () => {
      await runAction(async () => {
        const path = uninstallHooks()
        console.log(`removed sync hooks from ${path}`)
      })
    })

  hooks
    .command('status')
    .description('Show installed sync hooks and enrolled repos')
    .action(async () => {
      await runAction(async () => {
        const events = installedHookEvents()
        console.log(
          events.length > 0
            ? `hooks installed (${events.join(', ')}) in ${claudeSettingsPath()}`
            : `no sync hooks installed (run \`agent hooks install\`)`,
        )
        const repos = enrolledRepos()
        if (repos.length === 0) {
          console.log('no repos enrolled for transcript sync')
        } else {
          console.log('enrolled repos:')
          for (const repo of repos) console.log(`  ${repo}`)
        }
      })
    })

  hooks
    .command('enroll [repo]')
    .description('Enroll a repo (default: the current one) for transcript sync')
    .action(async (repo?: string) => {
      await runAction(async () => {
        const resolved = resolveRepoArg(repo)
        enrollRepo(resolved)
        console.log(`enrolled ${resolved} for transcript sync`)
      })
    })

  hooks
    .command('unenroll [repo]')
    .description('Stop syncing a repo (default: the current one)')
    .action(async (repo?: string) => {
      await runAction(async () => {
        const resolved = resolveRepoArg(repo)
        unenrollRepo(resolved)
        console.log(`unenrolled ${resolved} from transcript sync`)
      })
    })
}
