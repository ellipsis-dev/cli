import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { Option, type Command } from 'commander'
import { VERSION } from '../lib/constants'
import {
  compareVersions,
  fetchLatestVersion,
  installKind,
  isMusl,
  releaseTarget,
  replaceBinary,
} from '../lib/install'
import { writeUpdateState } from '../lib/update-check'

interface UpdateOptions {
  to?: string
  check?: boolean
  quiet?: boolean
}

export function registerUpdate(program: Command): void {
  program
    .command('update')
    .description('Update this CLI to the latest release')
    .option('--to <x.y.z>', 'install that release instead of the latest one (downgrades too)')
    .option('--check', 'report whether a newer release exists, without installing it')
    .addOption(
      // Used by the daily background check: record the answer, print nothing.
      new Option('--quiet', 'with --check: record the result and print nothing').hideHelp(),
    )
    .action(async (opts: UpdateOptions) => {
      try {
        if (opts.check) {
          await check(opts.quiet === true)
          return
        }
        await update(opts.to)
      } catch (err) {
        console.error(`update failed: ${(err as Error).message}`)
        process.exitCode = 1
      }
    })
}

async function check(quiet: boolean): Promise<void> {
  const latest = await fetchLatestVersion()
  writeUpdateState({ checkedAt: new Date().toISOString(), latest })
  if (quiet) return
  const cmp = compareVersions(latest, VERSION)
  if (cmp > 0) {
    console.log(`agent ${latest} is available (you have ${VERSION}). Run \`agent update\`.`)
  } else if (cmp === 0) {
    console.log(`agent ${VERSION} is the latest release.`)
  } else {
    console.log(`agent ${VERSION} is newer than the latest release (${latest}).`)
  }
}

async function update(to: string | undefined): Promise<void> {
  const execPath = realpathSync(process.execPath)
  const kind = installKind(execPath)
  if (kind === 'source') {
    throw new Error('agent is running from source; update only replaces an installed binary')
  }
  if (kind === 'homebrew') {
    throw new Error(
      'this agent was installed with Homebrew. Run `brew uninstall agent`, then reinstall with install.sh',
    )
  }
  const target = releaseTarget(process.platform, process.arch, isMusl())
  if (!target) {
    throw new Error(`no release build for ${process.platform}-${process.arch}`)
  }

  let version: string
  if (to) {
    version = to.replace(/^v/, '')
  } else {
    version = await fetchLatestVersion()
    writeUpdateState({ checkedAt: new Date().toISOString(), latest: version })
    const cmp = compareVersions(version, VERSION)
    if (cmp === 0) {
      console.log(`agent ${VERSION} is already the latest release.`)
      return
    }
    if (cmp < 0) {
      console.log(
        `agent ${VERSION} is newer than the latest release (${version}). Pass --to ${version} to downgrade.`,
      )
      return
    }
  }

  console.log(`Updating agent from ${VERSION} to ${version} (${target})...`)
  await replaceBinary(execPath, version, target)
  const reported = execFileSync(execPath, ['--version'], { stdio: 'pipe' }).toString().trim()
  console.log(`Updated agent to ${reported} at ${execPath}`)
}
