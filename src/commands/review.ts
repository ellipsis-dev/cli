import { type Command } from 'commander'
import { ApiClient, ApiError } from '../lib/api'
import { alsoKnownAs, apiRoutes } from '../lib/help'
import { createWipCommit, currentBranch, pushReviewBranch, repoFromCwd } from '../lib/laptop'
import { formatTs, printJson, printTable, relativeAge, runAction, usdFromMillicents } from '../lib/output'
import { watchSessionStreaming } from './session'
import type { CreateReviewRequest, Finding, Review, ReviewScope } from '../lib/types'

// `agent review`: ask for a code review now, instead of waiting for a push to
// trigger one. Two targets —
//
//   agent review 5975                 an existing pull request
//   agent review                      the work in your tree, right now
//
// The second is the interesting one: it snapshots your working tree, pushes it
// to a sidecar branch (never your own), and the platform finds-or-creates a
// draft PR to review it against — because a code review is structurally a PR
// review (the range, the checkout, and the delivery all read PR state). Those
// reviews are terminal-only: nothing is posted to GitHub, findings print here.
//
// A review IS a session under the hood, and a review id IS a session id — so
// `agent session get <review-id>`, `--watch`, records, and stop all work on it.

// How long to wait between REST polls when the stream isn't available.
const FALLBACK_POLL_INTERVAL_SECONDS = 3

export function registerReview(program: Command): void {
  const review = alsoKnownAs(
    program
      .command('review')
      .description('Review a pull request, or the work in your tree, on demand'),
    'reviews',
    'code-review',
    'cr',
  )

  apiRoutes(
    review
      .command('start [pull-request]', { isDefault: true })
      .description('Review a pull request by number, or your working tree if you omit one'),
    'POST /v1/reviews',
    'WS /v1/sessions/{id}/stream',
    'GET /v1/reviews/{id}',
  )
    .option('--repo <owner/name>', 'repository to review (default: this git remote)')
    .option(
      '--branch <name>',
      'review an already-pushed branch instead of snapshotting your tree',
    )
    .option('--full', 're-review the whole pull request, not just the new commits')
    .option('--watermark <sha>', 'pin the range start (a commit SHA)')
    .option('--head <sha>', 'pin the range end (a commit SHA)')
    .option('-c, --config <id>', 'run a saved agent config instead of the built-in reviewer')
    .option('-m, --model <model>', 'override the reviewer model (see `agent model list`)')
    .option('-b, --budget <usd>', 'override the budget for this review', parseUsd)
    .option('--no-post', 'do not post to GitHub; print the findings here instead')
    .option('--no-wait', 'print the review id and exit instead of waiting for findings')
    .option('--cwd <path>', 'repository directory (default: current directory)')
    .option('--json', 'output raw JSON')
    .action(async (pullRequest: string | undefined, opts: StartOptions) => {
      await runAction(async () => {
        const api = new ApiClient()
        const request = buildCreateRequest(pullRequest, opts)
        const local = request.branch !== undefined
        if (!opts.json && local) {
          console.log(`✓ pushed ${request.sha?.slice(0, 12)} to ${request.branch}`)
        }
        const started = await api.createReview(request)

        // Nothing new since the last review of this PR. Not an error — you
        // asked, and the honest answer is "already covered".
        if (started.status === 'skipped') {
          if (opts.json) printJson(started)
          else {
            console.log(
              `already reviewed at ${(started.scope.watermark ?? '').slice(0, 7)} — ` +
                'nothing new to review (use --full to re-review the whole PR)',
            )
          }
          return
        }

        if (!opts.wait) {
          if (opts.json) printJson(started)
          else {
            console.log(`✓ started review ${started.id}`)
            console.log(`  follow with: agent review get ${started.id}`)
          }
          return
        }

        // Block-and-stream, then re-read: the findings are collected from the
        // sandbox at teardown, so they only exist once the review finalizes.
        // Same two-step `agent asset get` uses.
        if (!opts.json) {
          console.log(
            `✓ reviewing ${request.owner}/${request.repo}#${started.pull_request.number} ` +
              `(${started.id})`,
          )
        }
        await watchSessionStreaming(api, started.id, FALLBACK_POLL_INTERVAL_SECONDS, false)
        const finished = await api.getReview(started.id)
        if (opts.json) printJson(finished)
        else renderReview(finished)
      })
    })

  apiRoutes(
    review
      .command('get <review-id>')
      .description("Print a review's findings, scope, and whether it posted"),
    'GET /v1/reviews/{id}',
  )
    .option('--json', 'output raw JSON')
    .action(async (reviewId: string, opts: { json?: boolean }) => {
      await runAction(async () => {
        const found = await getReviewOrExplain(new ApiClient(), reviewId)
        if (opts.json) printJson(found)
        else renderReview(found)
      })
    })

  apiRoutes(
    alsoKnownAs(
      review.command('list').description("List a pull request's reviews, newest first"),
      'ls',
    ),
    'GET /v1/reviews',
  )
    .option('--repo <owner/name>', 'only reviews of this repository')
    .option('--pr <number>', 'only reviews of this pull request', parsePositiveInt)
    .option('-s, --status <status>', 'only reviews in this session status')
    .option('-l, --limit <n>', 'max results (server cap: 200)', parsePositiveInt)
    .option('--json', 'output raw JSON')
    .action(async (opts: ListOptions) => {
      await runAction(async () => {
        const repo = opts.repo ? splitRepo(opts.repo) : undefined
        if (opts.pr !== undefined && repo === undefined) {
          throw new Error('--pr needs --repo <owner/name> to say which repository')
        }
        const reviews = await new ApiClient().listReviews({
          owner: repo?.owner,
          repo: repo?.name,
          pull_request_number: opts.pr,
          status: opts.status,
          limit: opts.limit,
        })
        if (opts.json) {
          printJson(reviews)
          return
        }
        if (reviews.length === 0) {
          console.log('No reviews.')
          return
        }
        printTable(
          ['ID', 'PR', 'STATUS', 'SCOPE', 'FINDINGS', 'POSTED', 'COST', 'AGE'],
          reviews.map((r) => [
            r.id,
            `${r.repository.owner}/${r.repository.name}#${r.pull_request.number}`,
            r.status,
            scopeWord(r),
            r.counters ? String(r.counters.n_parsed) : '-',
            r.posted_review_id ? String(r.posted_review_id) : r.post_error ? 'failed' : '-',
            usdFromMillicents(r.cost_millicents),
            r.created_at ? relativeAge(r.created_at) : '-',
          ]),
        )
      })
    })
}

