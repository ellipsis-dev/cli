import { InvalidArgumentError, type Command } from 'commander'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname } from 'node:path'
import { ApiClient } from '../lib/api'
import { formatTs, printJson, printTable, printYaml, runAction } from '../lib/output'
import type { SavedAgentConfig } from '../lib/types'

const DEFAULT_CONFIG_PATH = 'agents/my_agent.yaml'

export function registerConfig(program: Command): void {
  const config = program.command('config').description('Inspect saved agent configurations')

  config
    .command('list')
    .description('List saved agent configurations (GET /v1/agents/configs)')
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
    .description('Get a single agent configuration (GET /v1/agents/configs/{id})')
    .option('-o, --output <format>', 'output format: yaml (default) or json', parseFormat, 'yaml')
    .action(async (configId: string, opts: { output: 'yaml' | 'json' }) => {
      await runAction(async () => {
        const c = await new ApiClient().getAgentConfig(configId)
        if (opts.output === 'json') {
          printJson(c)
        } else {
          printYaml(c)
        }
      })
    })

  config
    .command('init [path]')
    .description(`Scaffold a starter agent config YAML (default: ${DEFAULT_CONFIG_PATH})`)
    .option('-f, --force', 'overwrite the file if it already exists')
    .action((path: string | undefined, opts: { force?: boolean }) => {
      // Configs are sourced from YAML in GitHub, not created through the API
      // (see documents/eng/ELLIPSIS_API_AND_CLI.md), so `init` is a local
      // scaffold the user commits to a path Ellipsis syncs from.
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
      console.log(
        'Commit it to your default branch — Ellipsis syncs agent configs from GitHub.',
      )
    })
}

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
