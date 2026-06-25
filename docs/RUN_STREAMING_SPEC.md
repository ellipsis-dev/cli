# Requirements: live run streaming for `agent run get --watch`

**Status:** proposed — not yet implemented.
**Audience:** the engineer/agent implementing WebSocket streaming for the CLI.

## 1. Background

The CLI can start runs and read their state over the public `/v1` REST API, but
it cannot stream a run's output. `agent run get --watch` exists today and gives a
**status-level** live view by polling `GET /v1/agents/runs/{id}` until the run
reaches a terminal status (`completed`/`error`/`cancelled`/`stopped`). It shows
status transitions and the final summary — not the step-by-step output.

**Crucially, the backend already streams steps live — just not over `/v1`.** The
dashboard consumes a WebSocket stream; this work is about re-exposing that same
stream under `/v1` for bearer-authenticated CLI clients. The bulk of the
machinery (step model, persistence, event bus) already exists and must be reused,
not reinvented.

### How the existing dashboard stream works (source of truth to mirror)

- **Endpoint:** `@router.websocket("/agents/runs/{run_id}/stream")` —
  `agents_router.py:1200`, loop `_stream_run_loop` at `:1147`.
- **Frames:** an initial `{"type":"snapshot","run":...,"steps":[...]}`, then
  `{"type":"steps_append","steps":[...]}`, `{"type":"run","run":...}`, and
  `{"type":"heartbeat"}`. Socket closes when the run status is terminal.
  `STREAM_RECONCILE_SECONDS = 10` forces a DB re-read even with no event.
- **Step model:** `AgentStep` (`src/models/agents/agent_step.py`) with a
  monotonic `step_index: int` and `data: CCStep`. `CCStep`
  (`src/models/agents/claude/cc_step.py`) is the typed Claude Code stream-json
  message — a discriminated union of assistant (text/tool_use/thinking blocks +
  usage), user (tool results incl. stdout/stderr), system-init, and result
  (cost/duration). Stored in the `agent_steps` table, indexed on
  `(agent_session_id, step_index)`.
- **Source + signal:** Claude Code runs with `--output-format stream-json`; the
  sandbox runner parses each stdout line into a `CCStep`, assigns `step_index`
  (`run_in_sandbox.py:221-257`), inserts an `AgentStep` row, and fires
  `pg_notify('agent_events', {run_id, kind})` — **a pointer, never the data**
  (`realtime/agent_events.py`). Each `public_api` process runs an `AgentEventBus`
  (`realtime/agent_event_bus.py`) doing `LISTEN agent_events` on a dedicated
  session-mode connection, fanning notifies to per-run `asyncio.Queue`s. The WS
  handler wakes on a notify and **re-reads run+steps from the DB** (the DB is the
  source of truth; NOTIFY is only a wake-up).
- **Cursor:** `step_index` is monotonic per session, but the protocol exposes
  **no client cursor** — each (re)connect gets a full `snapshot`, then deltas via
  a local `sent_steps` counter. Dropped notifies self-heal via reconcile.
- **Auth:** browsers can't set WS handshake headers, so an authenticated REST
  call (`GET /agents/runs/{id}/stream-ticket`, `:1090`) mints a 60s HMAC ticket
  (`realtime/stream_tickets.py`, signed with `FRONTEND_API_KEY`) passed as
  `?ticket=`. The handler verifies signature+expiry, then re-checks run ownership
  against the DB (close `4401`/`4403` on failure).

## 2. Goal

`agent run get <id> --watch` streams a run's steps live, in real time, and falls
back to REST status-polling when streaming is unavailable. The same flag covers
both modes — no new top-level command.

## 3. Server-side requirements (`/v1`)

**Re-export the existing stream; do not build a parallel one.** Reuse
`agent_steps`, `CCStep`, and the `AgentEventBus` exactly as the frontend stream
does. The `/v1` endpoint is a thin re-auth + re-encode of `_stream_run_loop`.

1. **Endpoint:** `GET /v1/agents/runs/{run_id}/stream`, upgraded to WebSocket.
2. **Auth — bearer, not ticket.** The CLI holds a `/v1` bearer token, so resolve
   it with the same `V1Auth` path as the REST API (Authorization header on the
   handshake, which non-browser clients *can* set), authorizing the run's
   customer. The 60s `?ticket=` dance is a browser workaround the CLI doesn't
   need; don't require it.
