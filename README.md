# Ellipsis CLI

Drive the [Ellipsis](https://ellipsis.dev) cloud from your terminal: start agent
runs, stream their output live, manage configurations, and open a run in the
browser IDE.

This is a thin client. The agent runs in the Ellipsis cloud; the CLI
authenticates, opens a WebSocket, and streams results. It is open source
(MIT) — the proprietary engine stays server-side.

## Install

```sh
brew install ellipsis-dev/cli/agent
```

## Usage

```sh
agent login                 # authenticate (browser, or --device for SSH)
agent run start "fix the failing test in billing"
agent run view              # attach to the latest run and stream output
agent run stop <run-id>     # stop an in-flight run
agent config create <name>  # create a configuration locally
agent config deploy <name>  # deploy it to the cloud
agent ping                  # check API connectivity
```

## Develop

```sh
npm install
npm run dev -- --help       # run from source (tsx)
npm run typecheck           # tsc --noEmit
npm run build               # bundle to dist/ (tsup)
npm run compile             # single-binary build (bun)
```

### Layout

| Path              | Purpose                                          |
| ----------------- | ------------------------------------------------ |
| `src/cli.tsx`     | entry point; wires up the command tree           |
| `src/commands/`   | one module per top-level command group           |
| `src/ui/`         | Ink components for interactive / streaming views |
| `src/lib/`        | API client, WebSocket client, config, constants  |

### Releasing

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which Bun-compiles
binaries for macOS and Linux (arm64 + x64), publishes a GitHub release with the
tarballs, and regenerates the formula in
[`ellipsis-dev/homebrew-cli`](https://github.com/ellipsis-dev/homebrew-cli).

```sh
git tag v0.1.0 && git push origin v0.1.0
```

The cross-repo push needs a `HOMEBREW_TAP_TOKEN` secret (a token with
contents:write on the tap repo) set on this repo.

### Status

Skeleton. Command tree and streaming UI are wired; network calls (auth, run
stream) are typed stubs pending the `@ellipsis/sdk` package (generated from the
backend OpenAPI spec) and the server-side WebSocket frame protocol.
