// Builders for clickable dashboard (web app) links. Pure string functions so
// they're unit-testable; callers pass the resolved app base (resolveAppBase)
// and the customer's account login (from GET /me — the routes are scoped by
// login). Mirrors the backend's link format in github_brand.py.

// Sessions open on the account page with the session picked out by query
// param (the app routes /{login}?session={id}).
export function sessionUrl(appBase: string, accountLogin: string, sessionId: string): string {
  return `${appBase}/${encodeURIComponent(accountLogin)}?session=${encodeURIComponent(sessionId)}`
}

// The automation detail page, keyed by the automation id.
export function automationUrl(appBase: string, accountLogin: string, automationId: string): string {
  return `${appBase}/${encodeURIComponent(accountLogin)}/automations/${encodeURIComponent(automationId)}`
}

// The device-code approval page for `ellipsis auth login`. `userCode` is the user_code
// minted by POST /cli-auth/start. Built client-side from the active host's
// app base (not the server's verification_uri_complete) so the host always
// matches the instance the CLI is pointed at: the backend fills its own copy
// from an env var that defaults to prod, so a beta / self-hosted login would
// otherwise be sent to the prod dashboard, where a code minted against another
// instance can never be approved.
export function cliAuthUrl(appBase: string, userCode: string): string {
  return `${appBase}/cli-auth?code=${encodeURIComponent(userCode)}`
}
