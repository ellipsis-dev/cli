import type { Command } from 'commander'

export function registerConfig(program: Command): void {
  const config = program.command('config').description('Manage agent configurations')

  config
    .command('create <name>')
    .description('Create a new agent configuration locally')
    .action((name: string) => {
      console.log(`[stub] create config "${name}"`)
    })

  config
    .command('deploy <name>')
    .description('Deploy a configuration to the Ellipsis cloud')
    .action((name: string) => {
      console.log(`[stub] deploy config "${name}"`)
    })

  config
    .command('list')
    .description('List configurations')
    .action(() => {
      console.log('[stub] list configs')
    })
}
