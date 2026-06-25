export const VERSION = '0.1.1'

// The bare default; env (ELLIPSIS_API_BASE_URL / ELLIPSIS_API_BASE) and the
// config file take precedence and are layered in resolveApiBase() (config.ts).
export const DEFAULT_API_BASE = 'https://api.ellipsis.dev'
export const DEFAULT_WS_BASE = process.env.ELLIPSIS_WS_BASE ?? 'wss://api.ellipsis.dev'
export const APP_BASE = process.env.ELLIPSIS_APP_BASE ?? 'https://app.ellipsis.dev'
