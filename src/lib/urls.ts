// Builders for clickable dashboard (web app) links. Pure string functions so
// they're unit-testable; callers pass the resolved app base (resolveAppBase)
// and the customer's account login (from GET /v1/me — the routes are scoped by
// login). Mirrors the backend's link format in github_brand.py.

export function sessionUrl(appBase: string, accountLogin: string, sessionId: string): string {
  return `${appBase}/${encodeURIComponent(accountLogin)}/sessions/${encodeURIComponent(sessionId)}`
}

// The agent (config) detail page is keyed by the config id (agent_id == config_id).
export function configUrl(appBase: string, accountLogin: string, configId: string): string {
  return `${appBase}/${encodeURIComponent(accountLogin)}/agents/configs/${encodeURIComponent(configId)}`
}

// The device-code approval page for `agent login`. `userCode` is the user_code
// minted by POST /v1/cli-auth/start. Built client-side from the resolved app
// base (not the server's verification_uri_complete) so the host always matches
// the API base the CLI is pointed at: the backend fills its own copy from an
// env var that defaults to prod, so a beta/dev login is otherwise sent to the
// prod dashboard where a code minted against another environment can never be
// approved.
export function cliAuthUrl(appBase: string, userCode: string): string {
  return `${appBase}/cli-auth?code=${encodeURIComponent(userCode)}`
}
