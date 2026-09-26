import type { Command } from 'commander'
import { api } from '../lib/api'
import { apiRoutes } from '../lib/help'
import { printJson, runAction, usd, usdFromMillicents } from '../lib/output'
import type { BudgetSummary } from '../lib/types'

export function budgetLines(budget: BudgetSummary): string[] {
  return [
    `credit:     ${usd(budget.credit_balance_usd)}${budget.credit_exhausted ? ' (exhausted)' : ''}`,
    `as of:      ${budget.as_of}`,
    '',
    ...budget.windows.map((window) => {
      const period = `trailing ${window.window_days} ${window.window_days === 1 ? 'day' : 'days'}`
      const used = `${(window.fraction_used * 100).toFixed(1)}%`
      const exhausted = window.exhausted ? ' (exhausted)' : ''
      return `${period}: ${usd(window.spent_usd)} of ${usd(window.limit_usd)} (${used}), ${usd(window.remaining_usd)} remaining${exhausted}`
    }),
  ]
}

export function registerUsage(program: Command): void {
  apiRoutes(
    program
      .command('budget')
      .description('Show prepaid credit and trailing account budgets'),
    'GET /v1/account/budget',
  )
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const b = await api().account.budget()
        if (opts.json) {
          printJson(b)
          return
        }
        for (const line of budgetLines(b)) console.log(line)
      })
    })

  apiRoutes(
    program
      .command('usage')
      .description("Show this period's tokens and cost, broken down by model"),
    'GET /v1/account/usage',
  )
    .option('--json', 'output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      await runAction(async () => {
        const u = await api().account.usage()
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
                m.cost_cpu_millicents +
                m.cost_memory_millicents +
                m.cost_fee_millicents,
            )
            console.log(
              `  ${m.model_id.padEnd(28)} ${m.tokens.toLocaleString().padStart(14)}  ${cost}`,
            )
          }
        }
      })
    })
}
