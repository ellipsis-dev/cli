import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink'
import { ApiClient, ApiError } from '../lib/api'
import { streamSession, StreamUnavailableError, type StreamFrame } from '../lib/ws'
import {
  clampLines,
  collapseToolRuns,
  foldCosts,
  isConnectVisibleRecord,
  pendingToolCalls,
  recordToItems,
  resultCostUsd,
  statusActivityText,
  type CCEvent,
  type ItemKind,
  type TranscriptItem,
} from '../lib/events'
import { hyperlink } from '../lib/urls'
import { VERSION } from '../lib/constants'

// The interactive `agent session connect` UI, modelled on Claude Code: a
// committed transcript that groups tool calls with their results and spaces
// messages apart, above a live footer with an animated status spinner and a
// composer that echoes what you send. Rendering shape lives in lib/events.ts
// (pure); this component owns the data flow, the composer, and the colours.
//
// Data flow: the committed transcript comes from the structured records API
// (GET /v1/sessions/{id}/records, whose payload is the full native event) —
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
  // The highest feed_seq already rendered into initialItems, so live refreshes
  // only append records newer than what's on screen (feed_seq is the shared
  // per-session order across transcript + lifecycle records).
  initialMaxFeedSeq: number
  initialStatus: string
  // The clickable dashboard link for this session (app.ellipsis.dev/…/sessions/{id}),
  // shown in the footer status line.
  sessionUrl: string
  // Spend seeded from the stored steps: cumulative total + the last turn's cost.
  initialCost: { total: number | null; lastStep: number | null }
  // A one-line caveat shown as the app's opening notice (e.g. "watch-only:
  // this conversation is closed"). null for the normal connect.
  initialNotice?: string | null
  // The session's model (backend tokens_model, fixed at creation), shown in
  // the banner under the dashboard link.
  model?: string | null
  // Written (not read) by the app: set true when the app exits because the
  // conversation closed, so the caller skips the "detached — still running"
  // sign-off (the session is not still running).
  exitState?: { closed: boolean }
}

// Surface statuses in which something is actively happening — drives the
// spinner. `waiting` (turn done, warm, your move) and `sleeping` (parked) are
// deliberately NOT here: the spinner stops and the footer reads the calm state
// instead of a misleading "running".
function isWorkingStatus(status: string): boolean {
  return ['scheduled', 'starting', 'working', 'retrying'].includes(status)
}

// One local send awaiting server acknowledgement: postSeq is null while the
// POST is in flight, then the monotonic order in which it resolved — used to
// retire the chip once an inbox fetch is guaranteed to cover it (see
// refreshSteps).
type QueuedSend = { text: string; postSeq: number | null }

