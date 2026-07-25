import type { Command } from 'commander'
import { InvalidArgumentError } from 'commander'
import { ApiClient } from '../lib/api'
import { collect, parseWhen, toInt } from '../lib/args'
import { alsoKnownAs, apiRoutes } from '../lib/help'
import { printJson, printTable, runAction } from '../lib/output'
import type {
  AnalyticsAccountType,
  AnalyticsWindowQuery,
  ReviewerUsage,
} from '../lib/types'

// `agent analytics` is the same aggregation behind the dashboard's analytics
// page, so questions like "which apps review the most PRs?" are answerable
// from the terminal (`agent analytics reviewer --account-type bot`).
// Human-readable tables by default; --json prints the raw API response.

// Window flags shared by every subcommand. The server defaults to the last
// 30 days; `--days` is mutually exclusive with `--since`.
interface WindowOpts {
  days?: number
  since?: string
  until?: string
}

function windowQuery(opts: WindowOpts): AnalyticsWindowQuery {
  return { days: opts.days, start: opts.since, end: opts.until }
}

// The window flags plus the route line, in that order, so `--help` ends with
// the API detail rather than burying the usage note under it.
function addWindow(cmd: Command, route: string): Command {
  return apiRoutes(
    cmd
      .option('--days <n>', 'look back N days (default: 30)', toInt)
      .option('--since <when>', 'window start, which excludes --days', (v: string) => parseWhen(v))
      .option('--until <when>', 'window end (default: now)', (v: string) => parseWhen(v))
      .addHelpText(
        'after',
        '\n--since/--until accept ISO 8601 or "today", "yesterday", "N days ago".',
      ),
    route,
  )
}

function toAccountType(value: string): AnalyticsAccountType {
  if (value === 'all' || value === 'user' || value === 'bot') return value
  throw new InvalidArgumentError(`expected all, user, or bot; got "${value}"`)
}

const REVIEWER_SORT_KEYS = {
  reviews: (r: ReviewerUsage) => r.reviews,
  approved: (r: ReviewerUsage) => r.approved,
  'changes-requested': (r: ReviewerUsage) => r.changes_requested,
  comments: (r: ReviewerUsage) => r.comments,
  lines: (r: ReviewerUsage) => r.lines_reviewed,
} as const

type ReviewerSort = keyof typeof REVIEWER_SORT_KEYS

function toReviewerSort(value: string): ReviewerSort {
  if (value in REVIEWER_SORT_KEYS) return value as ReviewerSort
  throw new InvalidArgumentError(
    `expected one of ${Object.keys(REVIEWER_SORT_KEYS).join(', ')}; got "${value}"`,
  )
}

