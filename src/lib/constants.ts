import pkg from '../../package.json'

// package.json is the single source of truth for the version; tsup (esbuild),
// `bun build --compile`, and tsx all inline this JSON import, so the binary,
// `--version`, and the User-Agent below never drift from the published version.
export const VERSION: string = pkg.version

// Sent on every API/WebSocket request so the server can record which client
// started a run (stored on the run as client_version, shown for support). Not a
// security boundary — the server derives a run's `source` from the credential.
export const USER_AGENT = `ellipsis-cli/${VERSION}`

// The bare default; env (ELLIPSIS_API_BASE_URL / ELLIPSIS_API_BASE) and the
// config file take precedence and are layered in resolveApiBase() (config.ts).
export const DEFAULT_API_BASE = 'https://api.ellipsis.dev'
// The bare default. Env (ELLIPSIS_WS_BASE) and derivation from the API base are
// layered in resolveWsBase() (ws.ts).
export const DEFAULT_WS_BASE = 'wss://api.ellipsis.dev'
