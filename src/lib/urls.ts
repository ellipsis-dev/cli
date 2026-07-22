// Builders for clickable dashboard (web app) links. Pure string functions so
// they're unit-testable; callers pass the resolved app base (resolveAppBase)
// and the customer's account login (from GET /v1/me — the routes are scoped by
// login). Mirrors the backend's link format in github_brand.py.

// Sessions open on the account page with the session picked out by query
// param (the app routes /{login}?session={id}).
export function sessionUrl(appBase: string, accountLogin: string, sessionId: string): string {
  return `${appBase}/${encodeURIComponent(accountLogin)}?session=${encodeURIComponent(sessionId)}`
}

// The agent (config) detail page is keyed by the config id (agent_id == config_id).
export function configUrl(appBase: string, accountLogin: string, configId: string): string {
  return `${appBase}/${encodeURIComponent(accountLogin)}/agents/configs/${encodeURIComponent(configId)}`
}

// The device-code approval page for `agent login`. `userCode` is the user_code
// minted by POST /v1/cli-auth/start. Built client-side from the active host's
// app base (not the server's verification_uri_complete) so the host always
// matches the instance the CLI is pointed at: the backend fills its own copy
// from an env var that defaults to prod, so a beta / self-hosted login would
// otherwise be sent to the prod dashboard, where a code minted against another
// instance can never be approved.
export function cliAuthUrl(appBase: string, userCode: string): string {
  return `${appBase}/cli-auth?code=${encodeURIComponent(userCode)}`
}

// Wrap `label` in an OSC 8 hyperlink so it opens `url` on click in terminals
// that support it (iTerm2, VS Code, WezTerm, kitty, GNOME); degrades to plain
// text elsewhere. Only emitted to a TTY — piped output stays free of escapes.
export function hyperlink(url: string, label: string, isTty = process.stdout.isTTY): string {
  if (!isTty) return label
  const OSC = ']8;;'
  const ST = '\\'
  return `${OSC}${url}${ST}${label}${OSC}${ST}`
}
