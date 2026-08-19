import { type Command } from 'commander'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname } from 'node:path'
import { api, APIError } from '../lib/api'
import { alsoKnownAs, apiRoutes } from '../lib/help'
import { repoFromCwd } from '../lib/laptop'
import { formatTs, printJson, printTable, relativeAge, runAction, usdFromMillicents } from '../lib/output'
import { watchSessionStreaming } from './session'
import type { Ellipsis } from '@ellipsis-dev/sdk'
import type {
  CodeReviewRunStatus,
  CreateReviewRequest,
  Finding,
  Review,
  ReviewScope,
} from '../lib/types'

// `agent review`: ask for a code review now, instead of waiting for a push to
// trigger one.
//
//   agent review 5975                 review that pull request
//
// A review is always of an existing pull request: the range, the checkout, and
// the delivery all read PR state, so there is nothing to review without one.
//
// Which pipeline runs is not a parameter. It is resolved from the repository's
// committed `code_review.yaml` (see `agent review init`), the same way an
// automatic review resolves it.
//
// A review is a pipeline of stage sessions, not a single session: its id is a
// `crun_…`, and each stage's session id lives in `stages[]`.

// How long to wait between REST polls when the stream isn't available.
const FALLBACK_POLL_INTERVAL_SECONDS = 3

// The only paths a committed pipeline may live at, in the precedence order the
// server resolves them (CODE_REVIEW_CONFIG_PATHS). A file anywhere else is a
// hard sync error, never a silently-unused config.
const DEFAULT_PIPELINE_PATH = 'code_review.yaml'
const NESTED_PIPELINE_PATH = '.ellipsis/code_review.yaml'

export function registerReview(program: Command): void {
  const review = alsoKnownAs(
    program.command('review').description('Review a pull request on demand'),
    'reviews',
    'code-review',
    'cr',
  )

  apiRoutes(
    review
      .command('start <pull-request>', { isDefault: true })
      .description('Review a pull request by number'),
    'POST /reviews',
    'WS /sessions/{id}/stream',
    'GET /reviews/{id}',
  )
    .option('--repo <owner/name>', 'repository to review (default: this git remote)')
    .option('--full', 're-review the whole pull request, not just the new commits')
    .option('--watermark <sha>', 'pin the range start (a commit SHA)')
    .option('--head <sha>', 'pin the range end (a commit SHA)')
    .option('--no-post', 'do not post to GitHub; print the findings here instead')
    .option('--no-wait', 'print the review id and exit instead of waiting for findings')
    .option('--cwd <path>', 'repository directory (default: current directory)')
    .option('--json', 'output raw JSON')
    .action(async (pullRequest: string, opts: StartOptions) => {
      await runAction(async () => {
        const client = api()
        const request = buildCreateRequest(pullRequest, opts)
        const started = await client.reviews.create(request)

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
        // Same two-step `agent file get` uses.
        if (!opts.json) {
          console.log(
            `✓ reviewing ${request.owner}/${request.repo}#${started.pull_request.number} ` +
              `(${started.id})`,
          )
        }
        await watchSessionStreaming(client, started.id, FALLBACK_POLL_INTERVAL_SECONDS, false)
        const finished = await client.reviews.get(started.id)
        if (opts.json) printJson(finished)
        else renderReview(finished)
      })
    })

  apiRoutes(
    review
      .command('get <review-id>')
      .description("Print a review's findings, scope, and whether it posted"),
    'GET /reviews/{id}',
  )
    .option('--json', 'output raw JSON')
    .action(async (reviewId: string, opts: { json?: boolean }) => {
      await runAction(async () => {
        const found = await getReviewOrExplain(api(), reviewId)
        if (opts.json) printJson(found)
        else renderReview(found)
      })
    })

  apiRoutes(
    alsoKnownAs(
      review.command('list').description("List a pull request's reviews, newest first"),
      'ls',
    ),
    'GET /reviews',
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
        const reviews = (
          await api().reviews.list({
            owner: repo?.owner,
            repo: repo?.name,
            pull_request_number: opts.pr,
            status: opts.status,
            limit: opts.limit,
          })
        ).items
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

  registerReviewInit(review)
}

// `agent review init`: the code review twin of `agent config init`. Scaffolds a
// starter pipeline YAML locally; you commit it and Ellipsis syncs it from
// GitHub. No API call and no pull request, because `agent config create` posts
// an agent config and a pipeline is a different kind of file.
function registerReviewInit(review: Command): void {
  review
    .command('init [path]')
    .description(
      `Scaffold a starter code review pipeline YAML locally (default: ${DEFAULT_PIPELINE_PATH})`,
    )
    // No `-f` short: CLI-wide, `-f` means an input file.
    .option('--force', 'overwrite the file if it already exists')
    .action((path: string | undefined, opts: { force?: boolean }) => {
      const target = path ?? DEFAULT_PIPELINE_PATH
      // Refuse a path the server would reject at sync: writing a file that can
      // never run is worse than not writing one, because it looks like it works.
      if (target !== DEFAULT_PIPELINE_PATH && target !== NESTED_PIPELINE_PATH) {
        console.error(
          `error: a code review pipeline must live at '${DEFAULT_PIPELINE_PATH}' or ` +
            `'${NESTED_PIPELINE_PATH}'; '${target}' is never used`,
        )
        process.exitCode = 1
        return
      }
      if (existsSync(target) && !opts.force) {
        console.error(`error: ${target} already exists (use --force to overwrite)`)
        process.exitCode = 1
        return
      }
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, starterPipeline(pipelineName()))
      console.log(`✓ wrote ${target}`)
      console.log(
        'Commit it to your default branch. Ellipsis syncs code review pipelines from GitHub.',
      )
    })
}

