import type { Command } from 'commander'
import { printJson, printTable, runAction } from '../lib/output'
import {
  claudeSettingsPath,
  enrollRepo,
  enrolledRepos,
  hooksInstalled,
  installHooks,
  repoFromCwd,
  unenrollRepo,
  uninstallHooks,
} from '../lib/laptop'

// `agent hooks …` — manage the Claude Code hooks + per-repo enrollment that
// drive laptop transcript sync (`agent session sync`). Installing the hooks
// alone syncs nothing: consent is per-repo opt-in, so a repo must also be
// enrolled (`agent hooks enroll`, run inside the repo) before its sessions
// are captured.

// Resolve the repo to enroll/unenroll: an explicit "owner/name" arg wins,
// else derive it from the cwd's git remote.
function resolveRepo(explicit: string | undefined): string {
  if (explicit) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(explicit)) {
      throw new Error(`"${explicit}" is not an owner/name repository.`)
    }
    return explicit
  }
  const repo = repoFromCwd(process.cwd())
  if (!repo) {
    throw new Error(
      'Not inside a git repository with an origin remote. Run from the repo, or pass owner/name explicitly.',
    )
  }
  return repo
}

export function registerHooks(program: Command): void {
  const hooks = program
    .command('hooks')
    .description('Manage Claude Code hooks + repo enrollment for transcript sync')

  hooks
    .command('install')
    .description('Install the Stop + SessionEnd hooks that run `agent session sync`')
    .action(async () =>
      runAction(async () => {
        const { path } = installHooks()
        console.log(`Installed Stop + SessionEnd hooks in ${path}.`)
        const enrolled = enrolledRepos()
        if (enrolled.length === 0) {
          console.log(
            'No repositories enrolled yet — nothing will sync. Run `agent hooks enroll` inside a repo to opt it in.',
          )
        }
      }),
    )

  hooks
    .command('uninstall')
    .description('Remove the `agent session sync` hooks (enrollment is kept)')
    .action(async () =>
      runAction(async () => {
        const { path, changed } = uninstallHooks()
        console.log(
          changed ? `Removed sync hooks from ${path}.` : `No sync hooks found in ${path}.`,
        )
      }),
    )

  hooks
    .command('status')
    .description('Show hook installation + enrolled repositories')
    .option('--json', 'print JSON instead of text')
    .action(async (opts: { json?: boolean }) =>
      runAction(async () => {
        const installed = hooksInstalled()
        const enrolled = enrolledRepos()
        if (opts.json) {
          printJson({ settings: claudeSettingsPath(), hooks: installed, enrolled_repos: enrolled })
          return
        }
        printTable(
          ['HOOK', 'INSTALLED'],
          Object.entries(installed).map(([event, ok]) => [event, ok ? 'yes' : 'no']),
        )
        console.log('')
        if (enrolled.length === 0) console.log('Enrolled repositories: none')
        else printTable(['ENROLLED REPOSITORY'], enrolled.map((r) => [r]))
      }),
    )

  hooks
    .command('enroll [repo]')
    .description('Opt a repository (default: the cwd\'s origin) into transcript sync')
    .action(async (repo: string | undefined) =>
      runAction(async () => {
        const resolved = resolveRepo(repo)
        enrollRepo(resolved)
        console.log(`Enrolled ${resolved}. Claude Code sessions in this repo will sync.`)
        const installed = hooksInstalled()
        if (!installed.Stop || !installed.SessionEnd) {
          console.log('Hooks are not installed — run `agent hooks install` to start syncing.')
        }
      }),
    )

  hooks
    .command('unenroll [repo]')
    .description('Opt a repository back out of transcript sync')
    .action(async (repo: string | undefined) =>
      runAction(async () => {
        const resolved = resolveRepo(repo)
        unenrollRepo(resolved)
        console.log(`Unenrolled ${resolved}.`)
      }),
    )
}
