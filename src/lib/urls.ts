// Builders for clickable dashboard (web app) links. Pure string functions so
// they're unit-testable; callers pass the resolved app base (resolveAppBase)
// and the customer's account login (from GET /v1/me — the routes are scoped by
// login). Mirrors the backend's link format in github_brand.py.

export function runUrl(appBase: string, accountLogin: string, runId: string): string {
  return `${appBase}/${encodeURIComponent(accountLogin)}/agents/runs/${encodeURIComponent(runId)}`
}

// The agent (config) detail page is keyed by the config id (agent_id == config_id).
export function configUrl(appBase: string, accountLogin: string, configId: string): string {
  return `${appBase}/${encodeURIComponent(accountLogin)}/agents/${encodeURIComponent(configId)}`
}
