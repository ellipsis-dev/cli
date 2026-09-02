// The CLI's names for the API's types.
//
// Every wire shape comes from @ellipsis-dev/sdk — generated from the server's
// OpenAPI spec, never hand-written — and is re-exported here under the name the
// CLI uses so a rename on the server surfaces as a type error rather than a
// field that silently reads `undefined`. Only the CLI's own local shapes
// (query-option bags it assembles before calling, and the loosely-typed GitHub
// user it caches on disk) are declared here.

import type {
  components,
  Ellipsis,
  SessionRecord as SessionRecordFrame,
  SessionMessage as SessionMessageFrame,
} from '@ellipsis-dev/sdk'

type S = components['schemas']

// --------------------------- sessions & records ---------------------------

export type AgentSession = S['Session']
export type AgentSessionSource = S['SessionSource']
export type AgentSessionStatus = S['SessionStatus']
export type SessionState = S['SessionState']
export type SessionSurface = S['SessionSurface']
export type SessionPrompting = S['SessionPrompting']
// The frames flavor, not `S['SessionRecord']`: the spec marks defaulted fields
// optional, but on the wire the server always serializes every field, and the
// SDK's transcript store types its inputs this way. Using it here keeps records
// flowing from REST straight into the store without a cast at each call site.
export type SessionRecord = SessionRecordFrame
export type SessionMessage = SessionMessageFrame
export type ListSessionRecordsResponse = S['SessionRecordsListResponse']
export type ListAgentSessionsResponse = S['SessionsListResponse']
export type StartAgentSessionRequest = NonNullable<Parameters<Ellipsis['sessions']['start']>[0]>
export type SessionResponse = S['SessionResponse']
export type SendSessionMessageRequest = S['SendSessionMessageRequest']
export type SessionLogSegment = S['SessionLogSegment']
export type GetSessionLogResponse = S['GetSessionLogResponse']

export type GithubAccountSnippet = S['GithubAccountSnippet']

// ----------------------------- automations ---------------------------------

export type AgentConfig = S['AgentConfig']
export type Automation = S['Automation']
export type ListAutomationsResponse = S['AutomationsListResponse']
export type CreateAutomationRequest = Parameters<Ellipsis['automations']['create']>[0]
export type CreatedAutomation = S['AutomationResponse']
export type ConfigManagedBy = S['ConfigManagedBy']
export type LinkedAutomation = S['LinkAutomationResponse']

// ------------------------------ environments -------------------------------

export type EnvironmentConfig = S['EnvironmentConfig']
export type SavedEnvironment = S['Environment']
export type ListEnvironmentsResponse = S['EnvironmentsListResponse']

// -------------------------------- templates -------------------------------

export type AgentTemplate = S['AgentTemplate']
export type ListAgentTemplatesResponse = S['AgentTemplatesListResponse']

// --------------------------------- models ---------------------------------

export type ModelManufacturer = S['ModelManufacturer']
export type ModelRateCard = S['ModelRateCardApi']
export type SupportedModel = S['Model']
export type GetSupportedModelsResponse = S['ModelsListResponse']

// -------------------------------- reviews ---------------------------------
// A review's `id` IS a session id, so the session types above apply to it
// unchanged — hence no review-specific status, stream, or cost type.

export type Review = S['Review']
export type ReviewScope = S['ReviewScope']
export type ResolvedReviewScope = S['ResolvedReviewScope']
export type ReviewCounters = S['ReviewCounters']
export type Finding = S['ReviewFinding']
export type CreateReviewRequest = S['CreateReviewRequest']
export type ListReviewsResponse = S['ReviewsListResponse']
export type CodeReviewRunStatus = S['CodeReviewRunStatus']

// --------------------------------- files ----------------------------------

export type FileView = S['File']
export type CreateFileRequest = Parameters<Ellipsis['files']['create']>[0]
export type CreateFileResponse = S['CreateFileResponse']
export type GetFileResponse = S['GetFileResponse']
export type ListFilesResponse = S['FilesListResponse']

// ------------------------------- secrets ----------------------------------
// Customer-scoped environment variables injected into a sandbox when an agent
// config names them. Values are write-only: the API accepts them but never
// returns them, so the summary carries only the name and timestamps.

export type SandboxVariableSummary = S['Secret']
export type SandboxVariableInput = S['SecretInput']
export type GetSandboxVariablesResponse = S['SecretsListResponse']
export type PutSandboxVariablesRequest = S['PutSecretsRequest']

// ----------------------------- usage / budget -----------------------------

export type BudgetWindow = S['BudgetWindow']
export type BudgetSummary = S['BudgetSummary']
export type UsageDailyPoint = S['UsageDailyPoint']
export type ModelUsageBreakdown = S['ModelUsageBreakdown']
export type UsageDashboard = S['GetUsageDashboardResponse']

// ------------------------------- analytics --------------------------------

