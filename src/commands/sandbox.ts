import { type Command } from 'commander'
import { readFileSync } from 'node:fs'
import { ApiClient } from '../lib/api'
import { formatTs, printJson, printTable, runAction } from '../lib/output'
import type {
  SandboxBuild,
  SandboxVariableInput,
  SandboxVariableSummary,
} from '../lib/types'

export function registerSandbox(program: Command): void {
  const sandbox = program.command('sandbox').description('Manage sandbox resources')

  const variable = sandbox
    .command('variable')
    // Resource sub-groups register their plural as an alias so the two
    // spellings can never diverge into different surfaces.
    .alias('variables')
    .alias('var')
    .description('Manage sandbox environment variables (values are write-only)')

  variable
    .command('list')
    .alias('ls')
    .description('List sandbox environment variables (GET /v1/sandboxes/variables)')
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const variables = await new ApiClient().listSandboxVariables()
        printVariables(variables, opts.json)
      })
    })

  variable
    .command('set [assignments...]')
    .description('Create or update variables, e.g. `set A=1 B=2` (PUT /v1/sandboxes/variables)')
    .option('-f, --from-file <path>', 'load variables from a .env or .json file')
    .option('--json', 'output raw JSON')
    .action(async (assignments: string[], opts: { fromFile?: string; json?: boolean }) => {
      await runAction(async () => {
        const inputs = collectInputs(assignments, opts.fromFile)
        const variables = await new ApiClient().putSandboxVariables(inputs)
        if (!opts.json) {
          const names = inputs.map((v) => v.name).join(', ')
          console.log(`✓ stored ${inputs.length} variable(s) (values hidden): ${names}`)
        }
        printVariables(variables, opts.json)
      })
    })

  variable
    .command('rm <name>')
    .alias('delete')
    .description('Delete a variable (DELETE /v1/sandboxes/variables/{name})')
    .option('--json', 'output raw JSON')
    .action(async (name: string, opts: { json?: boolean }) => {
      await runAction(async () => {
        const variables = await new ApiClient().deleteSandboxVariable(name)
        if (!opts.json) console.log(`✓ deleted ${name}`)
        printVariables(variables, opts.json)
      })
    })

  const build = sandbox
    .command('build')
    .alias('builds')
    .description(
      "Build an agent config's sandbox environment with no agent — docker build for the sandbox; a successful build pre-warms the image cache",
    )

  build
    .command('start')
    .description('Start a build (POST /v1/sandboxes/builds)')
    .option('-f, --config-file <path>', 'agent config YAML file to build (test before merge)')
    .option('-c, --config <configId>', 'saved agent config id to build')
    .option('--hooks', 'also exercise post_start/post_clone in the built box')
    .option('-w, --watch', 'stream the build log until it finishes (exit 0/1 with the result)')
    .option('--json', 'output the raw build record')
    .action(
      async (opts: {
        configFile?: string
        config?: string
        hooks?: boolean
        watch?: boolean
        json?: boolean
      }) => {
        await runAction(async () => {
          if (!opts.configFile === !opts.config) {
            throw new Error('provide exactly one of --config-file or --config')
          }
          const api = new ApiClient()
          const build = await api.startSandboxBuild({
            config_yaml: opts.configFile ? readFileSync(opts.configFile, 'utf8') : undefined,
            config_id: opts.config,
            hooks: opts.hooks ?? false,
          })
          if (!opts.watch) {
            if (opts.json) printJson(build)
            else {
              console.log(`✓ build queued: ${build.id}`)
              console.log(`  follow it with: agent sandbox build logs ${build.id} --watch`)
            }
            return
          }
          const finished = await watchBuild(api, build.id, 0)
          if (opts.json) printJson(finished)
          else printBuildSummary(finished)
          if (finished.status !== 'succeeded') process.exitCode = 1
        })
      },
    )

  build
    .command('list')
    .alias('ls')
    .description('List recent builds (GET /v1/sandboxes/builds)')
    .option('--limit <n>', 'max builds to return', '20')
    .option('--json', 'output raw JSON')
    .action(async (opts: { limit: string; json?: boolean }) => {
      await runAction(async () => {
        const builds = await new ApiClient().listSandboxBuilds(Number(opts.limit))
        if (opts.json) {
          printJson(builds)
          return
        }
        if (builds.length === 0) {
          console.log('No sandbox builds.')
          return
        }
        printTable(
          ['ID', 'STATUS', 'PHASE', 'TIER', 'HOOKS', 'CREATED'],
          builds.map((b) => [
            b.id,
            b.status,
            b.phase ?? '-',
            b.cache_tier ?? '-',
            b.hooks_requested ? 'yes' : 'no',
            formatTs(b.created_at),
          ]),
        )
      })
    })

  build
    .command('get <buildId>')
    .description("One build's summary (GET /v1/sandboxes/builds/{id})")
    .option('--json', 'output raw JSON')
    .action(async (buildId: string, opts: { json?: boolean }) => {
      await runAction(async () => {
        const build = await new ApiClient().getSandboxBuild(buildId)
        if (opts.json) printJson(build)
        else printBuildSummary(build)
      })
    })

  build
    .command('logs <buildId>')
    .description("A build's log (GET /v1/sandboxes/builds/{id}/logs)")
    .option('--after-seq <n>', 'resume after this line number', '0')
    .option('-w, --watch', 'follow the log until the build finishes')
    .option('--json', 'output raw JSON log lines')
    .action(
      async (buildId: string, opts: { afterSeq: string; watch?: boolean; json?: boolean }) => {
        await runAction(async () => {
          const api = new ApiClient()
          const afterSeq = Number(opts.afterSeq)
          if (!opts.watch) {
            const lines = await api.getSandboxBuildLogs(buildId, afterSeq)
            if (opts.json) printJson(lines)
            else for (const line of lines) console.log(line.line)
            return
          }
          const finished = await watchBuild(api, buildId, afterSeq)
          if (!opts.json) printBuildSummary(finished)
          if (finished.status !== 'succeeded') process.exitCode = 1
        })
      },
    )
}

