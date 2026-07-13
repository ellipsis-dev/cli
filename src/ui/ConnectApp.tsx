import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdin } from 'ink'
import Spinner from 'ink-spinner'
import { ApiClient, ApiError } from '../lib/api'
import { streamSession, StreamUnavailableError, type StreamFrame } from '../lib/ws'
import { clampLines, eventToItems, type CCEvent, type ItemKind, type TranscriptItem } from '../lib/events'

// The interactive `agent session connect` UI, modelled on Claude Code: a
// committed transcript that groups tool calls with their results and spaces
// messages apart, above a live footer with an animated status spinner and a
// composer that echoes what you send. Rendering shape lives in lib/events.ts
// (pure); this component owns the data flow, the composer, and the colours.
//
// Data flow: the committed transcript comes from the structured steps API
// (GET /v1/sessions/{id}/steps, whose `data` is the full Claude Code event) —
// grouped into tool calls / results — with the socket as a low-latency
// "something changed" wake plus status source, backed by a slow poll. On top of
// that, the socket also carries EPHEMERAL `delta` frames (partial assistant text
// + a running output-token count) that render as a live, in-progress line and a
// footer token counter — the token-by-token feel of local Claude Code — until
// the committed assistant step lands and supersedes it.

export interface ConnectAppProps {
  api: ApiClient
  token: string
  sessionId: string
  wsBase: string
  // Keyed, open sessions accept messages (show the composer); single-shot /
  // closed / --no-input sessions follow read-only and exit when the stream ends.
  canSend: boolean
  initialItems: TranscriptItem[]
  // The highest step_index already rendered into initialItems, so live refreshes
  // only append steps newer than what's on screen.
  initialMaxStepIndex: number
  initialStatus: string
}

// Statuses in which the agent is actively producing output — drives the spinner.
function isWorkingStatus(status: string): boolean {
  return ['scheduled', 'creating_sandbox', 'running', 'retrying'].includes(status)
}

