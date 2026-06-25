import type { Command } from 'commander'
import { ApiClient } from '../lib/api'
import { printJson, runAction } from '../lib/output'

export function registerMe(program: Command): void {
  program
    .command('me')
    .description('Show the identity behind the current credential (GET /v1/me)')
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const me = await new ApiClient().whoami()
        if (opts.json) {
          printJson(me)
          return
        }
        console.log(`customer:  ${me.customer_login} (${me.customer_id})`)
        if (me.user_id) console.log(`user:      ${me.user_id}`)
        if (me.api_key_id) console.log(`api key:   ${me.api_key_id}`)
        if (me.sandbox_id) console.log(`sandbox:   ${me.sandbox_id}`)
      })
    })
}
