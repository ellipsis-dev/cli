import pkg from '../../package.json'

// The version, in precedence order:
// 1. BUILD_GIT_VERSION — stamped by scripts/compile.sh (`bun run compile`)
//    from `git describe`, so a locally built binary reports exactly the
//    commit it was built from ("1.6.0-2-g08ea24d") instead of package.json's
//    stale field (releases stopped bumping it; see docs/RELEASING.md).
// 2. pkg.version — release builds (the workflow rewrites package.json from
//    the tag, then runs `bun build` directly, without the define) and tsx
//    dev runs.
declare const BUILD_GIT_VERSION: string | undefined
export const VERSION: string =
  typeof BUILD_GIT_VERSION === 'string' ? BUILD_GIT_VERSION : pkg.version

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
