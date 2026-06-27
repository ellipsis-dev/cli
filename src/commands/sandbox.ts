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
    .command('set [name] [value]')
    .description('Create or update variables (PUT /v1/sandboxes/variables)')
    .option('-f, --from-file <path>', 'load KEY=VALUE pairs from a .env-style file')
    .option('--json', 'output raw JSON')
    .action(
      async (
        name: string | undefined,
        value: string | undefined,
        opts: { fromFile?: string; json?: boolean },
      ) => {
        await runAction(async () => {
          const inputs = collectInputs(name, value, opts.fromFile)
          const variables = await new ApiClient().putSandboxVariables(inputs)
          if (!opts.json) {
            const names = inputs.map((v) => v.name).join(', ')
            console.log(`✓ stored ${inputs.length} variable(s) (values hidden): ${names}`)
          }
          printVariables(variables, opts.json)
        })
      },
    )

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

// Build the upsert batch from either a single `name value` pair or a file. Name
// validation is left to the server (one source of truth for the rules); we only
// enforce that the caller gave us something to send.
function collectInputs(
  name: string | undefined,
  value: string | undefined,
  fromFile: string | undefined,
): SandboxVariableInput[] {
  if (fromFile) {
    if (name !== undefined) {
      throw new Error('pass either a name/value pair or --from-file, not both')
    }
    const inputs = parseEnvFile(readFileSync(fromFile, 'utf8'))
    if (inputs.length === 0) throw new Error(`no KEY=VALUE pairs found in ${fromFile}`)
    return inputs
  }
  if (name === undefined || value === undefined) {
    throw new Error('provide a name and value, or --from-file <path>')
  }
  return [{ name, value }]
}

// Parse a .env-style file: `KEY=VALUE` per line, blank lines and `#` comments
// skipped, an optional leading `export `, and matching surrounding quotes
// stripped. Splits on the first `=` so values may contain `=`.
export function parseEnvFile(contents: string): SandboxVariableInput[] {
  const inputs: SandboxVariableInput[] = []
  for (const raw of contents.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line
    const eq = withoutExport.indexOf('=')
    if (eq === -1) continue
    const name = withoutExport.slice(0, eq).trim()
    let value = withoutExport.slice(eq + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1)
    }
    inputs.push({ name, value })
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