3. **Frame protocol — reuse the existing shape:** `snapshot` (run + steps),
   `steps_append` (new `AgentStep`s), `run` (run-row change), `heartbeat`, and a
   terminal close. Each step serializes as the existing `AgentStep`/`CCStep`
   JSON so CLI and dashboard share one schema.
4. **Add a real resume cursor.** Accept `?since=<step_index>` (and/or a first
   client message). On connect, send only steps with `step_index > since`
   (skipping the full snapshot) — a CLI reconnect must resume incrementally, not
   re-download every step. Absent `since`, behave like today (full snapshot).
   Consider also adding `?since=` to the REST `GET /agents/runs/{id}/steps`
   (`agents_router.py:1073`), which currently takes no cursor.
5. **Heartbeat / reconcile:** keep the existing heartbeat + 10s DB reconcile so
   dropped connections are detectable and dropped notifies self-heal.
6. **Termination:** send the final `run`/terminal frame, then close normally.
   For an already-terminal run, replay steps (honoring `since`) then close.

## 4. Client-side requirements (this repo)

1. `agent run get <id> --watch` opens the `/v1` stream and renders frames:
   `snapshot`/`steps_append` → render each `CCStep` (assistant text + tool calls,
   tool stdout/stderr, thinking if `--verbose`); `run` → status transitions;
   terminal close → final summary. Exit 0 on a successful terminal status,
   non-zero on error/failed terminal status.
2. **Reconnect with backoff**, resuming from the highest `step_index` seen via
   `?since=`, so a dropped socket loses/duplicates nothing.
3. **Fallback:** if the WS can't connect (server without the endpoint, or a
   `1003`/unsupported close), fall back to the existing REST status-poll
   `watchRun()` with a one-line notice. `--watch` must keep working against a
   backend that lacks streaming.
4. **`--json` with `--watch`:** emit one JSON object per frame (NDJSON).
5. Reuse/replace the `src/lib/ws.ts` + `src/ui/RunView.tsx` scaffolding. Fix
   `ws.ts` error handling to surface a readable message, not `[object ErrorEvent]`
   (the original bug came from connecting to a then-nonexistent endpoint).
6. Define a TS mirror of `CCStep` (or a pragmatic subset) in `src/lib/types.ts`,
   matching the backend union.

## 5. WebSocket close codes

Mirror the backend's existing codes where possible:

| Code | Meaning |
|------|---------|
| 1000 | normal — run reached a terminal state |
| 4401 | auth failed (bad/expired credential) |
| 4403 | authenticated but not authorized for this run |
| 1003 | streaming unsupported (client falls back to polling) |
| 1011 | server error |

## 6. Acceptance criteria

- Streaming a live run shows assistant output + tool stdout/stderr in near real
  time, sharing the `AgentStep`/`CCStep` schema with the dashboard.
- Killing the socket mid-run and reconnecting with `?since=<last step_index>`
  resumes with no lost or duplicated steps and without a full re-snapshot.
- `--watch` against a backend without the `/v1` endpoint transparently falls back
  to REST status-polling and still completes.
- `--json --watch` emits valid NDJSON, one frame per line.
- Unit tests for the client frame handler, the `since` resume cursor, and the
  fallback trigger (mirror the fake-timer style in `test/auth.test.ts` /
  `test/run.test.ts`).
- No `[object ErrorEvent]`; connection errors print a real message.

## 7. Out of scope

- Bidirectional control (stop/input). `run stop` is tracked separately and also
  has no `/v1` endpoint yet.
- Re-architecting the transport (NOTIFY + DB-as-source-of-truth stays).
- Multiplexing multiple runs over one socket.

## 8. Key backend references

- `src/public_api/routers/agents/agents_router.py` — WS `:1200`/`_stream_run_loop :1147`, REST steps `:1073`, stream-ticket `:1090`.
- `src/public_api/realtime/agent_events.py`, `agent_event_bus.py`, `postgres_listen_bus.py`, `stream_tickets.py`.
- `src/agents/engine/claude/run_in_sandbox.py:221-257`, `shared.py:45-94`.
- `src/models/agents/agent_step.py`, `src/models/agents/claude/cc_step.py`, `src/models/database/agents/agent_steps_row.py`.
