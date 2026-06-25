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
agent login                       # device-code auth (use --no-browser for SSH)
agent logout                      # remove stored credentials
agent me                          # show the current credential's identity

agent run start --config <id>     # start a run from a saved config
agent run start --config-file f.json   # ...or from an inline config
agent run list --limit 20         # list recent runs (filter by --source, --days, …)
agent run get <run-id>            # inspect one run
agent run view                    # attach to the latest run and stream output

agent config list                 # list saved agent configs
agent config get <config-id>      # inspect one config

agent budget                      # current budget summary
agent usage                       # usage dashboard for the period
agent ping                        # check API connectivity
```

Most commands accept `--json` to print the raw API response. The CLI talks to
the public `/v1` REST API; point it elsewhere with `ELLIPSIS_API_BASE`.

### Auth

`agent login` uses the device-code flow: it requests a code pair, prints a
verification URL (and opens it unless `--no-browser`), and polls until you
approve the request in the dashboard. The issued user token is stored under
`~/.config/ellipsis/config.json` (mode 0600) and attributes runs to you.

## Develop

```sh
npm install
npm run dev -- --help       # run from source (tsx)
npm run typecheck           # tsc --noEmit
npm test                    # unit tests (vitest)
npm run build               # bundle to dist/ (tsup)
npm run compile             # single-binary build (bun)
```

### Testing

- `npm test` runs the [vitest](https://vitest.dev) unit suite (`test/`): query
  building and error parsing in the API client, the option coercions, money
  formatting, and the `deviceLogin` poll loop (driven with fake timers, no
  network).
- `scripts/smoke-local.sh` is a **fully-automated** end-to-end check against a
  local `docker compose` backend. It drives the device-code login itself —
  scraping the verification code and approving it headlessly through the
  running `public_api` container — then exercises the authenticated `/v1` calls
  with a throwaway config dir. One command, no manual approval:

  ```sh
  ./scripts/smoke-local.sh
  # overrides: ELLIPSIS_API_BASE, ELLIPSIS_PUBLIC_API_CONTAINER, ELLIPSIS_SMOKE_CUSTOMER_ID
  ```

- `scripts/smoke.sh` is the manual variant for any backend (incl. staging/prod):
  it drives login and the `/v1` calls but waits for you to approve in the
  dashboard. See its header for the approval options.

  ```sh
  ELLIPSIS_API_BASE=http://localhost:5000 ./scripts/smoke.sh
  ```

> Note: the `verification_uri` the backend returns points at `app.ellipsis.dev`
> unless the container sets `ELLIPSIS_APP_BASE_URL=http://localhost:3000`, so
> for local runs prefer `smoke-local.sh`'s headless container approval over the
> browser link.

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

The cross-repo push to the tap uses a write-scoped **deploy key**: the public
half is registered on `ellipsis-dev/homebrew-cli` (Settings → Deploy keys, write
access), and the private half is stored as the `HOMEBREW_TAP_DEPLOY_KEY` secret
on this repo. The workflow checks out the tap over SSH with it. A deploy key is
scoped to that one repo only — no account-wide PAT involved.

### Status

The full `/v1` REST surface (auth, runs, configs, budget/usage) is wired against
the live API. Still pending: the server-side WebSocket frame protocol behind
`run view`, a `run stop` endpoint, and replacing the hand-rolled request/response
types with the generated `@ellipsis/sdk` package.
