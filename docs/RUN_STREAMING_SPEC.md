# Requirements: live run streaming for `agent run get --watch`

**Status:** proposed — not yet implemented.
**Audience:** the engineer/agent implementing WebSocket streaming, server + client.

## 1. Background

The CLI can start runs and read their state over the public `/v1` REST API, but
it cannot stream a run's output. `agent run get --watch` exists today and gives a
**status-level** live view by polling `GET /v1/agents/runs/{id}` until the run
reaches a terminal status (`completed`/`error`/`cancelled`/`stopped`). It shows
status transitions and the final summary — not the step-by-step stdout/stderr or
token stream.

Token-level streaming over `/v1` is explicitly deferred in the backend design
doc (`documents/eng/ELLIPSIS_API_AND_CLI.md` §7, "Deferred → Streaming run steps
through `/v1` for CLI clients"). This spec defines the work to close that gap.

Scaffolding already in this repo (currently unused, kept as a starting point):
- `src/lib/ws.ts` — a `streamRun()` WebSocket client and a `StreamFrame` type
  (`stdout`/`stderr`/`status`/`done`/`error`). It connects to
  `${wsBase}/v1/runs/{id}/stream` with a bearer token. No reconnect/resume/heartbeat.
- `src/ui/RunView.tsx` — an Ink component that renders frames from `streamRun()`.
- `DEFAULT_WS_BASE` in `src/lib/constants.ts` (`wss://api.ellipsis.dev`).

The reported `error: [object ErrorEvent]` came from this scaffolding connecting to
a non-existent server endpoint; `ws.ts` stringifies the raw `ErrorEvent`. Fix the
error rendering as part of this work (surface `err.message`).

## 2. Goal

`agent run get <id> --watch` streams a run's output live, in real time, and
falls back to REST polling when streaming is unavailable. The same flag covers
both modes — no new top-level command.

## 3. Server-side requirements (`/v1`)

1. **Endpoint:** `GET /v1/runs/{run_id}/stream`, upgraded to WebSocket.
2. **Auth:** `Authorization: Bearer <token>`, resolved by the same `V1Auth`
   path as the REST API (user/API/sandbox tokens), authorizing the run's
   customer. Reject with a close code on auth failure (see §5).
3. **Frame protocol (server → client), one JSON object per WS message:**
   - `{ "type": "status", "status": "<AgentRunStatus>", "ts": "<iso8601>" }`
   - `{ "type": "stdout", "data": "<chunk>", "seq": <int>, "ts": "<iso8601>" }`
   - `{ "type": "stderr", "data": "<chunk>", "seq": <int>, "ts": "<iso8601>" }`
   - `{ "type": "done", "status": "<terminal status>", "exit_status": "<...>" }`
   - `{ "type": "error", "message": "<human-readable>" }`
   - `seq` is a monotonic per-run cursor used for resume.
4. **Backfill + resume:** accept `?after_seq=<int>` (query or first client
   message). On connect, replay buffered frames with `seq > after_seq`, then
   stream live. This makes reconnects lossless.
5. **Heartbeat:** server sends WS ping (or a `status` keepalive) at a fixed
   interval (e.g. 20s) so dead connections are detectable.
6. **Termination:** send a final `done` frame, then close with a normal code.
   For an already-terminal run, replay buffered output then `done` immediately.
7. **Retention:** define how long run output is buffered for backfill (at least
   the run's lifetime + a grace window). Document the limit.

## 4. Client-side requirements (this repo)

1. `agent run get <id> --watch` connects to the stream and renders frames:
   `stdout`/`stderr` as output, `status` as transition lines, `done`/`error`
   to finish. Exit 0 on `done` with a successful terminal status, non-zero on
   `error` or a failed terminal status.
2. **Reconnect with backoff** and resume from the last seen `seq` via
   `after_seq`, so a dropped socket doesn't lose or duplicate output.
3. **Fallback:** if the WebSocket can't connect (e.g. server without streaming,
   or a `1003`/unsupported close), fall back to the existing REST polling
   `watchRun()` automatically, with a one-line notice. `--watch` must keep
   working against a backend that lacks the endpoint.
4. **Heartbeat:** respond to/expect pings; treat a missed heartbeat as a dropped
   connection and reconnect.
5. `--json` with `--watch`: emit one JSON object per frame (NDJSON) for piping.
6. Fix `ws.ts` error handling to surface a readable message, not
   `[object ErrorEvent]`.

## 5. WebSocket close codes (suggested)

| Code | Meaning |
|------|---------|
| 1000 | normal — run reached a terminal state |
| 1008 | auth failed / not authorized for this run |
| 1003 | streaming unsupported (client should fall back to polling) |
| 1011 | server error |

## 6. Acceptance criteria

- Streaming a live run shows stdout/stderr in near real time end to end.
- Killing the socket mid-run and reconnecting resumes with no lost or duplicated
  frames (verified via `seq`/`after_seq`).
- `--watch` against a backend without the endpoint transparently falls back to
  REST polling and still completes.
- `--json --watch` emits valid NDJSON, one frame per line.
- Unit tests for the client frame handler, reconnect/resume cursor, and fallback
  trigger (mirror the fake-timer style in `test/auth.test.ts` / `test/run.test.ts`).
- No `[object ErrorEvent]`; connection errors print a real message.

## 7. Out of scope

- Bidirectional control over the stream (stop/input). `run stop` is tracked
  separately and also has no `/v1` endpoint yet.
- Multiplexing multiple runs over one socket.