export function registerAnalytics(program: Command): void {
  // "analytics" is a mass noun, so it has no singular form to alias.
  const analytics = program
    .command('analytics')
    .description('Aggregate pull request and review activity across the org')

  addWindow(
    alsoKnownAs(
      analytics
        .command('reviewer')
        .description('Rank who reviews the most PRs, people and apps alike'),
      'reviewers',
    ),
    'GET /v1/analytics/metrics',
  )
    .option(
      '-r, --repo <owner/name>',
      'filter by repository (repeatable)',
      collect,
      [] as string[],
    )
    .option(
      '--account-type <type>',
      'all | user (humans) | bot (apps/agents)',
      toAccountType,
      'all' as AnalyticsAccountType,
    )
    .option(
      '--sort <field>',
      `sort by ${Object.keys(REVIEWER_SORT_KEYS).join(' | ')}`,
      toReviewerSort,
      'reviews' as ReviewerSort,
    )
    .option('-l, --limit <n>', 'max reviewers to show', toInt, 10)
    .option('--json', 'output raw JSON (the sorted reviewer list)')
    .action(
      async (opts: WindowOpts & {
        repo: string[]
        accountType: AnalyticsAccountType
        sort: ReviewerSort
        limit: number
        json?: boolean
      }) => {
        await runAction(async () => {
          const res = await new ApiClient().getAnalyticsMetrics({
            ...windowQuery(opts),
            repo: opts.repo.length > 0 ? opts.repo : undefined,
            account_type: opts.accountType,
          })
          const key = REVIEWER_SORT_KEYS[opts.sort]
          const reviewers = [...res.reviewers]
            .sort((a, b) => key(b) - key(a))
            .slice(0, opts.limit)
          if (opts.json) {
            printJson(reviewers)
            return
          }
          if (reviewers.length === 0) {
            console.log('no reviews in this window')
            return
          }
          printTable(
            ['reviewer', 'reviews', 'approved', 'changes req', 'comments', 'lines reviewed'],
            reviewers.map((r) => [
              r.login,
              String(r.reviews),
              String(r.approved),
              String(r.changes_requested),
              String(r.comments),
              r.lines_reviewed.toLocaleString(),
            ]),
          )
        })
      },
    )

  addWindow(
    alsoKnownAs(
      analytics
        .command('pr')
        .description('Show pull request volume and trend, split human vs bot'),
      'prs',
    ),
    'GET /v1/analytics/pull-requests',
  )
    .option(
      '--account-type <type>',
      'all | user (humans) | bot (apps/agents)',
      toAccountType,
      'all' as AnalyticsAccountType,
    )
    .option(
      '--status <status>',
      'filter by PR status: open | draft | merged | closed (repeatable)',
      collect,
      [] as string[],
    )
    .option('--json', 'output raw JSON (totals, per-day series, facets, recent PRs)')
    .action(
      async (opts: WindowOpts & {
        accountType: AnalyticsAccountType
        status: string[]
        json?: boolean
      }) => {
        await runAction(async () => {
          // The pull-requests endpoint filters by raw GitHub account types
          // ("User"/"Bot"), unlike the all|user|bot enum elsewhere; map here so
          // the CLI flag reads the same across subcommands.
          const accountTypes =
            opts.accountType === 'user'
              ? ['User']
              : opts.accountType === 'bot'
                ? ['Bot']
                : undefined
          const res = await new ApiClient().getAnalyticsPullRequests({
            ...windowQuery(opts),
            account_type: accountTypes,
            status: opts.status.length > 0 ? opts.status : undefined,
          })
          if (opts.json) {
            printJson(res)
            return
          }
          const t = res.totals
          const sum = (pick: (d: (typeof res.series)[number]) => number) =>
            res.series.reduce((acc, d) => acc + pick(d), 0)
          console.log(`prs opened:      ${t.prs.toLocaleString()} (${sum((d) => d.prs_human).toLocaleString()} human, ${sum((d) => d.prs_bot).toLocaleString()} bot)`)
          console.log(`prs merged:      ${t.merged.toLocaleString()}`)
          console.log(`lines changed:   ${t.lines.toLocaleString()}`)
          console.log(`commits:         ${t.commits.toLocaleString()}`)
          console.log(`active authors:  ${t.active_authors.toLocaleString()}`)
          console.log(`merge time p50:  ${t.merge_time_p50_hours.toFixed(1)}h`)
          if (res.truncated) {
            console.log('note: window hit the server scan cap; figures undercount')
          }
        })
      },
    )

  addWindow(
    alsoKnownAs(
      analytics
        .command('review')
        .description('Show review totals, verdicts, and the top reviewers'),
      'reviews',
    ),
    'GET /v1/analytics/reviews',
  )
    .option(
      '-r, --repo <name>',
      'filter by repository name (bare name, repeatable)',
      collect,
      [] as string[],
    )
    .option(
      '--author <login>',
      'filter by reviewer login (repeatable)',
      collect,
      [] as string[],
    )
    .option(
      '--account-type <type>',
      'all | user (humans) | bot (apps/agents)',
      toAccountType,
      'all' as AnalyticsAccountType,
    )
    .option(
      '--review-state <state>',
      'filter by verdict: APPROVED | CHANGES_REQUESTED | COMMENTED (repeatable)',
      collect,
      [] as string[],
    )
    .option('-l, --limit <n>', 'max reviewers to show', toInt, 10)
    .option('--json', 'output raw JSON (feeds, per-day series, totals, facets)')
    .action(
      async (opts: WindowOpts & {
        repo: string[]
        author: string[]
        accountType: AnalyticsAccountType
        reviewState: string[]
        limit: number
        json?: boolean
      }) => {
        await runAction(async () => {
          const res = await new ApiClient().getAnalyticsReviews({
            ...windowQuery(opts),
            repo: opts.repo.length > 0 ? opts.repo : undefined,
            author: opts.author.length > 0 ? opts.author : undefined,
            account_type: opts.accountType,
            review_state: opts.reviewState.length > 0 ? opts.reviewState : undefined,
          })
          if (opts.json) {
            printJson(res)
            return
          }
          const t = res.totals
          console.log(`reviews:       ${t.reviews.toLocaleString()}`)
          console.log(`reviewers:     ${t.reviewers.toLocaleString()}`)
          console.log(`prs reviewed:  ${t.prs.toLocaleString()}`)
          console.log(`comments:      ${t.comments.toLocaleString()} (${t.comments_human.toLocaleString()} human, ${t.comments_bot.toLocaleString()} bot)`)
          console.log(`reactions:     ${t.thumbs_up.toLocaleString()} 👍  ${t.thumbs_down.toLocaleString()} 👎`)
          const authors = res.facets.authors.slice(0, opts.limit)
          if (authors.length > 0) {
            console.log('\ntop reviewers:')
            printTable(
              ['reviewer', 'type', 'reviews'],
              authors.map((a) => [
                a.login,
                a.account_type ?? '-',
                String(a.reviews),
              ]),
            )
          }
        })
      },
    )
}
