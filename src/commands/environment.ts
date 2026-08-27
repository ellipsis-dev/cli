import { type Command } from 'commander'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { api } from '../lib/api'
import { alsoKnownAs, apiRoutes } from '../lib/help'
import { repoFromCwd } from '../lib/git'
import { formatTs, printJson, printTable, printYaml, runAction } from '../lib/output'
import { resolveRepoFlag } from './config'
import { readConfigFile } from './session'
import type {
  EnvironmentConfig,
  EnvironmentDefaults,
  SavedEnvironment,
} from '../lib/types'

const DEFAULT_ENVIRONMENT_PATH = 'agents/environments/my_environment.yaml'

export function registerEnvironment(program: Command): void {
  const environment = alsoKnownAs(
    program
      .command('environment')
      .description('Manage the environments agents run in: repos, variables, MCP servers, image'),
    'environments',
    'env',
  )

  apiRoutes(
    alsoKnownAs(
      environment.command('list').description('List your saved environments'),
      'ls',
    ),
    'GET /v1/environments',
  )
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const { environments } = await api().environments.list()
        if (opts.json) {
          printJson(environments)
          return
        }
        if (environments.length === 0) {
          console.log('No environments found.')
          return
        }
        printTable(
          ['NAME', 'ID', 'SOURCE', 'UPDATED'],
          environments.map((e) => [e.name, e.id, environmentSource(e), formatTs(e.updated_at)]),
        )
      })
    })

  apiRoutes(
    environment
      .command('get <environment-id>')
      .description('Print one environment as YAML (by id or name), or as JSON with --json'),
    'GET /v1/environments/{id}',
  )
    .option('--json', 'output raw JSON')
    .action(async (environmentId: string, opts: { json?: boolean }) => {
      await runAction(async () => {
        const { environment: e } = await api().environments.get(environmentId)
        if (opts.json) {
          printJson(e)
          return
        }
        printYaml(e.environment)
      })
    })

  apiRoutes(
    environment
      .command('create')
      .description('Create an environment from a file, live immediately'),
    'POST /v1/environments',
  )
    .requiredOption('-f, --file <path>', 'environment file (.yaml/.yml or .json) to create from')
    .option('--json', 'output raw JSON')
    .action(async (opts: { file: string; json?: boolean }) => {
      await runAction(async () => {
        const created = await api().environments.create({
          environment: readConfigFile(opts.file) as EnvironmentConfig,
        })
        if (opts.json) {
          printJson(created)
          return
        }
        const e = created.environment
        console.log(`✓ created "${e.name}" (${e.id}) — live now`)
        console.log(
          'Reference it from agent configs (`environment: ' +
            e.name +
            '`) or make it the default: `agent environment default set ' +
            e.name +
            '`.',
        )
      })
    })

  apiRoutes(
    alsoKnownAs(
      environment
        .command('edit <environment-id>')
        .description("Replace an API-managed environment's definition from a file, live immediately"),
      'update',
    ),
    'PUT /v1/environments/{id}',
  )
    .requiredOption('-f, --file <path>', 'environment file (.yaml/.yml or .json) to replace it with')
    .option('--json', 'output raw JSON')
    .action(async (environmentId: string, opts: { file: string; json?: boolean }) => {
      await runAction(async () => {
        const { environment: updated } = await api().environments.update(environmentId, {
          environment: readConfigFile(opts.file) as EnvironmentConfig,
        })
        if (opts.json) {
          printJson(updated)
          return
        }
        console.log(`✓ updated "${updated.name}" (${updated.id}) — future sessions use it`)
      })
    })

  apiRoutes(
    alsoKnownAs(
      environment
        .command('delete <environment-id>')
        .description('Delete an API-managed environment; agents still referencing it fail at start'),
      'rm',
    ),
    'DELETE /v1/environments/{id}',
  )
    .option('--json', 'output raw JSON')
    .action(async (environmentId: string, opts: { json?: boolean }) => {
      await runAction(async () => {
        await api().environments.delete(environmentId)
        if (opts.json) printJson({ id: environmentId, deleted: true })
        else console.log(`✓ deleted ${environmentId}`)
      })
    })

  // ------------------------------- defaults --------------------------------
  // The default-environment ladder a config-less session resolves: repo
  // default -> account default -> the built-in basic sandbox. Same rung
  // addressing as `agent config default`.
  const defaults = apiRoutes(
    alsoKnownAs(
      environment
        .command('default')
        .description('Show or set which environment serves sessions that name none'),
      'defaults',
    ),
    'GET /v1/environments/defaults',
  )
    .option('--json', 'output raw JSON')
    // Bare `agent environment default`: the effective default for the repo
    // you're standing in, computed locally from GET /defaults + the origin
    // remote (the same ladder session start resolves server-side).
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const ladder = await api().environments.defaults.list()
        const repo = repoFromCwd(process.cwd())
        const repoRung = repo ? repoDefault(ladder, repo) : undefined
        const effective = repoRung ?? ladder.account ?? null
        if (opts.json) {
          printJson({ repository: repo ?? null, effective })
          return
        }
        if (!effective) {
          console.log(
            repo
              ? `no default environment for ${repo} or the account (sessions get the basic sandbox)`
              : 'no account default environment set (sessions get the basic sandbox)',
          )
          return
        }
        const rung = repoRung ? `repo default for ${repo}` : 'account default'
        console.log(`using environment "${effective}" (${rung})`)
      })
    })

  apiRoutes(
    alsoKnownAs(
      defaults
        .command('list')
        .description('List every default environment that is set, account rung and per-repo rungs'),
      'ls',
    ),
    'GET /v1/environments/defaults',
  )
    .option('--json', 'output raw JSON')
    .action(async (_opts: { json?: boolean }, cmd: Command) => {
      await runAction(async () => {
        const client = api()
        const ladder = await client.environments.defaults.list()
        if (cmd.optsWithGlobals().json) {
          printJson(ladder)
          return
        }
        const rungs: [string, string][] = [
          ...(ladder.account ? ([['account', ladder.account]] as [string, string][]) : []),
          ...Object.entries(ladder.repositories),
        ]
        if (rungs.length === 0) {
          console.log('No default environments set. Sessions get the basic sandbox.')
          return
        }
        const names = new Map(
          (await client.environments.list()).environments.map((e) => [e.id, e.name]),
        )
        printTable(
          ['RUNG', 'ENVIRONMENT', 'ENVIRONMENT ID'],
          rungs.map(([rung, id]) => [rung, names.get(id) ?? id, id]),
        )
      })
    })

  apiRoutes(
    defaults
      .command('set <environment-id>')
      .description('Set the account default environment, or a repo default with --repo'),
    'PUT /v1/environments/defaults',
  )
    .option(
      '-r, --repo [repository]',
      'target a repo rung: "owner/name", or no value for the repo you are standing in',
    )
    .option('--json', 'output raw JSON')
    .action(
      async (
        environmentId: string,
        opts: { repo?: string | boolean; json?: boolean },
        cmd: Command,
      ) => {
        await runAction(async () => {
          const repository = resolveRepoFlag(opts.repo)
          const ladder = await api().environments.defaults.set({
            environment: environmentId,
            ...(repository ? { repository } : {}),
          })
          if (cmd.optsWithGlobals().json) {
            printJson(ladder)
            return
          }
          const rung = repository ? `default for ${repository}` : 'account default'
          const id = repository ? repoDefault(ladder, repository) : ladder.account
          console.log(`✓ set ${rung} to ${id ?? environmentId}`)
        })
      },
    )

  apiRoutes(
    alsoKnownAs(
      defaults
        .command('clear')
        .description('Clear the account default environment, or a repo default with --repo'),
      'rm',
      'delete',
    ),
    'DELETE /v1/environments/defaults',
  )
    .option(
      '-r, --repo [repository]',
      'target a repo rung: "owner/name", or no value for the repo you are standing in',
    )
    .action(async (opts: { repo?: string | boolean }) => {
      await runAction(async () => {
        const repository = resolveRepoFlag(opts.repo)
        await api().environments.defaults.delete({ repository })
        console.log(
          `✓ cleared ${repository ? `default environment for ${repository}` : 'account default environment'}`,
        )
      })
    })

  environment
    .command('init [path]')
    .description(
      `Scaffold a starter environment YAML locally (default: ${DEFAULT_ENVIRONMENT_PATH})`,
    )
    .option('--force', 'overwrite the file if it already exists')
    .action(async (path: string | undefined, opts: { force?: boolean }) => {
      const target = path ?? DEFAULT_ENVIRONMENT_PATH
      if (existsSync(target) && !opts.force) {
        console.error(`error: ${target} already exists (use --force to overwrite)`)
        process.exitCode = 1
        return
      }
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, STARTER_ENVIRONMENT)
      console.log(`✓ wrote ${target}`)
      console.log(
        'Commit it to your default branch (Ellipsis syncs it from GitHub), or create it now: `agent environment create -f ' +
          target +
          '`.',
      )
    })
}