const WATCH_POLL_MS = 1500

// Follow a build docker-build-style: print new log lines as they land, until
// the build reaches a terminal status. Polls the historical /logs read (the
// same seq sequence the WS serves); a final drain after the terminal status
// catches lines flushed with the finalize.
async function watchBuild(
  api: ApiClient,
  buildId: string,
  afterSeq: number,
): Promise<SandboxBuild> {
  let seq = afterSeq
  for (;;) {
    const build = await api.getSandboxBuild(buildId)
    for (;;) {
      const lines = await api.getSandboxBuildLogs(buildId, seq)
      if (lines.length === 0) break
      for (const line of lines) {
        console.log(line.line)
        seq = line.seq
      }
    }
    if (build.status !== 'queued' && build.status !== 'running') return build
    await new Promise((resolve) => setTimeout(resolve, WATCH_POLL_MS))
  }
}

function printBuildSummary(build: SandboxBuild): void {
  console.log(`${build.id}: ${build.status}`)
  if (build.cache_tier) console.log(`  cache tier  ${build.cache_tier}`)
  const timings = Object.entries(build.phase_timings)
  if (timings.length > 0) {
    console.log(`  phases      ${timings.map(([p, s]) => `${p} ${s}s`).join(' · ')}`)
  }
  if (build.result_image_id) console.log(`  image       ${build.result_image_id} (cache pre-warmed)`)
  if (build.status_reason) console.log(`  reason      ${build.status_reason}`)
  if (build.failing_phase) console.log(`  failed in   ${build.failing_phase}`)
}

// Build the upsert batch from inline `KEY=VALUE` arguments and/or a file. File
// pairs come first so an inline arg with the same name overrides the file (the
// server upserts in order, last write wins). Name validation is left to the
// server (one source of truth for the rules); we only parse and require that
// the caller gave us something to send.
export function collectInputs(
  assignments: string[],
  fromFile: string | undefined,
): SandboxVariableInput[] {
  const inputs: SandboxVariableInput[] = []
  if (fromFile) {
    const fileInputs = readVarsFromFile(fromFile)
    if (fileInputs.length === 0) throw new Error(`no variables found in ${fromFile}`)
    inputs.push(...fileInputs)
  }
  for (const raw of assignments) {
    const parsed = parseAssignment(raw)
    if (parsed === null) {
      throw new Error(`invalid assignment '${raw}' (expected KEY=VALUE)`)
    }
    inputs.push(parsed)
  }
  if (inputs.length === 0) {
    throw new Error('provide KEY=VALUE pairs, or --from-file <path>')
  }
  return inputs
}

// Read a variables file, picking the format by extension: `.json` is a flat
// object of name → value, anything else is a .env-style KEY=VALUE file.
function readVarsFromFile(path: string): SandboxVariableInput[] {
  const contents = readFileSync(path, 'utf8')
  return path.toLowerCase().endsWith('.json')
    ? parseJsonVars(contents)
    : parseEnvFile(contents)
}

// Parse a flat JSON object of name → value. Values must be strings (sandbox
// variable values are strings); a nested object, array, or non-string value is
// rejected rather than silently coerced.
export function parseJsonVars(contents: string): SandboxVariableInput[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch (err) {
    throw new Error(`invalid JSON: ${(err as Error).message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('expected a JSON object of variable name to value')
  }
  const inputs: SandboxVariableInput[] = []
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error(`value for '${name}' must be a string`)
    }
    inputs.push({ name, value })
  }
  return inputs
}

// Parse one `KEY=VALUE` assignment. Strips an optional leading `export `, splits
// on the first `=` (so values may contain `=`), and removes matching surrounding
// quotes. Returns null when there is no `=`.
export function parseAssignment(raw: string): SandboxVariableInput | null {
  const line = raw.trim()
  const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line
  const eq = withoutExport.indexOf('=')
  if (eq === -1) return null
  const name = withoutExport.slice(0, eq).trim()
  let value = withoutExport.slice(eq + 1).trim()
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
    value = value.slice(1, -1)
  }
  return { name, value }
}

// Parse a .env-style file: one `KEY=VALUE` per line, with blank lines and `#`
// comments skipped. Each non-comment line is parsed by parseAssignment.
export function parseEnvFile(contents: string): SandboxVariableInput[] {
  const inputs: SandboxVariableInput[] = []
  for (const raw of contents.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const parsed = parseAssignment(line)
    if (parsed !== null) inputs.push(parsed)
  }
  return inputs
}

function printVariables(variables: SandboxVariableSummary[], json?: boolean): void {
  if (json) {
    printJson(variables)
    return
  }
  if (variables.length === 0) {
    console.log('No sandbox variables.')
    return
  }
  printTable(
    ['NAME', 'CREATED', 'UPDATED'],
    variables.map((v) => [v.name, formatTs(v.created_at), formatTs(v.updated_at)]),
  )
}