// Both legal paths share one filename, so the file can't name the pipeline.
// Use the repository instead, falling back to the filename outside a checkout.
function pipelineName(): string {
  const repo = repoFromCwd(process.cwd())
  return repo ? `${repo.split('/')[1]} code review` : 'code review'
}

// A minimal valid pipeline. `ellipsis.kind` is the only field the schema
// requires; every stage left unset runs the platform's default reviewers.
//
// Deliberately omits `pull_requests.repositories`: a file's location IS its
// scope now, so naming repositories is a sync error everywhere except the
// org-wide copy in the `.ellipsis` repository. Exported for tests.
export function starterPipeline(name: string): string {
  return `# Ellipsis code review pipeline. Commit this to your default branch; Ellipsis
# syncs it from GitHub. It must live at '${DEFAULT_PIPELINE_PATH}' or
# '${NESTED_PIPELINE_PATH}'; a pipeline anywhere else is never used.
#
# Where it sits decides what it reviews: in a normal repository it reviews that
# repository, and in your organization's '.ellipsis' repository it reviews every
# repository. The kind line is what makes this a review pipeline, not an agent.
ellipsis:
  version: v1
  kind: code_review
  name: ${name}
  description: What this pipeline reviews.

# Which pull requests to review. Omit this to review every pull request.
# pull_requests:
#   base: [main]
#   draft: false
#   paths: ["src/**"]
#   for: { bots: false }

# Every stage is optional. With all of them unset, reviews run the platform
# default pipeline: a pull request description writer plus one bug reviewer.
#
# review:
#   - name: migration-safety
#     claude:
#       system: |
#         Review SQL migrations for locks that block writes on a large table.
#     pull_requests:
#       paths: ["sql/migrations/**"]
#
# Declaring a filter stage adds a gatekeeper that judges what the reviewers
# found. There is no gatekeeper unless you declare one.
#
# filter:
#   name: gatekeeper
#   claude:
#     system: |
#       Drop any finding that is not worth the author's time.

budget:
  run: 2.00
  day: 20.00
  week: 75.00
`
}

interface StartOptions {
  repo?: string
  full?: boolean
  watermark?: string
  head?: string
  // commander sets these false for --no-* flags.
  post: boolean
  wait: boolean
  cwd?: string
  json?: boolean
}

interface ListOptions {
  repo?: string
  pr?: number
  status?: CodeReviewRunStatus
  limit?: number
  json?: boolean
}

// Assemble the request. Exported for tests.
export function buildCreateRequest(
  pullRequest: string,
  opts: StartOptions,
): CreateReviewRequest {
  const cwd = opts.cwd ?? process.cwd()
  const repo = splitRepo(opts.repo ?? repoFromCwdOrThrow(cwd))
  return {
    owner: repo.owner,
    repo: repo.name,
    scope: buildScope(opts),
    pull_request_number: parsePullRequest(pullRequest),
    post: opts.post,
  }
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

async function getReviewOrExplain(client: Ellipsis, reviewId: string): Promise<Review> {
  try {
    return await client.reviews.get(reviewId)
  } catch (err) {
    // The likeliest mistake is handing this a stage session id (or any other
    // session id) instead of the review's own — indistinguishable from an
    // unknown id server-side, on purpose.
    if (err instanceof APIError && err.status === 404) {
      throw new Error(`no review with id ${reviewId} (a review id looks like crun_…)`)
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
      `'${raw}' is not a pull request number. Pass a number (agent review 123). ` +
        'To run an agent with a prompt that starts with "review", quote it: ' +
        `agent "review ${raw} …"`,
    )
  }
  return Number.parseInt(match[1], 10)
}

function parsePositiveInt(raw: string): number {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid count '${raw}'`)
  return n
}
