import type { Command } from 'commander'
import { ApiClient } from '../lib/api'
import { printJson, runAction, usd, usdFromMillicents } from '../lib/output'

export function registerUsage(program: Command): void {
  program
    .command('budget')
    .description('Show the current budget summary (GET /v1/budget)')
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const b = await new ApiClient().getBudget()
        if (opts.json) {
          printJson(b)
          return
        }
        const pct = (b.fraction_used * 100).toFixed(1)
        console.log(`period:     ${b.period}`)
        console.log(`spent:      ${usd(b.spent_usd)} of ${usd(b.budget_usd)} (${pct}%)`)
        console.log(`remaining:  ${usd(b.remaining_usd)}`)
        console.log(`pause at limit: ${b.pause_at_limit ? 'yes' : 'no'}`)
      })
    })

  program
    .command('usage')
    .description('Show the usage dashboard for the current period (GET /v1/usage)')
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const u = await new ApiClient().getUsage()
        if (opts.json) {
          printJson(u)
          return
        }
        console.log(`period:  ${u.period_start} → ${u.period_end}`)
        console.log(`tokens:  ${u.total_tokens.toLocaleString()}`)
        console.log(`cost:    ${usdFromMillicents(u.total_cost_millicents)}`)
        if (u.by_model.length > 0) {
          console.log('\nby model:')
          for (const m of u.by_model) {
            const cost = usdFromMillicents(
              m.cost_tokens_millicents +
                m.cost_sandbox_cpu_millicents +
                m.cost_sandbox_memory_millicents +
                m.cost_fee_millicents,
            )
            console.log(`  ${m.model_id.padEnd(28)} ${m.tokens.toLocaleString().padStart(14)}  ${cost}`)
          }
        }
      })
    })
}
