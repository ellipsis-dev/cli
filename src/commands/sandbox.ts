import { type Command } from 'commander'
import { readFileSync } from 'node:fs'
import { ApiClient } from '../lib/api'
import { formatTs, printJson, printTable, runAction } from '../lib/output'
import type { SandboxVariableInput, SandboxVariableSummary } from '../lib/types'

export function registerSandbox(program: Command): void {
  const sandbox = program.command('sandbox').description('Manage sandbox resources')

  const variable = sandbox
    .command('variable')
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
    .option('-f, --from-file <path>', 'load KEY=VALUE pairs from a .env-style file')
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
    const fileInputs = parseEnvFile(readFileSync(fromFile, 'utf8'))
    if (fileInputs.length === 0) throw new Error(`no KEY=VALUE pairs found in ${fromFile}`)
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