interface StartOptions {
  repo?: string
  branch?: string
  full?: boolean
  watermark?: string
  head?: string
  config?: string
  model?: string
  budget?: number
  // commander sets these false for --no-* flags.
  post: boolean
  wait: boolean
  cwd?: string
  json?: boolean
}

interface ListOptions {
  repo?: string
  pr?: number
  status?: string
  limit?: number
  json?: boolean
}

// Assemble the request, doing the local path's git work when no pull request
// was named. Exported for tests.
export function buildCreateRequest(
  pullRequest: string | undefined,
  opts: StartOptions,
): CreateReviewRequest {
  const cwd = opts.cwd ?? process.cwd()
  const repo = splitRepo(opts.repo ?? repoFromCwdOrThrow(cwd))
  const scope = buildScope(opts)

  const common = {
    owner: repo.owner,
    repo: repo.name,
    scope,
    // The generated type requires every field the server defaults, so send the
    // empty default rather than omitting it.
    metadata: {},
    ...(opts.config ? { config_id: opts.config } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
  }

  if (pullRequest !== undefined) {
    return { ...common, pull_request_number: parsePullRequest(pullRequest), post: opts.post }
  }

  // The local path. Snapshot the tree and push it to a sidecar branch, so the
  // branch you are working on is never touched. ALWAYS terminal-only — the
  // pull request being reviewed is one the platform manufactured for the
  // purpose, so commenting on it would be talking to itself. Findings print
  // here instead. (`post` has no opt-in flag; --no-post only turns it off for
  // a real pull request.)
  const branch = opts.branch ?? sidecarFor(cwd)
  const sha = opts.branch ? undefined : pushSnapshot(cwd, branch)
  return { ...common, branch, ...(sha ? { sha } : {}), post: false }
}

// `--full`/`--watermark`/`--head` → the scope model. Default is incremental:
// only the commits since the last review, which is what the webhook does.
function buildScope(opts: StartOptions): ReviewScope {
  return {
    kind: opts.full ? 'full' : 'incremental',
    ...(opts.watermark ? { watermark: opts.watermark } : {}),
    ...(opts.head ? { head: opts.head } : {}),
  }
}

function sidecarFor(cwd: string): string {
  const branch = currentBranch(cwd)
  if (!branch) {
    throw new Error(
      'detached HEAD: check out a branch, or name a pull request (`agent review 123`)',
    )
  }
  return `ellipsis/review/${branch}`
}

// Snapshot the working tree and force-push it. Returns the pushed SHA, which
// pins the review's range end — GitHub's reported PR head lags a force-push.
function pushSnapshot(cwd: string, branch: string): string {
  const { sha } = createWipCommit(cwd)
  const realBranch = currentBranch(cwd)
  if (!realBranch) throw new Error('detached HEAD: check out a branch first')
  pushReviewBranch(cwd, sha, realBranch)
  return sha
}

async function getReviewOrExplain(api: ApiClient, reviewId: string): Promise<Review> {
  try {
    return await api.getReview(reviewId)
  } catch (err) {
    // A review id IS a session id, so the most likely mistake is handing this
    // the id of a session that isn't a review — indistinguishable from an
    // unknown id server-side, on purpose.
    if (err instanceof ApiError && err.status === 404) {
      throw new Error(`no review with id ${reviewId} (a review id looks like session_…)`)
    }
    throw err
  }
}

function renderReview(review: Review): void {
  console.log(`review:    ${review.id}`)
  console.log(
    `pr:        ${review.repository.owner}/${review.repository.name}` +
      `#${review.pull_request.number}  ${review.pull_request.url}`,
  )
  console.log(`status:    ${review.status}`)
  console.log(`scope:     ${scopeWord(review)}`)
  if (review.posted_review_id) console.log(`posted:    ${review.posted_review_id}`)
  if (review.post_error) console.log(`post:      failed — ${review.post_error}`)
  console.log(`cost:      ${usdFromMillicents(review.cost_millicents)}`)
  if (review.completed_at) console.log(`completed: ${formatTs(review.completed_at)}`)

  if (review.review_body) console.log(`\n${review.review_body.trim()}`)

  const findings = review.findings ?? []
  if (findings.length === 0) {
    // Distinguish "clean" from "not collected yet": the outbox row only exists
    // once the review finalizes.
    console.log(review.counters ? '\nNo findings.' : '\nStill running — no findings yet.')
    return
  }
  console.log('')
  // Highest severity first, the order the platform posts them in.
  for (const finding of [...findings].sort((a, b) => b.severity - a.severity)) {
    console.log(formatFinding(finding))
  }
  const counters = review.counters
  if (counters && counters.n_dropped > 0) {
    console.log(`(${counters.n_dropped} finding(s) could not be parsed)`)
  }
}

// One finding as a `path:line severity category` header plus its claim, so the
// output greps like a compiler's. Exported for tests.
export function formatFinding(finding: Finding): string {
  const lines =
    finding.end_line > finding.start_line
      ? `${finding.start_line}-${finding.end_line}`
      : String(finding.start_line)
  const head = `${finding.path}:${lines}  [${finding.severity}/5 ${finding.category}]`
  const body = [finding.claim, finding.evidence, finding.suggested_fix]
    .filter((part): part is string => Boolean(part && part.trim()))
    .map((part) => indent(part.trim()))
    .join('\n')
  // Anchored off the diff means it was recorded but never posted inline.
  const note =
    finding.anchor === 'not_commentable'
      ? indent('(outside the diff — recorded, not posted)')
      : ''
  return [head, body, note].filter(Boolean).join('\n') + '\n'
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')
}

function scopeWord(review: Review): string {
  const { watermark, head } = review.scope
  return `${(watermark ?? 'base').slice(0, 7)}...${(head ?? '').slice(0, 7)}`
}

function repoFromCwdOrThrow(cwd: string): string {
  const repo = repoFromCwd(cwd)
  if (!repo) {
    throw new Error(
      'not inside a git repository with an origin remote — pass --repo <owner/name>',
    )
  }
  return repo
}

export function splitRepo(value: string): { owner: string; name: string } {
  const [owner, name, ...rest] = value.split('/')
  if (!owner || !name || rest.length > 0) {
    throw new Error(`--repo must be owner/name (got '${value}')`)
  }
  return { owner, name }
}

// Accept `123` and `#123`, and a full PR URL, since all three get pasted.
export function parsePullRequest(raw: string): number {
  const match = /^#?(\d+)$/.exec(raw.trim()) ?? /\/pull\/(\d+)/.exec(raw.trim())
  if (!match) {
    // `review` reserves the word, so `agent review the auth changes` lands
    // here rather than starting a session with that prompt. Name the fix.
    throw new Error(
      `'${raw}' is not a pull request number. Pass a number (agent review 123), ` +
        'or omit it to review your working tree. To run an agent with a prompt ' +
        `that starts with "review", quote it: agent "review ${raw} …"`,
    )
  }
  return Number.parseInt(match[1], 10)
}

function parsePositiveInt(raw: string): number {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid count '${raw}'`)
  return n
}

function parseUsd(raw: string): number {
  const n = Number.parseFloat(raw)
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid budget '${raw}'`)
  return n
}
