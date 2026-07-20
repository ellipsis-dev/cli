import type { Command } from 'commander'
import { ApiClient } from '../lib/api'
import { requireToken } from '../lib/config'
import { printJson, runAction } from '../lib/output'
import type { WhoAmI } from '../lib/types'

// Renders the human-readable identity summary. Prefers the GitHub login over the
// bare numeric user id when the server resolved a gh_user, falling back to the id.
export function renderMe(me: WhoAmI): void {
  console.log(`customer:  ${me.customer_login} (${me.customer_id})`)
  if (me.gh_user) console.log(`user:      ${me.gh_user.login} (${me.user_id})`)
  else if (me.user_id) console.log(`user:      ${me.user_id}`)
  if (me.api_key_id) console.log(`api key:   ${me.api_key_id}`)
  if (me.sandbox_id) console.log(`sandbox:   ${me.sandbox_id}`)
}

export function registerMe(program: Command): void {
  program
    .command('me')
    .description('Show the identity behind the current credential (GET /v1/me)')
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        // Fail fast with the login hint when no credential exists anywhere;
        // without this the request would go out unauthenticated and come back
        // as a 401.
        requireToken()
        const me = await new ApiClient().whoami()
        if (opts.json) {
          printJson(me)
          return
        }
        renderMe(me)
      })
    })
}
