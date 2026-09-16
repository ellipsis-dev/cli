import pkg from '../../package.json'

// CLI 2.X.Y uses SDK 0.X.Y. CI and releases check the exact version pair.
export const VERSION: string = pkg.version

// Sent on every API/WebSocket request so the server can record which client
// started a session (stored on the session as client_version, shown for
// support). Not a security boundary — the server derives a session's `source`
// from the credential.
export const USER_AGENT = `ellipsis-cli/${VERSION}`

// The bare default; env (ELLIPSIS_API_BASE_URL / ELLIPSIS_API_BASE) and the
// config file take precedence and are layered in resolveApiBase() (config.ts).
export const DEFAULT_API_BASE = 'https://api.ellipsis.dev'
// The bare default. Env (ELLIPSIS_WS_BASE) and derivation from the API base are
// layered in resolveWsBase() (ws.ts).
export const DEFAULT_WS_BASE = 'wss://api.ellipsis.dev'
