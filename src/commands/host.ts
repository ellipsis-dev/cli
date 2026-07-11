import { InvalidArgumentError, type Command } from 'commander'
import {
  activeHostName,
  addHost,
  deleteHost,
  deriveAppBase,
  listHosts,
  resolveApiBase,
  resolveAppBase,
  updateHost,
  useHost,
} from '../lib/config'
import { printTable } from '../lib/output'

// `agent host …` manages the Ellipsis instances the CLI can target — prod,
// beta, or a self-hosted deployment — and which one is active. It does NOT
// authenticate: `agent host add` / `use` set WHERE the CLI points; `agent
// login` sets the credential for wherever it's pointing. Every other command
// resolves against the active host (unless ELLIPSIS_API_BASE_URL /
// ELLIPSIS_API_TOKEN override it, e.g. inside a sandbox).
export function registerHost(program: Command): void {
  const host = program
    .command('host')
    .description('Manage the Ellipsis instances the CLI targets (prod / beta / self-hosted)')

  host
    .command('list', { isDefault: false })
    .alias('ls')
    .description('List configured hosts (the active one is marked *)')
    .action(() => {
      const hosts = listHosts()
      if (hosts.length === 0) {
        console.log('No hosts configured. Add one with `agent host add <name> <api-url>`.')
        return
      }
      printTable(
        ['', 'NAME', 'API', 'APP', 'LOGGED IN'],
        hosts.map((h) => [
          h.active ? '*' : '',
          h.name,
          h.host.apiBase,
          h.host.appBase ?? deriveAppBase(h.host.apiBase),
          h.host.token ? 'yes' : 'no',
        ]),
      )
    })

  host
    .command('add <name> <api-url>')
    .description('Add a host and switch to it (then `agent login` to authenticate)')
    .option(
      '--app-base <url>',
      'dashboard URL for building links / login (default: derived from the API URL)',
    )
    .action((name: string, apiUrl: string, opts: { appBase?: string }) => {
      addHost(name, requireUrl(apiUrl, 'api-url'), opts.appBase && requireUrl(opts.appBase, '--app-base'))
      console.log(`✓ added host "${name}" · now active`)
      console.log('Run `agent login` to authenticate against it.')
    })

  host
    .command('use <name>')
    .description('Switch the active host')
    .action((name: string) => {
      useHost(name)
      console.log(`✓ active host: ${name}`)
    })

  host
    .command('set <name>')
    .description('Change an existing host (API URL, app URL, or rename it)')
    .option('--api-base <url>', 'change the API URL')
    .option('--app-base <url>', 'change the dashboard URL')
    .option('--rename <name>', 'rename the host')
    .action(
      (name: string, opts: { apiBase?: string; appBase?: string; rename?: string }) => {
        if (!opts.apiBase && !opts.appBase && !opts.rename) {
          throw new Error('nothing to change: pass --api-base, --app-base, and/or --rename')
        }
        updateHost(name, {
          apiBase: opts.apiBase && requireUrl(opts.apiBase, '--api-base'),
          appBase: opts.appBase && requireUrl(opts.appBase, '--app-base'),
          rename: opts.rename,
        })
        console.log(`✓ updated host "${opts.rename ?? name}"`)
      },
    )

  host
    .command('delete <name>')
    .alias('rm')
    .description('Remove a host and its stored token')
    .action((name: string) => {
      const wasActive = activeHostName() === name
      deleteHost(name)
      console.log(`✓ removed host "${name}"`)
      if (wasActive) {
        console.log('That was the active host — set a new one with `agent host use <name>`.')
      }
    })

  host
    .command('current')
    .alias('show')
    .description('Show the active host and how it resolves')
    .action(() => {
      const name = activeHostName()
      const envApi = process.env.ELLIPSIS_API_BASE_URL || process.env.ELLIPSIS_API_BASE
      // resolveApiBase/resolveAppBase apply the env-override precedence, so this
      // reflects what commands will actually hit — not just the stored host.
      console.log(`host: ${name ?? '(none — using defaults)'}`)
      console.log(`api:  ${resolveApiBase()}`)
      console.log(`app:  ${resolveAppBase()}`)
      if (envApi) {
        console.log('note: ELLIPSIS_API_BASE_URL is set and overrides the active host.')
      }
    })
}

function requireUrl(value: string, label: string): string {
  if (!/^https?:\/\//i.test(value)) {
    throw new InvalidArgumentError(`${label} must be an http(s) URL (got "${value}")`)
  }
  return value.replace(/\/+$/, '')
}
