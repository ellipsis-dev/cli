export const VERSION = '0.1.3'

// The bare default; env (ELLIPSIS_API_BASE_URL / ELLIPSIS_API_BASE) and the
// config file take precedence and are layered in resolveApiBase() (config.ts).
export const DEFAULT_API_BASE = 'https://api.ellipsis.dev'
// The bare default. Env (ELLIPSIS_WS_BASE) and derivation from the API base are
// layered in resolveWsBase() (ws.ts).
export const DEFAULT_WS_BASE = 'wss://api.ellipsis.dev'
