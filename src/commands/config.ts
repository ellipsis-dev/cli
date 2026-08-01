import { type Command } from 'commander'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname } from 'node:path'
import { ApiClient } from '../lib/api'
import { resolveAppBase } from '../lib/config'
import { alsoKnownAs, apiRoutes } from '../lib/help'
import { repoFromCwd } from '../lib/laptop'
import { formatTs, printJson, printTable, printYaml, runAction } from '../lib/output'
import { configUrl } from '../lib/urls'
import { readConfigFile } from './session'
import type {
  AgentDefaultView,
  CreateAgentConfigRequest,
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
    'GET /v1/configs',
  )
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

  apiRoutes(
    config
      .command('get <config-id>')
      .description('Print one agent config as YAML, or as JSON with --json'),
    'GET /v1/configs/{id}',
  )
    .option('--json', 'output raw JSON')
    .action(async (configId: string, opts: { json?: boolean }) => {
      await runAction(async () => {
        const api = new ApiClient()
        // --json is the machine-readable mode: emit only the raw config.
        if (opts.json) {
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

  // Create an agent config the same way the dashboard does: Ellipsis opens a
  // pull request adding the YAML to the repo, and the agent goes live when it
  // merges. Distinct from `config init`, which scaffolds a local file.
  apiRoutes(
    config
      .command('create')
      .description('Create an agent config by opening a pull request that adds it to a repo'),
    'POST /v1/configs',
  )
    .requiredOption(
      '-r, --repo <name>',
      'repository in your account to open the pull request against',
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
          console.log(`✓ opened a pull request adding the agent config (${created.path})`)
          console.log(created.pull_request_url)
          console.log('Merge it to deploy the agent.')
        })
      },
    )

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
    'GET /v1/defaults',
  )
    .option('--json', 'output raw JSON')
    // Bare `agent config default`: the effective default for the repo you're
    // standing in, computed locally from GET /v1/defaults + the origin remote
    // (the same ladder session start resolves server-side).
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const rungs = await new ApiClient().listAgentDefaults()
        const repo = repoFromCwd(process.cwd())
        const repoRung = repo
          ? rungs.find((d) => d.repository?.toLowerCase() === repo.toLowerCase())
          : undefined
        const accountRung = rungs.find((d) => d.repository === null)
        const effective = repoRung ?? accountRung
        if (opts.json) {
          printJson({ repository: repo ?? null, effective: effective ?? null })
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
        const rung = effective.repository
          ? `repo default for ${effective.repository}`
          : 'account default'
        console.log(`using config "${defaultName(effective)}" (${rung})${brokenSuffix(effective)}`)
      })
    })

  apiRoutes(
    alsoKnownAs(
      defaults
        .command('list')
        .description('List every default that is set, account rung and per-repo rungs'),
      'ls',
    ),
    'GET /v1/defaults',
  )
    .option('--json', 'output raw JSON')
    // The group also defines --json (for the bare view), and commander parses
    // parent options even when they follow the subcommand name — so read the
    // merged view, not just this command's own opts.
    .action(async (_opts: { json?: boolean }, cmd: Command) => {
      await runAction(async () => {
        const rungs = await new ApiClient().listAgentDefaults()
        if (cmd.optsWithGlobals().json) {
          printJson(rungs)
          return
        }
        if (rungs.length === 0) {
          console.log('No defaults set. Sessions start on the bare config.')
          return
        }
        printTable(
          ['RUNG', 'CONFIG', 'CONFIG ID', 'STATUS', 'UPDATED'],
          rungs.map((d) => [
            d.repository ?? 'account',
            d.config_name ?? '—',
            d.config_id,
            d.broken ? `broken: ${d.broken}` : 'ok',
            formatTs(d.updated_at),
          ]),
        )
      })
    })

  apiRoutes(
    defaults
      .command('set <config-id>')
      .description('Set the account default agent config, or a repo default with --repo'),
    'PUT /v1/defaults',
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
          const set = await new ApiClient().putAgentDefault({
            config_id: configId,
            ...(repository ? { repository } : {}),
          })
          if (cmd.optsWithGlobals().json) {
            printJson(set)
            return
          }
          const rung = set.repository ? `default for ${set.repository}` : 'account default'
          console.log(`✓ set ${rung} to "${defaultName(set)}" (${set.config_id})`)
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
    'DELETE /v1/defaults',
  )
    .option(
      '-r, --repo [repository]',
      'target a repo rung: "owner/name", or no value for the repo you are standing in',
    )
    .action(async (opts: { repo?: string | boolean }) => {
      await runAction(async () => {
        const repository = resolveRepoFlag(opts.repo)
        await new ApiClient().deleteAgentDefault(repository)
        console.log(
          `✓ cleared ${repository ? `default for ${repository}` : 'account default'}`,
        )
      })
    })

  registerValidate(config, {
    noun: 'agent config',
    description: 'Check an agent config file for errors, without deploying it',
  })

  apiRoutes(
    config
      .command('init [path]')
      .description(
        `Scaffold a starter agent config YAML locally (default: ${DEFAULT_CONFIG_PATH})`,
      ),
    'POST /v1/configs with --template',
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
            const created = await new ApiClient().createAgentConfig({
              template_id: opts.template,
              repository: opts.repo!,
              path: opts.path,
            })
            console.log(`✓ opened a pull request adding the agent config (${created.path})`)
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

// `agent config validate` and `agent review validate` are the same command with
// two names, because the file they check is the same file: one YAML format whose
// `ellipsis.kind` decides which schema it must satisfy. Registering it under both
// nouns means neither reader has to know that. The server does the parsing, so
// the answer here matches what the GitHub sync will decide, and `expectKind`
// only catches handing the wrong noun the wrong file.
//
// Exit code 1 on an invalid file, so this is usable as a pre-commit or CI check.
export function registerValidate(
  parent: Command,
  { noun, description, expectKind }: { noun: string; description: string; expectKind?: string },
): void {
  apiRoutes(
    parent.command('validate <path>').description(description),
    'POST /v1/configs/validate',
  )
    .option('--json', 'output raw JSON')
    .action(async (path: string, opts: { json?: boolean }) => {
      await runAction(async () => {
        const result = await new ApiClient().validateConfig(readConfigText(path))
        if (opts.json) {
          printJson(result)
          if (!result.valid) process.exitCode = 1
          return
        }
        if (!result.valid) {
          console.error(`✗ ${path} is not valid`)
          // A YAML syntax error arrives as several lines with its own caret
          // pointing at the column, so indent every line, not just the first.
          for (const error of result.errors) {
            for (const line of error.split('\n')) console.error(`  ${line}`)
          }
          process.exitCode = 1
          return
        }
        // A valid file of the other kind is still a mistake worth naming: `agent
        // review validate` on an agent config would otherwise print a cheerful
        // ✓ for a file that will never run a review.
        if (expectKind && result.kind !== expectKind) {
          console.error(
            `✗ ${path} is a valid ${kindNoun(result.kind)}, not a ${noun}` +
              (expectKind === CONFIG_KIND_CODE_REVIEW
                ? " (a review pipeline needs 'kind: code_review' under ellipsis:)"
                : ''),
          )
          process.exitCode = 1
          return
        }
        console.log(`✓ ${path} is a valid ${kindNoun(result.kind)}`)
      })
    })
}

const CONFIG_KIND_CODE_REVIEW = 'code_review'

// The raw file text, since the server validates what the author wrote. Sent
// as-is, so a syntax error is the server's to report, not a local parse failure.
function readConfigText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    throw new Error(`could not read ${path}`)
  }
}

function kindNoun(kind: string | null): string {
  return kind === CONFIG_KIND_CODE_REVIEW ? 'code review pipeline' : 'agent config'
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

function defaultName(d: AgentDefaultView): string {
  return d.config_name ?? d.config_id
}

// A set-but-broken rung fails session starts closed (never a silent
// fall-through), so surface it wherever the rung is shown.
function brokenSuffix(d: AgentDefaultView): string {
  return d.broken ? ` (broken: ${d.broken})` : ''
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

