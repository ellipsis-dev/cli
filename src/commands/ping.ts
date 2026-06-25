import type { Command } from 'commander'
import { ApiClient } from '../lib/api'

export function registerPing(program: Command): void {
  program
    .command('ping')
    .description('Check connectivity to the Ellipsis API')
    .action(async () => {
      const api = new ApiClient()
      try {
        await api.request('GET', '/health')
        console.log('ok')
      } catch (err) {
        console.error(`ping failed: ${(err as Error).message}`)
        process.exitCode = 1
      }
    })
}
