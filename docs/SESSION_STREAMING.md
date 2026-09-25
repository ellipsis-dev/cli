# Session streaming: how `--watch` follows a session

`ellipsis session start --watch` and `ellipsis session get --watch` follow a
session's output live until it reaches a terminal status. The stream is
read-only: the CLI never sends anything to the session. Stopping one is
`ellipsis session stop`.

The WebSocket client is `streamSession` from `@ellipsis-dev/sdk/stream`. This
repo owns only the transport adapter (`src/lib/stream.ts`) and the rendering
(`watchSessionStreaming` in `src/commands/session.ts`).

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
| `snapshot` | `session`, `messages`, `earliest_feed_seq`, `protocol` | prints the status word when it changes |
| `session` | `session`, the whole row, resent on any change | same: collapsed to status-word transitions |
| `records_append` | `records`, feed-ordered `SessionRecord`s | one line per transcript item, via `recordToItems` from `@ellipsis-dev/sdk/store` |
| `delta` | ephemeral partial output for a turn | skipped: the committed record supersedes it |
| `heartbeat` | `ts` | skipped: liveness only |
| `error` | `message` | printed to stderr; the watch ends with exit code 1 |
| `done` | none | ends the watch; the last seen status decides the exit code |

`--json` with `--watch` prints one JSON object per frame (NDJSON) with the
same filtering: `heartbeat` and `delta` are dropped, and `snapshot` and
`session` frames are printed only when the status word changes.

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
  `live stream unavailable (...); falling back to status polling` on stderr
  and polls `GET /v1/sessions/{id}` every 2 seconds, printing status
  transitions until a terminal status (`watchSession`). `--watch --quiet`
  takes this polling path directly, with no live output.

## Exit code

A watch exits 0 when the session ended in `completed`, `closed`, or `idle`,
and 1 otherwise (`exitCodeForStatus`). When a conversation closes, the
execution outcome (`lifecycle.last_execution_result.completion_reason`, for
example `budget_hit`) stands in for the lifecycle status, so a closed session
that hit its budget still exits 1.