export function ConnectApp(props: ConnectAppProps): React.ReactElement {
  const { api, token, sessionId, wsBase, canSend } = props
  const { exit } = useApp()
  const { isRawModeSupported } = useStdin()
  const { stdout } = useStdout()

  // Terminal height, tracked across resizes, so the app fills the whole
  // window Claude Code-style: banner at top, composer + meta pinned to the
  // bottom, the transcript growing through the space between. One row is
  // left for the shell cursor so the first paint never scrolls.
  const [termRows, setTermRows] = useState(stdout?.rows ?? 24)
  useEffect(() => {
    if (!stdout) return
    const onResize = (): void => setTermRows(stdout.rows)
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])

  const [items, setItems] = useState<TranscriptItem[]>(props.initialItems)
  const [status, setStatus] = useState(props.initialStatus)
  const [working, setWorking] = useState(isWorkingStatus(props.initialStatus))
  const [elapsed, setElapsed] = useState(0)
  const [notice, setNotice] = useState<string | null>(props.initialNotice ?? null)
  const [input, setInput] = useState('')
  // ctrl+r toggles full vs. collapsed tool output across the whole transcript.
  const [expanded, setExpanded] = useState(false)
  // Messages you've sent that the agent hasn't picked up yet — shown as a
  // queued region below the composer, exactly like Claude Code. A send renders
  // as a LOCAL chip only until a records/turns refresh that started after its
  // POST resolved confirms the server has the message (postSeq, see
  // refreshSteps); from then on the server's own pending rows (serverQueued)
  // are the queued truth. That keeps the region honest even when the agent
  // consumes messages in ways local text-matching can't follow (the server once
  // coalesced two queued sends into one "a\nb" user turn, stranding both chips
  // forever). Chips also leave via the transcript: when the backend relays a
  // send as a user turn, or when the turn idles (whichever first), so a send is
  // never lost.
  const [queued, setQueued] = useState<QueuedSend[]>([])
  // Bodies of the server's PENDING inbox messages — the durable queued signal.
  const [serverQueued, setServerQueued] = useState<string[]>([])
  // Ephemeral live-streaming overlay for the CURRENT assistant response, driven
  // by `delta` frames: the prose so far and the running output-token count. Both
  // clear when the committed assistant step lands (it supersedes the overlay) or
  // the turn settles.
  const [liveText, setLiveText] = useState('')
  const [liveTokens, setLiveTokens] = useState<number | null>(null)
  // Running spend for the footer: `total` is the cumulative session cost from
  // the latest Claude Code result; `lastStep` is the cost of the most recent
  // turn (the delta between the last two results).
  const [cost, setCost] = useState(props.initialCost)

  // Live-flow state that must survive re-renders without triggering them.
  const afterSeq = useRef(0)
  const streaming = useRef(false)
  const abort = useRef(new AbortController())
  const lastStatus = useRef(props.initialStatus)
  const keyCounter = useRef(0)
  // The highest feed_seq committed to the transcript, and the refresh
  // in-flight / re-run guards so overlapping wakes don't double-append.
  const maxFeed = useRef(props.initialMaxFeedSeq)
  // The cumulative cost last committed, so a new result's delta = the turn cost.
  const costTotal = useRef(props.initialCost.total)
  // Whether the sandbox ever reached `running`, so a terminal status *before*
  // that (a preflight/budget gate) is reported as a failure, not idle.
  const everRunning = useRef(props.initialStatus === 'running')
  const refreshing = useRef(false)
  const pendingRefresh = useRef(false)
  // Guard so the closed-conversation teardown (final refresh + exit) runs once
  // no matter which signal lands first (status frame, poll, stream end).
  const closingDown = useRef(false)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A mirror of `queued` for async callbacks, and the texts already committed
  // locally so the backend's later echo of the same send is dropped.
  const queuedRef = useRef<QueuedSend[]>([])
  const flushed = useRef<string[]>([])
  useEffect(() => {
    queuedRef.current = queued
  }, [queued])
  // Mirror of serverQueued for the refresh gate, and the monotonic counter
  // stamped onto a chip when its POST resolves (see refreshSteps).
  const serverQueuedRef = useRef<string[]>([])
  useEffect(() => {
    serverQueuedRef.current = serverQueued
  }, [serverQueued])
  const postSeqCounter = useRef(0)
  const fetchedTurnsOnce = useRef(false)

  // Append items, promoting a queued send when its user turn arrives and
  // dropping the backend's echo of a send we already committed locally.
  const append = useCallback((incoming: TranscriptItem[]): void => {
    const commit: TranscriptItem[] = []
    for (const it of incoming) {
      if (it.kind === 'user') {
        if (queuedRef.current.some((q) => q.text === it.text)) {
          setQueued((prev) => {
            const j = prev.findIndex((q) => q.text === it.text)
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

  // Fold a committed event into the footer spend: a result carries the running
  // total, so the turn cost is its delta from the previous total.
  const applyCost = useCallback((event: CCEvent): void => {
    const total = resultCostUsd(event)
    if (total == null) return
    const prev = costTotal.current
    costTotal.current = total
    setCost({
      total,
      lastStep: prev != null ? Math.max(0, total - prev) : total,
    })
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
      // Reconcile the queued region against the server's inbox whenever there
      // is anything to reconcile (plus once at startup, to pick up messages
      // already pending on reconnect). A chip whose POST resolved BEFORE this
      // fetch started (postSeq < startSeq) is guaranteed to be in the fetched
      // list, so the server rows take over as its representation and the chip
      // retires — delivered messages vanish, still-pending ones re-render from
      // serverQueued with identical text.
      const wantTurns =
        !fetchedTurnsOnce.current ||
        queuedRef.current.length > 0 ||
        serverQueuedRef.current.length > 0
      const startSeq = postSeqCounter.current
      const turnsPromise = wantTurns
        ? api.getAgentSessionTurns(sessionId).catch(() => null)
        : Promise.resolve(null)
      const records = await api.getAgentSessionRecords(sessionId)
      const turns = await turnsPromise
      if (turns !== null) {
        fetchedTurnsOnce.current = true
        setServerQueued(
          turns.messages.filter((m) => m.status === 'pending').map((m) => m.body),
        )
        setQueued((prev) => prev.filter((q) => q.postSeq === null || q.postSeq >= startSeq))
      }
      const ordered = [...records].sort((a, b) => a.feed_seq - b.feed_seq)
      const fresh = ordered.filter((st) => st.feed_seq > maxFeed.current)
      if (fresh.length) {
        for (const st of fresh) {
          maxFeed.current = Math.max(maxFeed.current, st.feed_seq)
          applyCost(st.payload as CCEvent)
        }
        // Lifecycle rows stay off the transcript — the activity line + footer
        // carry session state, closing surfaces as the exit notice — except
        // the sandbox-ready conversation note (isConnectVisibleRecord).
        append(
          fresh.filter(isConnectVisibleRecord).flatMap((st) => recordToItems(st, `s${st.feed_seq}`)),
        )
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
  }, [api, append, applyCost, sessionId])

  // A closed conversation is over — nothing can ever be sent or received
  // again (a send would 409) — so pull the final records, leave one dim
  // notice as the sign-off, and exit instead of sitting at the composer.
  const finishClosed = useCallback((): void => {
    if (closingDown.current) return
    closingDown.current = true
    if (props.exitState) props.exitState.closed = true
    setWorking(false)
    setNotice('conversation closed')
    void refreshSteps().finally(() => exit())
  }, [exit, props.exitState, refreshSteps])

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
        // Box-up states (working/waiting) mean the session became connectable;
        // used to tell a preflight failure from a mid-conversation one.
        if (['working', 'waiting'].includes(frame.status)) everRunning.current = true
        if (frame.status === 'closed') {
          finishClosed()
          return
        }
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
    [finishClosed, scheduleRefresh],
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
        // A terminal failure before the sandbox ever ran is a preflight/budget
        // gate — there's no conversation to attend, so report it and exit.
        if (
          outcome.type === 'done' &&
          !everRunning.current &&
          ['failed', 'cancelled', 'stopped'].includes(outcome.status)
        ) {
          setNotice(`session ${outcome.status} before it became connectable`)
          process.exitCode = 1
          exit()
          return
        }
        // The warm loop can end by closing the conversation (a closing event's
        // final turn, or an ephemeral session finishing): that's terminal, not
        // an idle nap — tear down instead of inviting a doomed send.
        if (outcome.type === 'done' && lastStatus.current === 'closed') {
          finishClosed()
          return
        }
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
  }, [canSend, exit, finishClosed, handleFrame, refreshSteps, sessionId, token, wsBase])

  // A status backstop that doesn't depend on the socket: the lifecycle
  // transitions may arrive before the socket attaches, so poll the session too
  // and drive the same transition handling. Use the derived surface word so this
  // matches the stream's `frame.status` exactly (the raw `status` is a different
  // vocabulary); fall back to raw for un-keyed sessions. `lastStatus` dedupes
  // against socket frames so a transition is only announced once.
  const pollStatus = useCallback(async (): Promise<void> => {
    try {
      const s = await api.getAgentSession(sessionId)
      const word = s.surface?.status ?? s.status
      if (word !== lastStatus.current) {
        lastStatus.current = word
        setStatus(word)
        setWorking(isWorkingStatus(word))
        if (['working', 'waiting'].includes(word)) everRunning.current = true
        if (word === 'closed') finishClosed()
      }
    } catch {
      // Transient fetch failure — the next tick retries.
    }
  }, [api, finishClosed, sessionId])

  useEffect(() => {
    pump()
    scheduleRefresh() // catch steps created between the initial fetch and connect
    // A slow poll backs up the socket wake (and covers a socket that never
    // connected, so following still updates). The socket wake is the fast path;
    // this is just a safety net, so it can be gentle.
    const poll = setInterval(scheduleRefresh, 3000)
    const statusPoll = setInterval(() => void pollStatus(), 3000)
    const controller = abort.current
    return () => {
      controller.abort()
      clearInterval(poll)
      clearInterval(statusPoll)
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pump, scheduleRefresh, pollStatus])

  // Tick an elapsed-seconds counter while the agent works — a steady progress
  // read alongside the live token counter, and the sole liveness cue during a
  // long tool call (which streams no assistant deltas). Reset each turn.
  useEffect(() => {
    if (!working) return
    setElapsed(0)
    const t = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(t)
  }, [working])

  // The tool calls executing right now (an unmatched tool_use in the committed
  // transcript — see pendingToolCalls), with a per-burst seconds ticker so a
  // long Bash call reads "Running Bash(pytest…)… (34s)" instead of dead air.
  const pendingTools = useMemo(() => pendingToolCalls(items), [items])
  // The queued region: the server's pending inbox rows are the truth; a local
  // chip shows only while the server doesn't yet cover it (multiset-subtracted
  // by text so a send never renders twice during the handoff window).
  const queuedDisplay = useMemo(() => {
    const counts = new Map<string, number>()
    for (const b of serverQueued) counts.set(b, (counts.get(b) ?? 0) + 1)
    const extras: string[] = []
    for (const q of queued) {
      const n = counts.get(q.text) ?? 0
      if (n > 0) counts.set(q.text, n - 1)
      else extras.push(q.text)
    }
    return [...serverQueued, ...extras]
  }, [serverQueued, queued])
  const [toolElapsed, setToolElapsed] = useState(0)
  const pendingToolKey = pendingTools.length > 0 ? pendingTools[0].key : null
  useEffect(() => {
    if (pendingToolKey == null) return
    setToolElapsed(0)
    const t = setInterval(() => setToolElapsed((e) => e + 1), 1000)
    return () => clearInterval(t)
  }, [pendingToolKey])

  // When the turn goes idle, commit any still-queued messages into the
  // transcript (they weren't relayed) so they never vanish; remember them so a
  // late backend echo is de-duplicated. A message sent while already idle
  // flushes immediately — it starts a fresh turn rather than queueing.
  useEffect(() => {
    if (working || queued.length === 0) return
    flushed.current.push(...queued.map((q) => q.text))
    const items = queued.map<TranscriptItem>((q) => ({
      key: `q${keyCounter.current++}`,
      kind: 'user',
      gutter: '›',
      text: q.text,
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
          // transcript at once), then post it and wait for the turn. Once the
          // POST resolves the server owns the message: stamp the chip with the
          // next postSeq so the first inbox fetch that starts after this point
          // retires it in favour of the server's own pending row.
          setQueued((prev) => [...prev, { text, postSeq: null }])
          setNotice(null)
          await api.sendSessionMessage(sessionId, text)
          const seq = ++postSeqCounter.current
          setQueued((prev) => {
            let stamped = false
            return prev.map((q) => {
              if (!stamped && q.text === text && q.postSeq === null) {
                stamped = true
                return { text: q.text, postSeq: seq }
              }
              return q
            })
          })
          setWorking(true)
          pump()
        } catch (err) {
          setQueued((prev) => {
            const j = prev.findIndex((q) => q.text === text && q.postSeq === null)
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
  // committed blocks. Collapsed (the default), runs of consecutive tool
  // activity fold into one "Ran N shell commands" line, Claude-Code-app-style;
  // ctrl+r restores the full ● call / ⎿ result blocks (and un-clamps long
  // bodies). The list is memoized on [items, expanded], so the elapsed-second
  // ticks reuse the same elements and don't re-lay-out the transcript.
  const lines = useMemo(() => {
    const visible = expanded ? items : collapseToolRuns(items)
    return visible.map((item) => <TranscriptLine key={item.key} item={item} expanded={expanded} />)
  }, [items, expanded])

  // The persistent footer status line, kept minimal: the current status and
  // the running spend (cumulative total + the last turn's cost). Session
  // identity lives in the banner; command hints live in --help.
  const totalStr = `$${(cost.total ?? 0).toFixed(2)}`
  const lastStepStr = cost.lastStep != null ? ` (Last step: $${cost.lastStep.toFixed(2)})` : ''
  const metaLine = `${status} · ${totalStr} total${lastStepStr}`
  // Three distinct, factual activity signals — never whimsy:
  // - `infraActivity`: the sandbox is spawning/waking (scheduled/starting/
  //   retrying). Shown at the TOP, under the banner, where a startup message
  //   belongs — there's no conversation yet to sit above a composer.
  // - `generating`: the model is streaming tokens (delta frames flowing) —
  //   the ✻ line above the composer, with elapsed + token count.
  // - `runningTool`: a committed tool call awaits its result — the same ✻
  //   slot names the tool and ticks its own timer (generating wins if both
  //   somehow read true; the model can't stream past an unresolved call).
  const infraActivity = statusActivityText(status)
  const generating = status === 'working' && (liveText !== '' || liveTokens != null)
  const generatingBits = [
    formatElapsed(elapsed),
    ...(liveTokens != null ? [`↓ ${formatTokens(liveTokens)} tokens`] : []),
    ...(inputActive ? ['esc to interrupt'] : []),
  ].join(' · ')
  const runningTool = status === 'working' && !generating && pendingTools.length > 0
  const runningToolLabel =
    pendingTools.length === 1
      ? `Running ${pendingTools[0].text}${pendingTools[0].detail ?? ''}`
      : `Running ${pendingTools.length} tool calls (${[...new Set(pendingTools.map((t) => t.text))].join(', ')})`
  const runningToolBits = [
    formatElapsed(toolElapsed),
    ...(inputActive ? ['esc to interrupt'] : []),
  ].join(' · ')

  return (
    <Box flexDirection="column" minHeight={termRows - 1}>
      {/* The banner: brand + version, then the session's dashboard link —
          Claude Code's header, Ellipsis-flavoured. Session identity lives here
          and in the footer; nothing is printed to scrollback before the app. */}
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        <Text>
          <Text color="cyan" bold>
            {' ●●● '}
          </Text>
          <Text bold> Ellipsis</Text>
          <Text dimColor> v{VERSION}</Text>
        </Text>
        <Text dimColor>
          {'      '}
          {hyperlink(props.sessionUrl, props.sessionUrl)}
        </Text>
        {props.model && (
          <Text dimColor>
            {'      '}
            {props.model}
          </Text>
        )}
      </Box>
      {/* Sandbox spawn/wake progress, at the top where startup belongs;
          re-renders in place and disappears once the session is live. */}
      {infraActivity && (
        <Text>
          <Text color="cyan">✻</Text>{' '}
          <Text dimColor>
            {infraActivity}… ({formatElapsed(elapsed)})
          </Text>
        </Text>
      )}
      {/* The transcript grows through the middle of the terminal, pinning the
          composer + meta to the bottom edge (flexGrow fills the slack). */}
      <Box flexDirection="column" flexGrow={1}>
        {lines}
        {/* The in-progress assistant response, streamed token-by-token from delta
            frames; replaced by the committed step when it lands. */}
        {liveText && (
          <Box marginTop={1}>
            <Text>{liveText}</Text>
          </Box>
        )}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {notice && <Text dimColor>· {notice}</Text>}
        {generating && (
          <Text>
            <Text color="cyan">✻</Text>{' '}
            <Text dimColor>Generating… ({generatingBits})</Text>
          </Text>
        )}
        {runningTool && (
          <Text>
            <Text color="cyan">✻</Text>{' '}
            <Text dimColor>
              {runningToolLabel}… ({runningToolBits})
            </Text>
          </Text>
        )}
        {/* The composer, framed by a full-width rule above and below (Claude
            Code-style): the › prompt sits between the two lines. Only the top and
            bottom borders are drawn, so the rules span the terminal width. */}
        {inputActive && (
          <Box borderStyle="single" borderLeft={false} borderRight={false} borderDimColor>
            <Text color="cyan">› </Text>
            <Text>{input}</Text>
            <Text inverse> </Text>
          </Box>
        )}
        {queuedDisplay.length > 0 && (
          <Box flexDirection="column">
            {queuedDisplay.map((text, i) => (
              <Text key={`q${i}`} dimColor>
                ⏳ queued · {text}
              </Text>
            ))}
          </Box>
        )}
        <Text dimColor>{metaLine}</Text>
      </Box>
    </Box>
  )
}

// Compact token count for the live footer: 1400 -> "1.4k", 900 -> "900".
function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

// Elapsed seconds in Claude Code's style: "42s", then "1m 25s" past a minute.
function formatElapsed(s: number): string {
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
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
      return {
        textColor: item.isError ? 'red' : undefined,
        dim: !item.isError,
        bold: false,
      }
    case 'user':
      return { gutterColor: 'cyan', textColor: 'cyan', bold: true, dim: false }
    case 'error':
      return { gutterColor: 'red', textColor: 'red', dim: false, bold: false }
    case 'summary':
      return {
        textColor: item.isError ? 'red' : undefined,
        dim: true,
        bold: false,
      }
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