export type AnalyticsAccountType = 'all' | 'user' | 'bot'
export type AnalyticsMetricsTotals = S['AnalyticsMetricsTotals']
export type AnalyticsRepoUsage = S['AnalyticsRepoUsage']
export type ContributorUsage = S['ContributorUsage']
export type ReviewerUsage = S['ReviewerUsage']
export type ReviewAuthorFacet = S['ReviewAuthorFacet']
export type ReviewsDayBucket = S['ReviewsDayBucket']
export type ReviewsTotals = S['ReviewsTotals']
export type PullRequestsDayBucket = S['PullRequestsDayBucket']
export type PullRequestsTotals = S['PullRequestsTotals']
export type GetAnalyticsMetricsResponse = S['GetAnalyticsMetricsResponse']
export type GetAnalyticsPullRequestsResponse = S['GetAnalyticsPullRequestsResponse']
export type GetAnalyticsReviewsResponse = S['GetAnalyticsReviewsResponse']

// -------------------------- integration discovery -------------------------

export type GetIntegrationsResponse = S['GetIntegrationsResponse']
export type GithubIntegrationSummary = S['GithubIntegrationSummary']
export type SlackIntegrationSummary = S['SlackIntegrationSummary']
export type LinearIntegrationSummary = S['LinearIntegrationSummary']
export type JiraIntegrationSummary = S['JiraIntegrationSummary']
export type SentryOrganizationSummary = S['SentryOrganizationSummary']
export type RepositorySummary = S['GithubRepository']
export type GithubMemberSummary = S['GithubMember']
export type SlackMemberSummary = S['SlackMember']
export type SlackChannelSummary = S['SlackChannel']
export type LinearTeamSummary = S['LinearTeam']
export type LinkedSlackIdentity = S['LinkedSlackIdentity']
export type LinkedGithubIdentity = S['LinkedGithubIdentity']
export type ListGithubRepositoriesResponse = S['GithubRepositoriesListResponse']
export type ListGithubMembersResponse = S['GithubMembersListResponse']
export type ListSlackChannelsResponse = S['SlackChannelsListResponse']
export type ListSlackMembersResponse = S['SlackMembersListResponse']
export type ListLinearTeamsResponse = S['LinearTeamsListResponse']
export type ListSentryOrganizationsResponse = S['SentryOrganizationsListResponse']

// -------------------------------- identity --------------------------------

export type WhoAmI = S['WhoAmIResponse']

// The GitHub user behind a user_id. Loosely typed on purpose: the CLI only
// reads `login`, and this shape is also what it caches to disk, where an older
// binary's copy must stay readable.
export interface GhUser {
  id: number
  login: string
  name: string | null
  [key: string]: unknown
}

// ------------------------------- cli auth ---------------------------------

export type CliAuthStart = S['StartCliAuthResponse']
export type CliAuthPoll = S['PollCliAuthResponse']
export type CliAuthPollStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'already_claimed'

// ------------------------- CLI-local query shapes -------------------------
// The option bags the CLI assembles before calling the SDK. They mirror the
// generated methods' parameter objects; they exist so command modules can name
// and pass around a query without importing the SDK's inline parameter types.

export interface ListAgentSessionsQuery {
  // An automation id or name: only sessions that automation started.
  automation?: string
  source?: AgentSessionSource[]
  days?: number
  start?: string
  end?: string
  limit?: number
  // A GitHub account id (`agent github members`); scopes the list to sessions
  // attributed to that developer. The CLI resolves it from a --author login.
  author_id?: number
  // "owner/name" or a bare repository name. Sessions that name their
  // repository only inside their agent config — dashboard starts, cron runs,
  // handoffs — do not match.
  repo?: string
  // Keep only the conversations still going (live or sleeping), dropping the
  // ones that completed, errored, or were stopped. A session parked between
  // turns counts as unfinished.
  unfinished?: boolean
}

export interface ListFilesQuery {
  // Scope to one run's uploads.
  session_id?: string
  limit?: number
}

export interface ListReviewsQuery {
  owner?: string
  repo?: string
  pull_request_number?: number
  status?: S['CodeReviewRunStatus']
  limit?: number
}

// Shared analytics window: explicit start/end (ISO timestamps) or a `days`
// look-back (mutually exclusive with start; server default: last 30 days).
export interface AnalyticsWindowQuery {
  days?: number
  start?: string
  end?: string
}

export interface AnalyticsMetricsQuery extends AnalyticsWindowQuery {
  repo?: string[] // "owner/name"
  author?: string[] // PR-author logins
  account_type?: AnalyticsAccountType
  status?: string[] // open | draft | merged | closed
}

export interface AnalyticsPullRequestsQuery extends AnalyticsWindowQuery {
  // Raw GithubAccountType strings ("User", "Bot"), unlike the metrics/reviews
  // account_type enum — mirrors the backend filter.
  account_type?: string[]
  repository_id?: number[]
  author_id?: number[]
  status?: string[]
}

export interface AnalyticsReviewsQuery extends AnalyticsWindowQuery {
  repo?: string[] // bare repo names (matching the review facet values)
  author?: string[] // reviewer logins
  account_type?: AnalyticsAccountType
  review_state?: string[] // APPROVED | CHANGES_REQUESTED | COMMENTED | ...
}