export function ConnectApp(props: ConnectAppProps): React.ReactElement {
  const { api, token, sessionId, wsBase, canSend } = props
  const { exit } = useApp()
  const { isRawModeSupported } = useStdin()

  const [items, setItems] = useState<TranscriptItem[]>(props.initialItems)
  const [status, setStatus] = useState(props.initialStatus)
  const [working, setWorking] = useState(isWorkingStatus(props.initialStatus))
  const [elapsed, setElapsed] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [input, setInput] = useState('')
  // ctrl+r toggles full vs. collapsed tool output across the whole transcript.
  const [expanded, setExpanded] = useState(false)
  // Messages you've sent that the agent hasn't picked up yet — shown as a
  // queued region below the composer, exactly like Claude Code. Each moves into
  // the transcript when the backend relays it as a user turn, or when the turn
  // idles (whichever first), so a send is never lost.
  const [queued, setQueued] = useState<string[]>([])
  // Ephemeral live-streaming overlay for the CURRENT assistant response, driven
  // by `delta` frames: the prose so far and the running output-token count. Both
  // clear when the committed assistant step lands (it supersedes the overlay) or
  // the turn settles.
  const [liveText, setLiveText] = useState('')
  const [liveTokens, setLiveTokens] = useState<number | null>(null)

  // Live-flow state that must survive re-renders without triggering them.
  const afterSeq = useRef(0)
  const streaming = useRef(false)
  const abort = useRef(new AbortController())
  const lastStatus = useRef(props.initialStatus)
  const keyCounter = useRef(0)
  // The highest step_index committed to the transcript, and the refresh
  // in-flight / re-run guards so overlapping wakes don't double-append.
  const maxStep = useRef(props.initialMaxStepIndex)
  const refreshing = useRef(false)
  const pendingRefresh = useRef(false)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A mirror of `queued` for async callbacks, and the texts already committed
  // locally so the backend's later echo of the same send is dropped.
  const queuedRef = useRef<string[]>([])
  const flushed = useRef<string[]>([])
  useEffect(() => {
    queuedRef.current = queued
  }, [queued])

  // Append items, promoting a queued send when its user turn arrives and
  // dropping the backend's echo of a send we already committed locally.
  const append = useCallback((incoming: TranscriptItem[]): void => {
    const commit: TranscriptItem[] = []
    for (const it of incoming) {
      if (it.kind === 'user') {
        if (queuedRef.current.includes(it.text)) {
          setQueued((prev) => {
            const j = prev.indexOf(it.text)
            return j < 0 ? prev : [...prev.slice(0, j), ...prev.slice(j + 1)]
          })
        } else {
          const fi = flushed.current.indexOf(it.text)
          if (fi >= 0) {
            flushed.current.splice(fi, 1)
            continue
          }
        }
      }
      commit.push(it)
    }
    if (commit.length) setItems((prev) => [...prev, ...commit])
  }, [])

  // Pull the structured steps and append any newer than what's on screen. This
  // is the sole source of transcript content — the socket only decides *when*
  // to call it. Guarded so concurrent wakes coalesce into one trailing refresh.
  const refreshSteps = useCallback(async (): Promise<void> => {
    if (refreshing.current) {
      pendingRefresh.current = true
      return
    }
    refreshing.current = true
    try {
      const steps = await api.getAgentSessionSteps(sessionId)
      const ordered = [...steps].sort(
        (a, b) => a.created_at.localeCompare(b.created_at) || a.step_index - b.step_index,
      )
      const fresh = ordered.filter((st) => st.step_index > maxStep.current)
      if (fresh.length) {
        for (const st of fresh) maxStep.current = Math.max(maxStep.current, st.step_index)
        append(fresh.flatMap((st) => eventToItems(st.data as CCEvent, `s${st.step_index}`)))
        // A committed step landed — the streamed overlay is now part of the
        // transcript (or the turn advanced), so drop the live overlay.
        setLiveText('')
        setLiveTokens(null)
      }
    } catch {
      // Transient fetch failure — the next wake/poll retries.
    } finally {
      refreshing.current = false
      if (pendingRefresh.current) {
        pendingRefresh.current = false
        void refreshSteps()
      }
    }
  }, [api, append, sessionId])

  // Coalesce bursts of wakes into one refresh a beat later.
  const scheduleRefresh = useCallback((): void => {
    if (refreshTimer.current) return
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null
      void refreshSteps()
    }, 250)
  }, [refreshSteps])

  // The socket carries status transitions (drive the spinner) and acts as a
  // wake: any frame means new steps may exist, so schedule a refresh.
  const handleFrame = useCallback(
    (frame: StreamFrame): void => {
      if (typeof frame.seq === 'number') afterSeq.current = Math.max(afterSeq.current, frame.seq)
      if (frame.type === 'status' && frame.status && frame.status !== lastStatus.current) {
        lastStatus.current = frame.status
        setStatus(frame.status)
        setWorking(isWorkingStatus(frame.status))
      }
      if (frame.type === 'error') {
        setNotice(frame.message ?? frame.data ?? 'stream error')
        return
      }
      // Ephemeral streaming delta: update the live overlay in place. NOT a
      // committed-steps wake, so it must not trigger a steps refresh (that would
      // poll the API several times a second during generation).
      if (frame.type === 'delta') {
        if (frame.text) setLiveText((t) => t + frame.text)
        if (typeof frame.output_tokens === 'number') setLiveTokens(frame.output_tokens)
        return
      }
      scheduleRefresh()
    },
    [scheduleRefresh],
  )

  // Keep the socket attached across reconnects/resume. A keyed session going
  // terminal is not the end of the conversation — it idles between turns — so
  // we refresh once more, report idle, and re-attach on the next send.
  // Watch-only sessions exit when the stream ends.
  const pump = useCallback((): void => {
    if (streaming.current || abort.current.signal.aborted) return
    streaming.current = true
    streamSession({
      token,
      sessionId,
      wsBase,
      afterSeq: afterSeq.current,
      onFrame: handleFrame,
      signal: abort.current.signal,
    })
      .then(async (outcome) => {
        if (abort.current.signal.aborted) return
        await refreshSteps() // pull the final steps of the turn before settling
        setLiveText('')
        setLiveTokens(null)
        setWorking(false)
        if (outcome.type === 'error') setNotice(`stream error: ${outcome.message}`)
        if (canSend) {
          if (outcome.type === 'done') setNotice('agent idle — send a message to wake it')
        } else {
          exit()
        }
      })
      .catch((err: unknown) => {
        if (abort.current.signal.aborted) return
        const msg =
          err instanceof StreamUnavailableError
            ? `live stream unavailable (${err.message}) — polling for updates`
            : `stream error: ${(err as Error).message}`
        setNotice(msg)
        // No socket: the poll below keeps the transcript current; only a
        // watch-only session (which would never poll long) exits here.
        if (!canSend) exit()
      })
      .finally(() => {
        streaming.current = false
      })
  }, [canSend, exit, handleFrame, refreshSteps, sessionId, token, wsBase])

  useEffect(() => {
    pump()
    scheduleRefresh() // catch steps created between the initial fetch and connect
    // A slow poll backs up the socket wake (and covers a socket that never
    // connected, so following still updates). The socket wake is the fast path;
    // this is just a safety net, so it can be gentle.
    const poll = setInterval(scheduleRefresh, 3000)
    const controller = abort.current
    return () => {
      controller.abort()
      clearInterval(poll)
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
    }
  }, [pump, scheduleRefresh])

  // Tick an elapsed-seconds counter while the agent works — a steady progress
  // read alongside the live token counter, and the sole liveness cue during a
  // long tool call (which streams no assistant deltas). Reset each turn.
  useEffect(() => {
    if (!working) return
    setElapsed(0)
    const t = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(t)
  }, [working])

  // When the turn goes idle, commit any still-queued messages into the
  // transcript (they weren't relayed) so they never vanish; remember them so a
  // late backend echo is de-duplicated. A message sent while already idle
  // flushes immediately — it starts a fresh turn rather than queueing.
  useEffect(() => {
    if (working || queued.length === 0) return
    flushed.current.push(...queued)
    const items = queued.map<TranscriptItem>((text) => ({
      key: `q${keyCounter.current++}`,
      kind: 'user',
      gutter: '›',
      text,
      spaceBefore: true,
    }))
    setItems((prev) => [...prev, ...items])
    setQueued([])
  }, [working, queued])

  const submit = useCallback(
    (raw: string): void => {
      const text = raw.trim()
      setInput('')
      if (!text) return
      if (text === '/exit' || text === '/quit') {
        exit()
        return
      }
      void (async () => {
        try {
          if (text === '/stop') {
            const s = await api.stopAgentSession(sessionId)
            setNotice(`stop requested (${s.status}) — the conversation survives`)
            return
          }
          // Show the message as queued (or, if idle, it flushes to the
          // transcript at once), then post it and wait for the turn.
          setQueued((prev) => [...prev, text])
          setNotice(null)
          await api.sendSessionMessage(sessionId, text)
          setWorking(true)
          pump()
        } catch (err) {
          setQueued((prev) => {
            const j = prev.indexOf(text)
            return j < 0 ? prev : [...prev.slice(0, j), ...prev.slice(j + 1)]
          })
          setNotice(`✗ ${err instanceof ApiError ? err.detail : (err as Error).message}`)
        }
      })()
    },
    [api, exit, pump, sessionId],
  )

  const inputActive = canSend && isRawModeSupported
  useInput(
    (ch, key) => {
      if (key.return) {
        submit(input)
        return
      }
      if (key.escape) {
        if (working) submit('/stop')
        return
      }
      if (key.ctrl && ch === 'r') {
        setExpanded((v) => !v)
        return
      }
      if (key.backspace || key.delete) {
        setInput((p) => p.slice(0, -1))
        return
      }
      if (key.ctrl || key.meta) return
      if (ch) setInput((p) => p + ch)
    },
    { isActive: inputActive },
  )

  // Render the transcript from state (not <Static>) so ctrl+r can re-expand
  // committed blocks. The list is memoized on [items, expanded], so the
  // 80ms spinner ticks reuse the same elements and don't re-lay-out the
  // transcript — only the footer re-renders.
  const lines = useMemo(
    () => items.map((item) => <TranscriptLine key={item.key} item={item} expanded={expanded} />),
    [items, expanded],
  )
  const hasCollapsible = useMemo(
    () => items.some((it) => isCollapsible(it)),
    [items],
  )

  return (
    <Box flexDirection="column">
      {lines}
      {/* The in-progress assistant response, streamed token-by-token from delta
          frames; replaced by the committed step when it lands. */}
      {liveText && (
        <Box marginTop={1}>
          <Text>{liveText}</Text>
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        {notice && <Text dimColor>· {notice}</Text>}
        {working && (
          <Text>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>{' '}
            <Text dimColor>
              {status} · {elapsed}s
              {liveTokens != null ? ` · ${formatTokens(liveTokens)} tokens` : ''}
              {inputActive ? ' · esc to interrupt · type to queue a message' : ''}
            </Text>
          </Text>
        )}
        {inputActive ? (
          <Box>
            <Text color="cyan">› </Text>
            <Text>{input}</Text>
            <Text inverse> </Text>
          </Box>
        ) : (
          !working && <Text dimColor>· {canSend ? status : `following ${status}`}</Text>
        )}
        {queued.length > 0 && (
          <Box flexDirection="column">
            {queued.map((text, i) => (
              <Text key={`q${i}`} dimColor>
                ⏳ queued · {text}
              </Text>
            ))}
          </Box>
        )}
        {inputActive && hasCollapsible && (
          <Text dimColor>ctrl+r to {expanded ? 'collapse' : 'expand'} long output</Text>
        )}
      </Box>
    </Box>
  )
}

// Compact token count for the live footer: 1400 -> "1.4k", 900 -> "900".
function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

// Long bodies collapse to this many lines until ctrl+r expands them.
const COLLAPSE_LINES = 6

// Which items collapse when long: tool results and user turns (the latter carry
// the re-injected run context, which is bulky). Assistant prose stays full.
function isCollapsible(item: TranscriptItem): boolean {
  return (
    (item.kind === 'tool_result' || item.kind === 'user') &&
    item.text.split('\n').length > COLLAPSE_LINES
  )
}

// Colour + weight for each transcript item kind, matched loosely to Claude Code.
function styleFor(item: TranscriptItem): {
  gutterColor?: string
  textColor?: string
  dim: boolean
  bold: boolean
} {
  const kind: ItemKind = item.kind
  switch (kind) {
    case 'tool':
      return { gutterColor: 'green', bold: true, dim: false }
    case 'tool_result':
      return { textColor: item.isError ? 'red' : undefined, dim: !item.isError, bold: false }
    case 'user':
      return { gutterColor: 'cyan', textColor: 'cyan', bold: true, dim: false }
    case 'error':
      return { gutterColor: 'red', textColor: 'red', dim: false, bold: false }
    case 'summary':
      return { textColor: item.isError ? 'red' : undefined, dim: true, bold: false }
    case 'thinking':
    case 'system':
    case 'notice':
      return { dim: true, bold: false }
    case 'assistant':
    default:
      return { dim: false, bold: false }
  }
}

const TranscriptLine = React.memo(function TranscriptLine({
  item,
  expanded,
}: {
  item: TranscriptItem
  expanded: boolean
}): React.ReactElement {
  const mt = item.spaceBefore ? 1 : 0
  const { gutterColor, textColor, dim, bold } = styleFor(item)

  // Plain assistant prose: no gutter, just spaced text.
  if (item.kind === 'assistant') {
    return (
      <Box marginTop={mt}>
        <Text>{item.text}</Text>
      </Box>
    )
  }

  // Long tool results and user turns collapse to a compact body with a
  // "+N lines" marker unless ctrl+r has expanded the transcript.
  const clamped =
    !expanded && isCollapsible(item)
      ? clampLines(item.text, COLLAPSE_LINES)
      : { body: item.text, more: 0 }

  return (
    <Box marginTop={mt}>
      <Box width={2}>
        <Text color={gutterColor} dimColor={dim && !item.isError}>
          {item.gutter ?? ''}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Text color={textColor} dimColor={dim} bold={bold}>
          {clamped.body}
          {item.detail ? <Text dimColor>{item.detail}</Text> : null}
        </Text>
        {clamped.more > 0 && <Text dimColor>… +{clamped.more} lines (ctrl+r to expand)</Text>}
      </Box>
    </Box>
  )
})
