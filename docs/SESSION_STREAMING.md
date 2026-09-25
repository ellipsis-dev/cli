# Session streaming: how `--watch` follows a turn

`ellipsis session start --watch` and `ellipsis session get --watch` follow a
session's output live until the turn they are waiting on ends. For `start`
that is the opening turn the start created (a promptless start has none, so
there is nothing to wait for). For `get` it is the turn in progress: the
running turn, else the pending one. A session with no turn in progress has
nothing to wait for either: `get --watch` prints the latest turn's status and
exits. The stream is read-only: the CLI never sends anything to the session.
Stopping a turn is `ellipsis session stop`.

The WebSocket client is `streamSession` from `@ellipsis-dev/sdk/stream`. This
repo owns only the transport adapter (`src/lib/stream.ts`) and the rendering
(`streamTurn` in `src/commands/session.ts`).

## Endpoint

```
WS {ws-base}/v1/sessions/{id}/stream?protocol=6[&after_seq=N]
```

- The WebSocket base is `ELLIPSIS_WS_BASE` when set, else the resolved API
  base with `http(s)` swapped for `ws(s)`.
- Auth is the bearer token on the handshake (`authorization: Bearer ...`),
  plus the CLI user agent. The dashboard's ticket handshake is not used.
- `protocol` is `SESSION_STREAM_PROTOCOL_VERSION` from the SDK, so a protocol
  bump ships with an SDK bump.
- `after_seq` is the highest record `feed_seq` the client has seen. It is sent
  on reconnect so the server resumes after it instead of replaying history. A
  first connect sends no `after_seq` and gets the full snapshot.

## Frames

The SDK parses each message and drops anything whose `type` is not one of the
seven below. Unknown frame types, and unknown `source`, `record_type`, or
`kind` values inside a record, are ignored by rule: additive server changes are
not a protocol break. The full frame schema is `schema/frames.schema.json` in
the SDK package.

| Frame | Payload | What the watch log does with it |
| --- | --- | --- |
| `snapshot` | `session`, `messages`, `earliest_feed_seq`, `protocol` | prints the awaited turn's status when it changes |
| `session` | `session`, the whole object, resent on any change | same: collapsed to the awaited turn's status transitions; a final status ends the watch |
| `records_append` | `records`, feed-ordered `SessionRecord`s | one line per transcript item, via `recordToItems` from `@ellipsis-dev/sdk/store`; a `turn_ended` record for the awaited turn ends the watch |
| `delta` | ephemeral partial output for a turn | skipped: the committed record supersedes it |
| `heartbeat` | `ts` | skipped: liveness only |
| `error` | `message` | printed to stderr; the watch ends with exit code 1 |
| `done` | none | the conversation closed, which happens only after its turn ended; the watch ends |

The stream itself stays open for the whole conversation. A watch wants one
turn of it, so it closes the socket as soon as that turn's end arrives (its
`turn_ended` record, or a `session` frame carrying the turn's final status),
and resolves the turn with `GET /v1/sessions/{id}/turns/{turn_id}` if the
stream ended first.

Platform records render with plain wording: environment preparation
(`environment_phase`), the customer's own hook output (`environment_output`),
`Environment ready`, how a turn ended (`turn_ended`), and `Conversation
closed`. Records whose type the SDK has no copy for, including types the
platform no longer emits, render nothing.

`--json` with `--watch` prints one JSON object per frame (NDJSON) with the
same filtering: `heartbeat` and `delta` are dropped, and `snapshot` and
`session` frames are printed only when the awaited turn's status changes.

## Liveness, reconnect, fallback

All of this is inside `streamSession`; the CLI configures none of it.

- Heartbeat: 45 seconds without any frame closes the socket as an error,
  which goes through the reconnect decision below.
- Reconnect: a retryable close or a socket error reconnects with `after_seq`
  after a delay of 500 ms that doubles up to 8 s. `maxReconnects` is 5: once a
  frame has been received, the fifth consecutive failure gives up; before any
  frame has arrived, the second failure does, so a backend without the
  endpoint fails fast.
- Close codes: `1000` is normal. `1008`, `4401`, and `4403` are auth failures
  and throw `StreamAuthError`, which the CLI reports as an error with no
  fallback. `1002` and `1003` mean the protocol is unsupported and give up at
  once. Every other code is retried.
- Fallback: giving up throws `StreamUnavailableError`. The CLI prints
  `live stream unavailable (...); falling back to polling the turn` on stderr
  and polls `GET /v1/sessions/{id}/turns/{turn_id}` every 2 seconds, printing
  status transitions until a final status (`pollTurn`). `--watch --quiet`
  takes this polling path directly, with no live output.

## Exit code

A watch exits 0 when the turn ended `completed`, and 1 when it ended `failed`,
`stopped`, or `cancelled` (`exitCodeForStatus`). Its last line names the
outcome with the turn's `reason` and `detail`, for example
`✗ session session_1 turn failed (budget_hit): The session reached its budget.`
