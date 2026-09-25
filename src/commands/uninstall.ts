import { existsSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { Command } from 'commander'
import { configDir } from '../lib/config'
import { installKind, startupFiles, stripInstallerLines } from '../lib/install'

interface UninstallOptions {
  purge?: boolean
}

export function registerUninstall(program: Command): void {
  program
    .command('uninstall')
    .description('Remove this CLI from the machine (add --purge to delete ~/.ellipsis too)')
    .option('--purge', 'also delete the config dir, with every host and stored credential')
    .action((opts: UninstallOptions) => {
      try {
        uninstall(opts.purge === true)
      } catch (err) {
        console.error(`uninstall failed: ${(err as Error).message}`)
        process.exitCode = 1
      }
    })
}

function uninstall(purge: boolean): void {
  const execPath = realpathSync(process.execPath)
  const kind = installKind(execPath)
  if (kind === 'source') {
    throw new Error('agent is running from source; uninstall only removes an installed binary')
  }
  if (kind === 'homebrew') {
    throw new Error('this agent was installed with Homebrew. Run `brew uninstall agent` instead')
  }

  // Startup files first, then the config dir, then the binary itself. Deleting
  // a running executable is fine on macOS and Linux: the process keeps its
  // open copy until it exits.
  const cleaned: string[] = []
  for (const file of startupFiles(homedir())) {
    if (!existsSync(file)) continue
    const before = readFileSync(file, 'utf8')
    const after = stripInstallerLines(before)
    if (after !== before) {
      writeFileSync(file, after)
      cleaned.push(file)
    }
  }

  const config = configDir()
  if (purge) rmSync(config, { recursive: true, force: true })

  unlinkSync(execPath)

  console.log(`Removed ${execPath}`)
  for (const file of cleaned) console.log(`Removed the PATH line from ${file}`)
  if (cleaned.length > 0) console.log('Open a new shell to drop it from PATH.')
  if (purge) {
    console.log(`Removed ${config}`)
  } else if (existsSync(config)) {
    console.log(`Kept ${config} (hosts and credentials). Delete it with: rm -rf ${config}`)
  }
}
