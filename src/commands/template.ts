import { type Command } from 'commander'
import { api } from '../lib/api'
import { alsoKnownAs, apiRoutes } from '../lib/help'
import { printJson, printTable, runAction } from '../lib/output'

export function registerTemplate(program: Command): void {
  const template = alsoKnownAs(
    program.command('template').description('Browse the built-in agent templates'),
    'templates',
  )

  apiRoutes(
    alsoKnownAs(
      template
        .command('list')
        .description('List the built-in agent templates and the slugs --template takes'),
      'ls',
    ),
    'GET /v1/templates',
  )
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const { templates } = await api().templates.list()
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
        console.log('\nCreate one: agent automation init --template <slug> --repo <name>')
      })
    })
}