function environmentSource(e: SavedEnvironment): string {
  if (e.source_details) return e.source_details.path
  return 'api'
}

function repoDefault(ladder: EnvironmentDefaults, repo: string): string | undefined {
  const match = Object.entries(ladder.repositories).find(
    ([name]) => name.toLowerCase() === repo.toLowerCase(),
  )
  return match?.[1]
}

const STARTER_ENVIRONMENT = `# Ellipsis environment: the machine your agents run in, defined once for the
# team. Commit to your default branch (synced locations: agents/, .agents/,
# ellipsis/, .ellipsis/), or create it live with \`agent environment create -f\`.
ellipsis:
  kind: environment
  name: my-environment

# Repositories checked out into every session.
repositories:
  - name: my-repo

# Environment variables injected into the sandbox. Omit \`value\` to resolve
# the name from your stored secrets (\`agent variable set NAME=...\`).
variables:
  - name: MY_TOKEN

# MCP servers available to agents. Built-ins by name (linear, slack); bring
# your own with \`url:\` (remote) or \`command:\` (stdio). \${NAME} in
# env/header values resolves from your stored secrets at session start.
mcp_servers:
  - linear
#  - name: sentry
#    url: https://mcp.sentry.dev/mcp
#    headers:
#      Authorization: "Bearer \${SENTRY_AUTH_TOKEN}"

# Toolchain baked into the cached image (runs once per image build).
image:
  setup: |
    echo "install CLIs and dependencies here"

# Sandbox sizing.
compute:
  cpu: 2
  memory: 4GB
`
