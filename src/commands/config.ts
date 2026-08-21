import { type Command } from 'commander'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname } from 'node:path'
import { api } from '../lib/api'
import { resolveAppBase } from '../lib/config'
import { alsoKnownAs, apiRoutes } from '../lib/help'
import { repoFromCwd } from '../lib/git'
import { formatTs, printJson, printTable, printYaml, runAction } from '../lib/output'
import { configUrl } from '../lib/urls'
import { readConfigFile } from './session'
import type {
  AgentConfig,
  AgentDefaults,
  CreateAgentConfigRequest,
  CreatedAgentConfig,
  SavedAgentConfig,
} from '../lib/types'

const DEFAULT_CONFIG_PATH = 'agents/my_agent.yaml'

export function registerConfig(program: Command): void {
  const config = alsoKnownAs(
    program
      .command('config')
      .description('Inspect your agent configs and set which one runs by default'),
    'configs',
  )

  apiRoutes(
    alsoKnownAs(
      config.command('list').description('List your saved agent configs'),
      'ls',
    ),
    'GET /agents/configs',
  )
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const { configs } = await api().agents.configs.list()
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

  apiRoutes(
    config
      .command('get <config-id>')
      .description('Print one agent config as YAML, or as JSON with --json'),
    'GET /agents/configs/{id}',
  )
    .option('--json', 'output raw JSON')
    .action(async (configId: string, opts: { json?: boolean }) => {
      await runAction(async () => {
        const client = api()
        // --json is the machine-readable mode: emit only the raw config.
        if (opts.json) {
          printJson((await client.agents.configs.get(configId)).config)
          return
        }
        // Fetch the config and the login (for the link) together. The link goes
        // to stderr so the YAML on stdout stays clean for piping/redirecting.
        const [{ config: c }, me] = await Promise.all([
          client.agents.configs.get(configId),
          client.me(),
        ])
        printYaml(c)
        console.error(`\nview: ${configUrl(resolveAppBase(), me.customer_login, configId)}`)
      })
    })

  // Create an agent. Two shapes, chosen by --repo: with it, Ellipsis opens a
  // pull request adding the YAML to that repo and the agent goes live when it
  // merges (what the dashboard has always done); without it, the agent is
  // created through the API alone — no file, live at once, changed by `config
  // edit`. Distinct from `config init`, which scaffolds a local file.
  apiRoutes(
    config
      .command('create')
      .description('Create an agent, live immediately or by pull request with --repo'),
    'POST /agents/configs',
  )
    .option(
      '-r, --repo <name>',
      'define the agent as a file in this repository, by pull request (default: no file, live at once)',
    )
    .option('-f, --file <path>', 'agent config file (.yaml/.yml or .json) to add')
    .option(
      '--template <slug>',
      'create from an Ellipsis template instead of a file (see `agent template list`)',
    )
    .option(
      '--path <path>',
      'file path within the repo for the config (default: agents/<slug>.yaml; must be a synced location; needs --repo)',
    )
    .option('--json', 'output raw JSON')
    .action(
      async (opts: {
        repo?: string
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
          if (opts.path && !opts.repo) {
            throw new Error('--path names a location in a repository, so it needs --repo <name>')
          }
          const req: CreateAgentConfigRequest = {
            repository: opts.repo,
            path: opts.path,
          }
          if (opts.file) req.config = readConfigFile(opts.file) as AgentConfig
          if (opts.template) req.template_id = opts.template
          const created = await api().agents.configs.create(req)
          if (opts.json) {
            printJson(created)
            return
          }
          printCreated(created)
        })
      },
    )

  // Replace an API-managed agent's whole definition, live at once. Refused for
  // an agent defined by a repository file (the next push would revert it) —
  // `config unlink` takes ownership first.
  apiRoutes(
    alsoKnownAs(
      config
        .command('edit <config-id>')
        .description("Replace an API-managed agent's definition from a file, live immediately"),
      'update',
    ),
    'PUT /agents/configs/{id}',
  )
    .requiredOption('-f, --file <path>', 'agent config file (.yaml/.yml or .json) to replace it with')
    .option('--json', 'output raw JSON')
    .action(async (configId: string, opts: { file: string; json?: boolean }) => {
      await runAction(async () => {
        const { config: updated } = await api().agents.configs.update(configId, {
          config: readConfigFile(opts.file) as AgentConfig,
        })
        if (opts.json) {
          printJson(updated)
          return
        }
        console.log(`✓ updated "${configName(updated)}" (${updated.id}) — live now`)
      })
    })

  apiRoutes(
    alsoKnownAs(
      config
        .command('delete <config-id>')
        .description('Delete an API-managed agent; it stops running and frees its name'),
      'rm',
    ),
    'DELETE /agents/configs/{id}',
  )
    .option('--json', 'output raw JSON')
    .action(async (configId: string, opts: { json?: boolean }) => {
      await runAction(async () => {
        await api().agents.configs.delete(configId)
        // 204 No Content — nothing to echo, so confirm with what was addressed.
        if (opts.json) printJson({ id: configId, deleted: true })
        else console.log(`✓ deleted ${configId}`)
      })
    })

  // The two ownership moves. `link` hands an API-managed agent over to a file
  // (by pull request; it keeps running unchanged until that merges); `unlink`
  // takes one back from its file (immediate, and the file is left inert).
  apiRoutes(
    config
      .command('link <config-id>')
      .description('Move an agent into a repository by opening a pull request that adds its file'),
    'POST /agents/configs/{id}/link',
  )
    .requiredOption('-r, --repo <name>', 'repository in your account to move the agent into')
    .option(
      '--path <path>',
      'file path within the repo for the config (default: agents/<slug>.yaml; must be a synced location)',
    )
    .option('--json', 'output raw JSON')
    .action(
      async (configId: string, opts: { repo: string; path?: string; json?: boolean }) => {
        await runAction(async () => {
          const linked = await api().agents.configs.link(configId, {
            repository: opts.repo,
            path: opts.path,
          })
          if (opts.json) {
            printJson(linked)
            return
          }
          console.log(`✓ opened a pull request adding the agent config (${linked.path})`)
          console.log(linked.pull_request_url)
          console.log('The agent keeps running meanwhile; merging hands it over to the file.')
        })
      },
    )

  apiRoutes(
    config
      .command('unlink <config-id>')
      .description('Take an agent over from its file, so this API changes it instead'),
    'POST /agents/configs/{id}/unlink',
  )
    .option('--json', 'output raw JSON')
    .action(async (configId: string, opts: { json?: boolean }) => {
      await runAction(async () => {
        const { config: unlinked } = await api().agents.configs.unlink(configId)
        if (opts.json) {
          printJson(unlinked)
          return
        }
        console.log(`✓ took over "${configName(unlinked)}" (${unlinked.id})`)
        console.log('Its file no longer governs it and is left in place, inert.')
      })
    })

  // ------------------------------- defaults --------------------------------
  // The default-config ladder a bare session start resolves: repo default ->
  // account default -> the bare platform config. Rung-addressed, never row
  // ids: writes target the ACCOUNT rung unless --repo names (or detects) a
  // repository. Reading is context-aware (bare `agent config default` shows
  // the effective default where you stand); writes never are — a mutation
  // whose target depends on your cwd would be a footgun, so --repo is always
  // explicit.
  const defaults = apiRoutes(
    alsoKnownAs(
      config
        .command('default')
        .description('Show or set which agent config runs when a session names none'),
      'defaults',
    ),
    'GET /agents/defaults',
  )
    .option('--json', 'output raw JSON')
    // Bare `agent config default`: the effective default for the repo you're
    // standing in, computed locally from GET /defaults + the origin remote
    // (the same ladder session start resolves server-side).
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const ladder = await api().agents.defaults.list()
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
              ? `no default set for ${repo} or the account (sessions start on the bare config)`
              : 'no account default set (sessions start on the bare config)',
          )
          return
        }
        const rung = repoRung ? `repo default for ${repo}` : 'account default'
        console.log(`using config "${effective}" (${rung})`)
      })
    })

  apiRoutes(
    alsoKnownAs(
      defaults
        .command('list')
        .description('List every default that is set, account rung and per-repo rungs'),
      'ls',
    ),
    'GET /agents/defaults',
  )
    .option('--json', 'output raw JSON')
    // The group also defines --json (for the bare view), and commander parses
    // parent options even when they follow the subcommand name — so read the
    // merged view, not just this command's own opts.
    .action(async (_opts: { json?: boolean }, cmd: Command) => {
      await runAction(async () => {
        const client = api()
        const ladder = await client.agents.defaults.list()
        if (cmd.optsWithGlobals().json) {
          printJson(ladder)
          return
        }
        const rungs: [string, string][] = [
          ...(ladder.account ? ([['account', ladder.account]] as [string, string][]) : []),
          ...Object.entries(ladder.repositories),
        ]
        if (rungs.length === 0) {
          console.log('No defaults set. Sessions start on the bare config.')
          return
        }
        // The ladder carries ids only, but a human reads this table — so join
        // the account's configs to show each rung's name.
        const names = new Map(
          (await client.agents.configs.list()).configs.map((c) => [c.id, configName(c)]),
        )
        printTable(
          ['RUNG', 'CONFIG', 'CONFIG ID'],
          rungs.map(([rung, id]) => [rung, names.get(id) ?? id, id]),
        )
      })
    })

  apiRoutes(
    defaults
      .command('set <config-id>')
      .description('Set the account default agent config, or a repo default with --repo'),
    'PUT /agents/defaults',
  )
    .option(
      '-r, --repo [repository]',
      'target a repo rung: "owner/name", or no value for the repo you are standing in',
    )
    .option('--json', 'output raw JSON')
    .action(
      async (configId: string, opts: { repo?: string | boolean; json?: boolean }, cmd: Command) => {
        await runAction(async () => {
          const repository = resolveRepoFlag(opts.repo)
          const ladder = await api().agents.defaults.set({
            config_id: configId,
            ...(repository ? { repository } : {}),
          })
          if (cmd.optsWithGlobals().json) {
            printJson(ladder)
            return
          }
          const rung = repository ? `default for ${repository}` : 'account default'
          const id = repository ? repoDefault(ladder, repository) : ladder.account
          console.log(`✓ set ${rung} to ${id ?? configId}`)
        })
      },
    )

  apiRoutes(
    alsoKnownAs(
      defaults
        .command('clear')
        .description('Clear the account default agent config, or a repo default with --repo'),
      'rm',
      'delete',
    ),
    'DELETE /agents/defaults',
  )
    .option(
      '-r, --repo [repository]',
      'target a repo rung: "owner/name", or no value for the repo you are standing in',
    )
    .action(async (opts: { repo?: string | boolean }) => {
      await runAction(async () => {
        const repository = resolveRepoFlag(opts.repo)
        await api().agents.defaults.delete({ repository })
        console.log(
          `✓ cleared ${repository ? `default for ${repository}` : 'account default'}`,
        )
      })
    })

  apiRoutes(
    config
      .command('init [path]')
      .description(
        `Scaffold a starter agent config YAML locally (default: ${DEFAULT_CONFIG_PATH})`,
      ),
    'POST /agents/configs with --template',
  )
    // No `-f` short: CLI-wide, `-f` means an input file (see `config create`).
    .option('--force', 'overwrite the file if it already exists')
    .option(
      '-t, --template <slug>',
      'instead scaffold from a template, in a repo, by pull request (see `agent template list`)',
    )
    .option(
      '-r, --repo <name>',
      'repository to open the pull request against (required with --template)',
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
            printCreated(
              await api().agents.configs.create({
                template_id: opts.template,
                repository: opts.repo!,
                path: opts.path,
              }),
            )
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

// A create answers two ways: with a repository the agent waits on a pull
// request, without one it is already live and has no file.
function printCreated(created: CreatedAgentConfig): void {
  if (created.pull_request_url) {
    console.log(`✓ opened a pull request adding the agent config (${created.path})`)
    console.log(created.pull_request_url)
    console.log('Merge it to deploy the agent.')
    return
  }
  console.log(`✓ created "${configName(created.config)}" (${created.config.id}) — live now`)
  console.log('It has no file; change it with `agent config edit`, or `agent config link` to move it into a repo.')
}

function configName(c: SavedAgentConfig): string {
  return c.agent_config.ellipsis.name ?? c.id
}

// --repo semantics on defaults mutations: absent -> the account rung; bare
// --repo -> the repo you're standing in (from the origin remote, an error
// when there isn't one); --repo owner/name -> that repo. Shared with
// `agent review default`, whose rungs are addressed identically.
export function resolveRepoFlag(repo: string | boolean | undefined): string | undefined {
  if (repo === undefined || repo === false) return undefined
  if (repo === true) {
    const detected = repoFromCwd(process.cwd())
    if (!detected) {
      throw new Error(
        'no git repository detected here; pass --repo owner/name or run inside a clone',
      )
    }
    return detected
  }
  return repo
}

// The repo rung's config id. Rungs are keyed "owner/name" as GitHub spells it,
// so match case-insensitively rather than indexing directly.
function repoDefault(ladder: AgentDefaults, repo: string): string | undefined {
  const want = repo.toLowerCase()
  return Object.entries(ladder.repositories).find(([r]) => r.toLowerCase() === want)?.[1]
}

// A minimal valid agent config. `claude.system` is the only required field;
// everything else has a server-side default. Roots Ellipsis syncs from:
// agents/, .agents/, ellipsis/, .ellipsis/ (any depth), as .yaml/.yml.
function starterConfig(name: string): string {
  return `# Ellipsis agent config. Commit this to your default branch; Ellipsis syncs it
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

# Optional, uncomment and fill in as needed:
# triggers:
#   - type: cron
#     schedule: "0 9 * * 1-5"   # weekdays at 09:00
# tools: []
# repositories: []
`
}

// GitHub source as `path@branch` (repo is only an opaque numeric id in the API).
// Prefixed with ⚠ when the last sync failed so it stands out in the list. An
// API-managed agent has no file at all, which is a different thing from a
// github-managed one whose source is momentarily unknown — so name it.
function configSource(c: SavedAgentConfig): string {
  const s = c.agent_config_source_details as
    | { repo_id: number; path: string; branch: string }
    | null
    | undefined
  const base = s ? `${s.path}@${s.branch}` : c.managed_by === 'api' ? 'api' : '—'
  return c.last_sync_error ? `⚠ ${base}` : base
}

function editedBy(c: SavedAgentConfig): string {
  const by = c.edited_by as { login?: string } | null | undefined
  return by?.login ?? '—'
}

