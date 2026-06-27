import { type Command } from 'commander'
import { ApiClient } from '../lib/api'
import { printJson, printTable, runAction } from '../lib/output'

export function registerTemplate(program: Command): void {
  const template = program
    .command('template')
    .description('Browse the built-in Ellipsis agent templates')

  template
    .command('list')
    .description('List built-in agent templates (GET /v1/agents/templates)')
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const templates = await new ApiClient().listAgentTemplates()
        if (opts.json) {
          printJson(templates)
          return
        }
        if (templates.length === 0) {
          console.log('No templates found.')
          return
        }
        // The description is the template's own one-line summary, served by the
        // API — kept here so it never drifts from the shipped template.
        printTable(
          ['SLUG', 'NAME', 'DESCRIPTION'],
          templates.map((t) => [t.slug, t.name, t.description]),
        )
        console.log('\nCreate one: agent config init --template <slug> --repo <name>')
      })
    })
}
