import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Command } from 'commander'
import { configDir } from '../lib/config'
import {
  ALIAS_NAME,
  BINARY_NAME,
  installKind,
  startupFiles,
  stripInstallerLines,
} from '../lib/install'

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
    throw new Error('ellipsis is running from source; uninstall only removes an installed binary')
  }
  if (kind === 'homebrew') {
    throw new Error('this binary was installed with Homebrew. Run `brew uninstall agent` instead')
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
  const alias = removeAlias(execPath)

  console.log(`Removed ${execPath}`)
  if (alias) console.log(`Removed ${alias}`)
  for (const file of cleaned) console.log(`Removed the PATH line from ${file}`)
  if (cleaned.length > 0) console.log('Open a new shell to drop it from PATH.')
  if (purge) {
    console.log(`Removed ${config}`)
  } else if (existsSync(config)) {
    console.log(`Kept ${config} (hosts and credentials). Delete it with: rm -rf ${config}`)
  }
}

// The `el` link install.sh made next to the binary. Only a symlink that points
// at our binary is ours to remove; anything else with that name is left alone.
function removeAlias(execPath: string): string | undefined {
  const alias = join(dirname(execPath), ALIAS_NAME)
  try {
    if (!lstatSync(alias).isSymbolicLink()) return undefined
    const target = readlinkSync(alias)
    if (target !== BINARY_NAME && resolve(dirname(alias), target) !== execPath) return undefined
    unlinkSync(alias)
    return alias
  } catch {
    return undefined
  }
}
