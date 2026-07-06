import { InvalidArgumentError, type Command } from 'commander'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname } from 'node:path'
import { ApiClient } from '../lib/api'
import { resolveAppBase } from '../lib/config'
import { formatTs, printJson, printTable, printYaml, runAction } from '../lib/output'
import { configUrl } from '../lib/urls'
import { readConfigFile } from './session'
import type { CreateAgentConfigRequest, SavedAgentConfig } from '../lib/types'

const DEFAULT_CONFIG_PATH = 'agents/my_agent.yaml'

export function registerConfig(program: Command): void {
  const config = program.command('config').description('Inspect saved agent configurations')

  config
    .command('list')
    .description('List saved agent configurations (GET /v1/configs)')
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const configs = await new ApiClient().listAgentConfigs()
        if (opts.json) {
          printJson(configs)
          return
        }
        if (configs.length === 0) {
          console.log('No configs found.')
          return
        }
        printTable(
          ['ID', 'SOURCE', 'UPDATED', 'EDITED BY'],
          configs.map((c) => [
            c.id,
            configSource(c),
            formatTs(c.updated_at),
            editedBy(c),
          ]),
        )
      })
    })

  config
    .command('get <configId>')
    .description('Get a single agent configuration (GET /v1/configs/{id})')
    .option('-o, --output <format>', 'output format: yaml (default) or json', parseFormat, 'yaml')
    .action(async (configId: string, opts: { output: 'yaml' | 'json' }) => {
      await runAction(async () => {
        const api = new ApiClient()
        // -o json is the machine-readable mode: emit only the raw config.
        if (opts.output === 'json') {
          printJson(await api.getAgentConfig(configId))
          return
        }
        // Fetch the config and the login (for the link) together. The link goes
        // to stderr so the YAML on stdout stays clean for piping/redirecting.
        const [c, me] = await Promise.all([api.getAgentConfig(configId), api.whoami()])
        printYaml(c)
        console.error(`\nview: ${configUrl(resolveAppBase(), me.customer_login, configId)}`)
      })
    })

  // Create an agent the same way the dashboard does: Ellipsis opens a pull
  // request adding the config YAML to the repo, and the agent goes live when
  // it merges. Distinct from `config init`, which scaffolds a local file.
  config
    .command('create')
    .description('Create an agent by opening a pull request with its config (POST /v1/configs)')
    .requiredOption(
      '--repo <name>',
      'repository name in your account to open the pull request against',
    )
    .option('-f, --file <path>', 'agent config file (.yaml/.yml or .json) to add')
    .option(
      '--template <slug>',
      'create from an Ellipsis template instead of a file (see `agent template list`)',
    )
    .option(
      '--path <path>',
      'file path within the repo for the config (default: agents/<slug>.yaml; must be a synced location)',
    )
    .option('--json', 'output raw JSON')
    .action(
      async (opts: {
        repo: string
        file?: string
        template?: string
        path?: string
        json?: boolean
      }) => {
        await runAction(async () => {
          // The server enforces "exactly one of config / template_id";
          // pre-check locally for a clearer error than a bare 400.
          if (!opts.file === !opts.template) {
            throw new Error('provide exactly one of --file <path> or --template <slug>')
          }
          const req: CreateAgentConfigRequest = {
            repository: opts.repo,
            path: opts.path,
          }
          if (opts.file) req.config = readConfigFile(opts.file)
          if (opts.template) req.template_id = opts.template
          const created = await new ApiClient().createAgentConfig(req)
          if (opts.json) {
            printJson(created)
            return
          }
          console.log(`✓ opened a pull request adding the agent (${created.path})`)
          console.log(created.pull_request_url)
          console.log('Merge it to deploy the agent.')
        })
      },
    )

  config
    .command('init [path]')
    .description(
      `Scaffold a starter agent config YAML locally (default: ${DEFAULT_CONFIG_PATH}), ` +
        'or with --template create the agent in a repo by opening a pull request',
    )
    .option('-f, --force', 'overwrite the file if it already exists')
    .option(
      '--template <slug>',
      'create the agent from an Ellipsis template by opening a pull request (see `agent template list`)',
    )
    .option(
      '--repo <name>',
      'repository name to open the pull request against (required with --template)',
    )
    .option(
      '--path <path>',
      'file path within the repo for the config (default: agents/<slug>.yaml; must be a synced location)',
    )
    .action(
      async (
        path: string | undefined,
        opts: { force?: boolean; template?: string; repo?: string; path?: string },
      ) => {
        // With --template the agent is created in your repo: Ellipsis opens a
        // pull request that adds the config file and returns it. Without it,
        // this is a local scaffold you commit yourself.
        if (opts.template) {
          if (!opts.repo) {
            console.error('error: --repo <name> is required with --template')
            process.exitCode = 1
            return
          }
          await runAction(async () => {
            const created = await new ApiClient().createAgentConfig({
              template_id: opts.template,
              repository: opts.repo!,
              path: opts.path,
            })
            console.log(`✓ opened a pull request adding the agent (${created.path})`)
            console.log(created.pull_request_url)
            console.log('Merge it to deploy the agent.')
          })
          return
        }
        const target = path ?? DEFAULT_CONFIG_PATH
        if (existsSync(target) && !opts.force) {
          console.error(`error: ${target} already exists (use --force to overwrite)`)
          process.exitCode = 1
          return
        }
        const name = basename(target, extname(target))
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, starterConfig(name))
        console.log(`✓ wrote ${target}`)
        console.log(COMMIT_HINT)
      },
    )
}

const COMMIT_HINT =
  'Commit it to your default branch. Ellipsis syncs agent configs from GitHub.'

// A minimal valid agent config. `claude.system` is the only required field;
// everything else has a server-side default. Roots Ellipsis syncs from:
// agents/, .agents/, ellipsis/, .ellipsis/ (any depth), as .yaml/.yml.
function starterConfig(name: string): string {
  return `# Ellipsis agent config — commit this to your default branch; Ellipsis syncs it
# from GitHub. Valid locations: agents/, .agents/, ellipsis/, .ellipsis/ (any depth).
ellipsis:
  version: v1
  name: ${name}
  description: What this agent does.

claude:
  # System prompt defining the agent's behavior (required).
  system: |
    You are an Ellipsis agent. Describe the task you want it to perform here.
  # model: claude-opus-4-8   # optional; defaults to the account default

# Optional — uncomment and fill in as needed:
# triggers:
#   - type: cron
#     schedule: "0 9 * * 1-5"   # weekdays at 09:00
# tools: []
# repositories: []
`
}

// GitHub source as `path@branch` (repo is only an opaque numeric id in the API).
// Prefixed with ⚠ when the last sync failed so it stands out in the list.
function configSource(c: SavedAgentConfig): string {
  const s = c.agent_config_source_details as
    | { repo_id: number; path: string; branch: string }
    | null
    | undefined
  const base = s ? `${s.path}@${s.branch}` : '—'
  return c.last_sync_error ? `⚠ ${base}` : base
}

function editedBy(c: SavedAgentConfig): string {
  const by = c.edited_by as { login?: string } | null | undefined
  return by?.login ?? '—'
}

function parseFormat(value: string): 'yaml' | 'json' {
  if (value !== 'yaml' && value !== 'json') {
    throw new InvalidArgumentError("output format must be 'yaml' or 'json'")
  }
  return value
}
