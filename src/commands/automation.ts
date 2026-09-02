import { type Command } from 'commander'
import { parse as parseYaml } from 'yaml'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname } from 'node:path'
import { api } from '../lib/api'
import { resolveAppBase } from '../lib/config'
import { alsoKnownAs, apiRoutes } from '../lib/help'
import { formatTs, printJson, printTable, printYaml, runAction } from '../lib/output'
import { automationUrl, sessionUrl } from '../lib/urls'
import { readConfigFile } from './session'
import type {
  AutomationConfig,
  Automation,
  CreateAutomationRequest,
  CreatedAutomation,
} from '../lib/types'

const DEFAULT_CONFIG_PATH = 'agents/my_agent.yaml'

// Automations: saved agent definitions (trigger + persona + environment
// reference) that run on their trigger or when invoked. Their files still
// live under agents/ in a repository; the API resource is /v1/automations.
export function registerAutomation(program: Command): void {
  const automation = alsoKnownAs(
    program.command('automation').description('Inspect, manage, and invoke your automations'),
    'automations',
  )

  apiRoutes(
    alsoKnownAs(automation.command('list').description('List your automations'), 'ls'),
    'GET /v1/automations',
  )
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const { automations } = await api().automations.list()
        if (opts.json) {
          printJson(automations)
          return
        }
        if (automations.length === 0) {
          console.log('No automations found.')
          return
        }
        printTable(
          ['ID', 'NAME', 'SOURCE', 'UPDATED', 'EDITED BY'],
          automations.map((a) => [
            a.id,
            a.name ?? '—',
            automationSource(a),
            formatTs(a.updated_at),
            editedBy(a),
          ]),
        )
      })
    })

  apiRoutes(
    automation
      .command('get <automation-id>')
      .description('Print one automation as YAML, or as JSON with --json'),
    'GET /v1/automations/{id}',
  )
    .option('--json', 'output raw JSON')
    .action(async (automationId: string, opts: { json?: boolean }) => {
      await runAction(async () => {
        const client = api()
        // --json is the machine-readable mode: emit only the raw automation.
        if (opts.json) {
          printJson((await client.automations.get(automationId)).automation)
          return
        }
        // Fetch the automation and the login (for the link) together. The link
        // goes to stderr so the YAML on stdout stays clean for piping.
        const [{ automation: a }, me] = await Promise.all([
          client.automations.get(automationId),
          client.me(),
        ])
        printYaml(a)
        console.error(`\nview: ${automationUrl(resolveAppBase(), me.customer_login, automationId)}`)
      })
    })

  // Invoke an automation. It runs exactly as defined — persona, model,
  // environment, permissions, skills, budget all bind — so the body carries
  // only its typed input, an optional tighter budget, and metadata. For a
  // prompt of your own in an environment, `agent session start` is the door.
  apiRoutes(
    automation
      .command('run <automation-id>')
      .description('Invoke an automation: run it exactly as defined, by id or name'),
    'POST /v1/automations/{id}/sessions',
  )
    .option(
      '-i, --input <json>',
      'the typed input payload (JSON object) for an automation that declares an input schema',
    )
    .option('--input-file <path>', 'read the input payload from a JSON or YAML file')
    .option('--budget <usd>', "lower this run's spend cap below the automation's own budget", Number)
    .option(
      '-m, --metadata <key=value>',
      'attach metadata (repeatable)',
      (value: string, prev: Record<string, string>) => {
        const eq = value.indexOf('=')
        if (eq <= 0) throw new Error(`metadata must be key=value, got "${value}"`)
        return { ...prev, [value.slice(0, eq)]: value.slice(eq + 1) }
      },
      {} as Record<string, string>,
    )
    .option('--json', 'output raw JSON')
    .action(
      async (
        automationId: string,
        opts: {
          input?: string
          inputFile?: string
          budget?: number
          metadata: Record<string, string>
          json?: boolean
        },
      ) => {
        await runAction(async () => {
          if (opts.input && opts.inputFile) {
            throw new Error('provide only one of --input / --input-file')
          }
          let input: Record<string, unknown> | undefined
          if (opts.input) input = parseInputObject(opts.input, '--input')
          if (opts.inputFile) {
            input = parseInputObject(readFileSync(opts.inputFile, 'utf8'), opts.inputFile)
          }
          const client = api()
          const { session } = await client.automations.run(automationId, {
            ...(input !== undefined ? { input } : {}),
            ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
            ...(Object.keys(opts.metadata).length > 0 ? { metadata: opts.metadata } : {}),
          })
          if (opts.json) {
            printJson(session)
            return
          }
          const me = await client.me()
          console.log(`✓ started ${session.id}`)
          console.log(`  ${sessionUrl(resolveAppBase(), me.customer_login, session.id)}`)
          console.log(`  follow with: agent session get ${session.id} --watch`)
        })
      },
    )

  // Create an automation. Two shapes, chosen by --repo: with it, Ellipsis
  // opens a pull request adding the YAML to that repo and the automation goes
  // live when it merges; without it, the automation is created through the
  // API alone — no file, live at once, changed by `automation edit`. Distinct
  // from `automation init`, which scaffolds a local file.
  apiRoutes(
    automation
      .command('create')
      .description('Create an automation, live immediately or by pull request with --repo'),
    'POST /v1/automations',
  )
    .option(
      '-r, --repo <name>',
      'define the automation as a file in this repository, by pull request (default: no file, live at once)',
    )
    .option('-f, --file <path>', 'definition file (.yaml/.yml or .json) to add')
    .option(
      '--template <slug>',
      'create from an Ellipsis template instead of a file (see `agent template list`)',
    )
    .option(
      '--path <path>',
      'file path within the repo (default: agents/<slug>.yaml; must be a synced location; needs --repo)',
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
          if (!opts.file === !opts.template) {
            throw new Error('provide exactly one of --file <path> or --template <slug>')
          }
          if (opts.path && !opts.repo) {
            throw new Error('--path names a location in a repository, so it needs --repo <name>')
          }
          const client = api()
          const definition = opts.file
            ? (readConfigFile(opts.file) as AutomationConfig)
            : (parseYaml((await client.templates.get(opts.template!)).yaml) as AutomationConfig)
          const req: CreateAutomationRequest = { automation: definition }
          const created = await client.automations.create(req)
          // With --repo the automation is then moved into the repository by
          // pull request (create + link, the two-step the API exposes).
          if (opts.repo) {
            const linked = await client.automations.link(created.automation.id, {
              repository: opts.repo,
              path: opts.path,
            })
            if (opts.json) {
              printJson(linked)
              return
            }
            console.log(
              `✓ created "${automationName(linked.automation)}" (${linked.automation.id}) — live now`,
            )
            console.log(`✓ opened a pull request adding the definition file (${linked.path})`)
            console.log(linked.pull_request_url)
            return
          }
          if (opts.json) {
            printJson(created)
            return
          }
          printCreated(created)
        })
      },
    )

  // Replace an API-managed automation's whole definition, live at once.
  // Refused for one defined by a repository file (the next push would revert
  // it) — `automation unlink` takes ownership first.
  apiRoutes(
    alsoKnownAs(
      automation
        .command('edit <automation-id>')
        .description("Replace an API-managed automation's definition from a file, live immediately"),
      'update',
    ),
    'PUT /v1/automations/{id}',
  )
    .requiredOption('-f, --file <path>', 'definition file (.yaml/.yml or .json) to replace it with')
    .option('--json', 'output raw JSON')
    .action(async (automationId: string, opts: { file: string; json?: boolean }) => {
      await runAction(async () => {
        const { automation: updated } = await api().automations.update(automationId, {
          automation: readConfigFile(opts.file) as AutomationConfig,
        })
        if (opts.json) {
          printJson(updated)
          return
        }
        console.log(`✓ updated "${automationName(updated)}" (${updated.id}) — live now`)
      })
    })

  apiRoutes(
    alsoKnownAs(
      automation
        .command('delete <automation-id>')
        .description('Delete an API-managed automation; it stops running and frees its name'),
      'rm',
    ),
    'DELETE /v1/automations/{id}',
  )
    .option('--json', 'output raw JSON')
    .action(async (automationId: string, opts: { json?: boolean }) => {
      await runAction(async () => {
        await api().automations.delete(automationId)
        // 204 No Content — nothing to echo, so confirm with what was addressed.
        if (opts.json) printJson({ id: automationId, deleted: true })
        else console.log(`✓ deleted ${automationId}`)
      })
    })

  // The two ownership moves. `link` hands an API-managed automation over to a
  // file (by pull request; it keeps running unchanged until that merges);
  // `unlink` takes one back from its file (immediate; the file is left inert).
  apiRoutes(
    automation
      .command('link <automation-id>')
      .description('Move an automation into a repository by opening a pull request that adds its file'),
    'POST /v1/automations/{id}/link',
  )
    .requiredOption('-r, --repo <name>', 'repository in your account to move the automation into')
    .option(
      '--path <path>',
      'file path within the repo (default: agents/<slug>.yaml; must be a synced location)',
    )
    .option('--json', 'output raw JSON')
    .action(
      async (automationId: string, opts: { repo: string; path?: string; json?: boolean }) => {
        await runAction(async () => {
          const linked = await api().automations.link(automationId, {
            repository: opts.repo,
            path: opts.path,
          })
          if (opts.json) {
            printJson(linked)
            return
          }
          console.log(`✓ opened a pull request adding the definition file (${linked.path})`)
          console.log(linked.pull_request_url)
          console.log('The automation keeps running meanwhile; merging hands it over to the file.')
        })
      },
    )

  apiRoutes(
    automation
      .command('unlink <automation-id>')
      .description('Take an automation over from its file, so this API changes it instead'),
    'POST /v1/automations/{id}/unlink',
  )
    .option('--json', 'output raw JSON')
    .action(async (automationId: string, opts: { json?: boolean }) => {
      await runAction(async () => {
        const { automation: unlinked } = await api().automations.unlink(automationId)
        if (opts.json) {
          printJson(unlinked)
          return
        }
        console.log(`✓ took over "${automationName(unlinked)}" (${unlinked.id})`)
        console.log('Its file no longer governs it and is left in place, inert.')
      })
    })

  apiRoutes(
    automation
      .command('init [path]')
      .description(
        `Scaffold a starter automation YAML locally (default: ${DEFAULT_CONFIG_PATH})`,
      ),
    'POST /v1/automations with --template',
  )
    // No `-f` short: CLI-wide, `-f` means an input file (see `automation create`).
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
      'file path within the repo (default: agents/<slug>.yaml; must be a synced location)',
    )
    .action(
      async (
        path: string | undefined,
        opts: { force?: boolean; template?: string; repo?: string; path?: string },
      ) => {
        // With --template the automation is created in your repo: Ellipsis
        // opens a pull request that adds the file and returns it. Without it,
        // this is a local scaffold you commit yourself.
        if (opts.template) {
          if (!opts.repo) {
            console.error('error: --repo <name> is required with --template')
            process.exitCode = 1
            return
          }
          await runAction(async () => {
            const client = api()
            const template = await client.templates.get(opts.template!)
            const created = await client.automations.create({
              automation: parseYaml(template.yaml) as AutomationConfig,
            })
            const linked = await client.automations.link(created.automation.id, {
              repository: opts.repo!,
              path: opts.path,
            })
            console.log(`✓ opened a pull request adding the definition file (${linked.path})`)
            console.log(linked.pull_request_url)
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
  'Commit it to your default branch. Ellipsis syncs automations from GitHub.'

function parseInputObject(text: string, what: string): Record<string, unknown> {
  const parsed: unknown = parseYaml(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${what} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function printCreated(created: CreatedAutomation): void {
  console.log(
    `✓ created "${automationName(created.automation)}" (${created.automation.id}) — live now`,
  )
  console.log(
    'It has no file; change it with `agent automation edit`, or `agent automation link` to move it into a repo.',
  )
}

function automationName(a: Automation): string {
  return a.config.ellipsis.name ?? a.id
}

// A minimal valid automation. `session.claude.system` is the only required
// field; everything else has a server-side default. Roots Ellipsis syncs from:
// agents/, .agents/, ellipsis/, .ellipsis/ (any depth), as .yaml/.yml.
function starterConfig(name: string): string {
  return `# Ellipsis automation. Commit this to your default branch; Ellipsis syncs it
# from GitHub. Valid locations: agents/, .agents/, ellipsis/, .ellipsis/ (any depth).
ellipsis:
  version: v1
  name: ${name}
  description: What this automation does.

# When it runs. Omit for an automation you invoke yourself (\`agent automation run\`).
# trigger:
#   type: cron
#   schedule: "0 9 * * 1-5"   # weekdays at 09:00

# What each session runs on.
session:
  claude:
    # System prompt defining the agent's behavior (required).
    system: |
      You are an Ellipsis agent. Describe the task you want it to perform here.
    # model: claude-opus-5   # optional; defaults to the organization default
  # environment: backend      # a saved environment, by name
`
}

// GitHub source as `path@branch` (repo is only an opaque numeric id in the API).
// Prefixed with ⚠ when the last sync failed so it stands out in the list. An
// API-managed automation has no file at all, which is a different thing from a
// github-managed one whose source is momentarily unknown — so name it.
function automationSource(a: Automation): string {
  const s = a.source_details as
    | { repo_id: number; path: string; branch: string }
    | null
    | undefined
  const base = s ? `${s.path}@${s.branch}` : a.managed_by === 'api' ? 'api' : '—'
  return a.last_sync_error ? `⚠ ${base}` : base
}

function editedBy(a: Automation): string {
  const by = a.edited_by as { login?: string } | null | undefined
  return by?.login ?? '—'
}
