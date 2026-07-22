import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink'
import {
  streamSession,
  sessionStatusWord,
  StreamUnavailableError,
  type OpenSocket,
} from '@ellipsis-dev/sdk/stream'
import {
  cacheTierLabel,
  clampLines,
  collapseToolRuns,
  foldCosts,
  formatDuration,
  lifecycleText,
  pendingToolCalls,
  recordToItems,
  sandboxOutputLines,
  sandboxOutputStep,
  sandboxPhaseLabel,
  statusActivityText,
  oneLine,
  type CCEvent,
  type ItemKind,
  type SessionTranscriptStore,
  type TranscriptItem,
} from '@ellipsis-dev/sdk/store'
import { ApiClient, ApiError } from '../lib/api'
import { hyperlink } from '../lib/urls'
import { usdNumberFromMillicents } from '../lib/output'
import { VERSION } from '../lib/constants'

// The interactive `agent session connect` UI, modelled on Claude Code: a
// committed transcript that groups tool calls with their results and spaces
// messages apart — live activity (✻ Running/Generating) rendered on the
// transcript block it describes — above a footer with a composer that echoes
// what you send. Rendering shape lives in @ellipsis-dev/sdk/store (pure); this
// component owns the data flow, the composer, and the colours.
//
// Data flow: ONE SessionTranscriptStore (pre-seeded by the caller with the
// stored records + session, so the first paint is instant) is fed by the
// SDK's streamSession — records arrive PUSHED as records_append frames, the
// session/messages frames carry status + the open inbox, and ephemeral
// `delta` frames overlay the in-progress response token-by-token. Everything
// on screen derives from the store snapshot; there is no REST refresh loop.
// If the stream is unavailable (old backend, blocked socket), a REST poll
// feeds the SAME store through synthetic frames, so the UI is identical
// either way.

export interface ConnectAppProps {
  api: ApiClient
  sessionId: string
  // The one transcript store, pre-seeded with the fetched records + session.
  store: SessionTranscriptStore
  // The bearer-door socket factory (lib/stream.ts makeOpenSocket).
  openSocket: OpenSocket
  // Keyed, open sessions accept messages (show the composer); single-shot /
  // closed / --no-input sessions follow read-only and exit when the stream ends.
  canSend: boolean
  // Records at or below this feed_seq are not RENDERED (--no-records skips
  // replaying history on screen without re-streaming it). 0 renders everything.
  minRenderFeedSeq: number
  // The clickable dashboard link for this session
  // (app.ellipsis.dev/{login}?session={id}), shown in the footer status line.
  sessionUrl: string
  // A one-line caveat shown as the app's opening notice (e.g. "watch-only:
  // this conversation is closed"). null for the normal connect.
  initialNotice?: string | null
  // The session's model (backend tokens_model, fixed at creation), shown in
  // the footer meta line.
  model?: string | null
  // The session's agent config (resolved name, falling back to the config
  // id), shown in the footer meta line when the session has one.
  configName?: string | null
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

// Blank rows rendered above the app's first line: two of visual breathing
// room above the ✻ startup header, plus two of sacrificial slack — see the
// termRows comment in ConnectApp for what the slack absorbs.
const TOP_PAD = 4

// One local send awaiting server acknowledgement: messageId is null while the
// POST is in flight, then the created SessionMessage's id (protocol v2 §4.2) —
// the chip retires the moment the store acknowledges that id (a messages
// frame, or the transcript user-echo record's session_message_id
// back-reference), and the server's own pending row takes over.
type QueuedSend = { text: string; messageId: string | null }

export function ConnectApp(props: ConnectAppProps): React.ReactElement {
  const { api, sessionId, store, openSocket, canSend } = props
  const { exit } = useApp()
  const { isRawModeSupported } = useStdin()
  const { stdout } = useStdout()

  // Terminal height, tracked across resizes, so the app fills the whole
  // window Claude Code-style: composer + meta pinned to the bottom edge (one
  // row below is left for the shell cursor), the transcript growing through
  // the space between, and TOP_PAD blank rows of padding above the first
  // line. The padding is deliberate slack: terminals that consume an extra
  // row (observed in practice) and the caller's post-exit sign-off line
  // ("resume with: …") each scroll one padding row into scrollback instead
  // of the app's first line, so the sandbox startup notes stay visible.
  const [termRows, setTermRows] = useState(stdout?.rows ?? 24)
  const [termCols, setTermCols] = useState(stdout?.columns ?? 80)
  useEffect(() => {
    if (!stdout) return
    const onResize = (): void => {
      setTermRows(stdout.rows)
      setTermCols(stdout.columns)
    }
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])

  // The store snapshot is the single source of truth for everything streamed.
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const statusWord = snapshot.session ? sessionStatusWord(snapshot.session) : 'starting'
  // Bridge the gap between a send and the server's status flip: treat the
  // session as working until the next status transition lands.
  const [sendPending, setSendPending] = useState(false)
  useEffect(() => {
    setSendPending(false)
  }, [statusWord])
  const working = isWorkingStatus(statusWord) || sendPending

  const [elapsed, setElapsed] = useState(0)
  const [notice, setNotice] = useState<string | null>(props.initialNotice ?? null)
  // The composer's text and caret position (0..text.length), one state so
  // rapid keypresses between renders can't desync them. Left/right move the
  // caret, up/down walk the lines of a multi-line input like a normal text
  // editor, and up on line 1 hands focus to the transcript (navKey below).
  const [composer, setComposer] = useState({ text: '', cursor: 0 })
  // ctrl+r toggles full vs. collapsed tool output across the whole transcript.
  const [expanded, setExpanded] = useState(false)
  // Transcript navigation: the key of the highlighted line ('sandbox' for the
  // startup block, else a TranscriptItem key), or null while the composer has
  // focus. Up from the composer's first line enters at the newest line; down
  // past the newest line (or esc) returns to the composer. The highlighted
  // line renders a › gutter in cyan.
  const [navKey, setNavKey] = useState<string | null>(null)
  // Lines opened in place with → while highlighted: a grp:* fold expands into
  // its tool calls, a clamped long body un-clamps. ← closes them again.
  const [openedKeys, setOpenedKeys] = useState<ReadonlySet<string>>(new Set())
  // The transcript viewport: the key of the entry pinned to the top of the
  // window, or null to follow the bottom (the default — new content stays in
  // view). The scroll wheel / trackpad moves it; moving the ↑/↓ highlight out
  // of frame snaps it so the highlighted entry comes back into view.
  const [scrollKey, setScrollKey] = useState<string | null>(null)
  // Whether the terminal's mouse reporting is armed (wheel/trackpad scrolls
  // the transcript). Capturing the mouse steals native text selection, so
  // ctrl+s releases it for copy/paste and re-arms it — the terminal's own
  // bypass (shift-drag, or option-drag in iTerm2) works either way.
  const [mouseCapture, setMouseCapture] = useState(true)
  // Messages you've sent that the server hasn't acknowledged yet — shown
  // IMMEDIATELY as dim rows at the bottom of the transcript, so a send always
  // appears in the chat the moment you hit enter. From the first
  // acknowledgement on (a messages frame or the user-echo record carrying the
  // id), the server's own pending rows (serverQueued) are the queued truth,
  // and once the agent consumes the message its echo record lands as the
  // real (full-colour) transcript row.
  const [queued, setQueued] = useState<QueuedSend[]>([])

  // Whether the sandbox ever reached a connectable state, so a terminal status
  // *before* that (a preflight/budget gate) is reported as a failure, not idle.
  const everRunning = useRef(isWorkingStatus(statusWord) && statusWord !== 'scheduled')
  useEffect(() => {
    if (['working', 'waiting'].includes(statusWord)) everRunning.current = true
  }, [statusWord])

  const streaming = useRef(false)
  const polling = useRef(false)
  const abort = useRef(new AbortController())
  // Guard so the closed-conversation teardown runs once no matter which signal
  // lands first (session frame, poll, stream outcome).
  const closingDown = useRef(false)

  // The committed transcript, derived from the store's record log. Keys ride
  // feed_seq (the shared per-session order), so items are stable across
  // re-derivations.
  // Lifecycle records are excluded entirely: the sandbox story renders as the
  // one-line progress block up top (sandboxProgress), not as transcript rows.
  const items = useMemo(
    () =>
      snapshot.records
        .filter((r) => r.feed_seq > props.minRenderFeedSeq)
        .filter((r) => r.source !== 'lifecycle')
        .flatMap((r) => recordToItems(r, `s${r.feed_seq}`)),
    [snapshot.records, props.minRenderFeedSeq],
  )

  // Footer spend: the server's ledger total (the session frame's four cost
  // columns — the billing authority, resent on every cost tick) with the
  // CC-result fold as the last-turn readout and older-backend fallback (§6:
  // record folding is display-only).
  const cost = useMemo(
    () =>
      foldCosts(
        snapshot.records
          .filter((r) => r.source === 'claude_code')
          .map((r) => r.payload as CCEvent),
      ),
    [snapshot.records],
  )
  const serverCostUsd = snapshot.session
    ? usdNumberFromMillicents(
        snapshot.session.cost_tokens +
          snapshot.session.cost_sandbox_cpu +
          snapshot.session.cost_sandbox_memory +
          snapshot.session.cost_fee,
      )
    : null

  // The sandbox startup timeline, derived from the lifecycle records of the
  // latest start (a session_starting wake/retry or sandbox_starting record
  // resets it, so a wake tells a fresh story): dim session notes, one step
  // per provisioning phase — opened by its sandbox_phase `started`
  // transition, closed with its cache-tier/duration note — accumulating the
  // log lines of its sandbox_output chunks, plus the sandbox_ready summary.
  // Completed steps STACK as ✓ lines (the design-doc §3 timeline) instead of
  // rewriting one line in place; the live step ticks under them with its
  // latest output line. Highlighting the block (↑ from the composer) and
  // pressing → opens the step list, and arrow keys drill into a step's logs.
  // The block persists after startup as the durable trace (the sandbox_ready
  // transcript notice is suppressed below in its favour).
  const sandbox = useMemo(
    () => deriveSandboxState(snapshot.records, props.minRenderFeedSeq),
    [snapshot.records, props.minRenderFeedSeq],
  )
  const [sandboxOpen, setSandboxOpen] = useState(false)
  const [stepCursor, setStepCursor] = useState(0)
  const [stepLogsOpen, setStepLogsOpen] = useState(false)

  // Bodies of the server's PENDING inbox messages — the durable queued signal.
  const serverQueued = useMemo(
    () => snapshot.messages.filter((m) => m.status === 'pending').map((m) => m.body),
    [snapshot.messages],
  )

  // Retire local chips the store has acknowledged (by SessionMessage id): once
  // an id shows up in a messages frame or a transcript user-echo record, the
  // server's own rows are the truth for that send.
  useEffect(() => {
    setQueued((prev) => {
      const remaining = prev.filter(
        (q) => q.messageId === null || !snapshot.acknowledgedMessageIds.has(q.messageId),
      )
      return remaining.length === prev.length ? prev : remaining
    })
  }, [snapshot.acknowledgedMessageIds])

  // A closed conversation is over — nothing can ever be sent or received
  // again (a send would 409) — so leave one dim notice as the sign-off and
  // exit instead of sitting at the composer. The server flushes the final
  // records before the closing session frame, so there is nothing to fetch.
  const finishClosed = useCallback((): void => {
    if (closingDown.current) return
    closingDown.current = true
    if (props.exitState) props.exitState.closed = true
    setNotice('conversation closed')
    exit()
  }, [exit, props.exitState])
  useEffect(() => {
    if (statusWord === 'closed') finishClosed()
  }, [statusWord, finishClosed])

  // REST fallback when the stream is unavailable: poll the records + session
  // and feed the SAME store through synthetic frames (the REST rows are the
  // same wire shapes) — the cursor dedupes, the UI can't tell the difference.
  const startPollFallback = useCallback((): void => {
    if (polling.current || abort.current.signal.aborted) return
    polling.current = true
    const tick = async (): Promise<void> => {
      try {
        const [page, session] = await Promise.all([
          api.getAgentSessionRecordsPage(sessionId, { afterSeq: store.cursor }),
          api.getAgentSession(sessionId),
        ])
        if (page.records.length) {
          // Inbox state (message_received/delivered/requeued) rides the record
          // feed now (protocol v3) — the store folds it as records land.
          store.ingest({ type: 'records_append', records: page.records })
        }
        store.ingest({ type: 'session', session })
      } catch {
        // Transient fetch failure — the next tick retries.
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 3000)
    abort.current.signal.addEventListener('abort', () => clearInterval(timer), {
      once: true,
    })
  }, [api, sessionId, store])

  // Keep the socket attached across reconnects/resume. A keyed session going
  // terminal is not the end of the conversation — it idles between turns — so
  // we report idle and re-attach on the next send. Watch-only sessions exit
  // when the stream ends.
  const pump = useCallback((): void => {
    if (streaming.current || abort.current.signal.aborted) return
    streaming.current = true
    streamSession({
      sessionId,
      openSocket,
      afterSeq: store.cursor,
      onFrame: store.ingest,
      signal: abort.current.signal,
    })
      .then((outcome) => {
        if (abort.current.signal.aborted) return
        setSendPending(false)
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
        if (outcome.type === 'done' && outcome.status === 'closed') {
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
        if (err instanceof StreamUnavailableError) {
          // No socket (old backend, blocked port): fall back to REST polling,
          // silently — the store keeps filling, so the fallback is invisible.
          startPollFallback()
          return
        }
        setNotice(`stream error: ${(err as Error).message}`)
        if (!canSend) exit()
      })
      .finally(() => {
        streaming.current = false
      })
  }, [canSend, exit, finishClosed, openSocket, sessionId, startPollFallback, store])

  useEffect(() => {
    pump()
    const controller = abort.current
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pump])

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
  // Which silence a started-but-quiet turn is in ('boot': Claude Code is
  // still starting in the sandbox; 'turn': the warm agent between records),
  // for the fallback live line's label.
  const awaitingAgent = useMemo(() => awaitingAgentPhase(snapshot.records), [snapshot.records])

  // Sends the agent took mid-gap: delivered to the agent but its user-echo
  // transcript record hasn't landed yet (the echo can lag by a whole sandbox
  // wake). Rendered as full-colour user rows until the echo replaces them.
  const acceptedSends = useMemo(
    () => deliveredUnechoedSends(snapshot.records),
    [snapshot.records],
  )

  // Every in-flight send, oldest pipeline stage last, at the transcript's
  // bottom edge: 'accepted' (delivered, awaiting its echo record — full
  // colour), 'queued' (the server's pending inbox — dim), 'sending' (the
  // POST is in flight — dim). Local chips are multiset-subtracted by text so
  // a send never renders twice during the received-record handoff window.
  const inFlightSends = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of serverQueued) counts.set(m, (counts.get(m) ?? 0) + 1)
    const extras: string[] = []
    for (const q of queued) {
      const n = counts.get(q.text) ?? 0
      if (n > 0) counts.set(q.text, n - 1)
      else extras.push(q.text)
    }
    return [
      ...acceptedSends.map((m) => ({ key: m.id, text: m.body, state: 'accepted' as const })),
      ...serverQueued.map((text, i) => ({ key: `sq${i}`, text, state: 'queued' as const })),
      ...extras.map((text, i) => ({ key: `lq${i}`, text, state: 'sending' as const })),
    ]
  }, [acceptedSends, serverQueued, queued])
  const [toolElapsed, setToolElapsed] = useState(0)
  const pendingToolKey = pendingTools.length > 0 ? pendingTools[0].key : null
  useEffect(() => {
    if (pendingToolKey == null) return
    setToolElapsed(0)
    const t = setInterval(() => setToolElapsed((e) => e + 1), 1000)
    return () => clearInterval(t)
  }, [pendingToolKey])

  const submit = useCallback(
    (raw: string): void => {
      const text = raw.trim()
      setComposer({ text: '', cursor: 0 })
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
          // Show the message as queued, then post it. The POST returns the
          // created SessionMessage (protocol v2 §4.2): stamp the chip with its
          // id so the first messages frame / user-echo record carrying that id
          // retires it in favour of the server's own row.
          setQueued((prev) => [...prev, { text, messageId: null }])
          setNotice(null)
          const created = await api.sendSessionMessage(sessionId, text)
          setQueued((prev) => {
            let stamped = false
            return prev.map((q) => {
              if (!stamped && q.text === text && q.messageId === null) {
                stamped = true
                return { text: q.text, messageId: created.id }
              }
              return q
            })
          })
          setSendPending(true)
          pump()
        } catch (err) {
          setQueued((prev) => {
            const j = prev.findIndex((q) => q.text === text && q.messageId === null)
            return j < 0 ? prev : [...prev.slice(0, j), ...prev.slice(j + 1)]
          })
          setNotice(`✗ ${err instanceof ApiError ? err.detail : (err as Error).message}`)
        }
      })()
    },
    [api, exit, pump, sessionId],
  )

  const inputActive = canSend && isRawModeSupported

  // Mouse reporting (SGR), so wheel/trackpad scroll reaches the app as input
  // instead of scrolling the terminal's (empty) scrollback. Capturing the
  // mouse steals native text selection, so ctrl+s toggles the capture off
  // for normal select/copy (the terminal's shift/option-drag bypass works
  // while armed, too). Turned off again on unmount.
  useEffect(() => {
    if (!inputActive || !mouseCapture || !stdout) return
    stdout.write('\u001B[?1000h\u001B[?1006h')
    return () => {
      stdout.write('\u001B[?1006l\u001B[?1000l')
    }
  }, [inputActive, mouseCapture, stdout])

  // The rendered transcript lines, in order: collapsed (the default) folds
  // consecutive tool activity into "Ran N …" notices, except folds opened in
  // place with → (openedKeys), which render their tool calls right below the
  // fold line so ← can close them again. Expanded (ctrl+r) shows everything.
  const visible = useMemo(() => {
    const pendingKeys = new Set(pendingTools.map((t) => t.key))
    const base = pendingKeys.size ? items.filter((i) => !pendingKeys.has(i.key)) : items
    if (expanded) return items
    const folded = collapseToolRuns(base)
    if (openedKeys.size === 0) return folded
    const out: TranscriptItem[] = []
    for (const item of folded) {
      out.push(item)
      if (item.key.startsWith('grp:') && openedKeys.has(item.key)) {
        out.push(...foldRun(item.key, base))
      }
    }
    return out
  }, [items, expanded, pendingTools, openedKeys])

  // Everything ↑/↓ can highlight, top to bottom: the sandbox startup block
  // (when it renders), then the transcript lines. Navigation tracks keys, not
  // indices, so streamed appends don't shift the highlight. Each entry also
  // carries an estimated on-screen height (rows), which drives the viewport:
  // only the slice that fits the window renders, scrolled by wheel/trackpad
  // and snapped to the highlight.
  const infraActivity = statusActivityText(statusWord)
  const entries = useMemo(() => {
    const width = Math.max(20, termCols - 3)
    const keys: string[] = []
    const heights: number[] = []
    const byKey = new Map<string, TranscriptItem>()
    if (infraActivity || sandbox) {
      keys.push('sandbox')
      heights.push(
        sandboxBlockRows(sandbox, sandboxOpen, stepLogsOpen, stepCursor, infraActivity != null),
      )
    }
    for (const item of visible) {
      keys.push(item.key)
      byKey.set(item.key, item)
      heights.push(
        estimateItemRows(item, width, !expanded && !openedKeys.has(item.key)),
      )
    }
    return { keys, heights, byKey }
  }, [
    infraActivity,
    sandbox,
    visible,
    sandboxOpen,
    stepLogsOpen,
    stepCursor,
    expanded,
    openedKeys,
    termCols,
  ])
  // Everything ↑/↓ can actually land on: the entry list minus turn summaries
  // ("turn complete · 3s · $0.03"), which are informational trailers, not
  // content — the selection walk skips them (they still render and scroll).
  const navKeys = useMemo(
    () =>
      entries.keys.filter(
        (k) => k === 'sandbox' || entries.byKey.get(k)?.kind !== 'summary',
      ),
    [entries],
  )

  // Rows available to the transcript viewport: the window minus the shell
  // row, top padding, the footer (composer + meta + queued + notice), the
  // live-activity reserve while the agent works, and the two possible
  // "… N above/below" indicator rows. Heights are estimates, so this leans
  // conservative rather than overflow the window into scrollback.
  const viewBudget = useMemo(() => {
    const width = Math.max(20, termCols - 3)
    const composerRows = inputActive ? 3 + composer.text.split('\n').length : 0
    const liveReserve = working
      ? 2 + (snapshot.liveText ? Math.ceil(snapshot.liveText.length / width) + 1 : 0)
      : 0
    // The in-flight sends render inside the transcript area (below the
    // slice), so their rows come out of the viewport budget: spacer +
    // wrapped lines each.
    const queuedReserve = inFlightSends.reduce(
      (acc, q) =>
        acc +
        1 +
        q.text.split('\n').reduce((a, l) => a + Math.max(1, Math.ceil(l.length / width)), 0),
      0,
    )
    const footerRows = 1 + (notice ? 1 : 0) + composerRows + 1 /* footer margin */
    return Math.max(3, termRows - 1 - TOP_PAD - footerRows - liveReserve - queuedReserve - 2)
  }, [
    termRows,
    termCols,
    inputActive,
    composer.text,
    working,
    snapshot.liveText,
    notice,
    inFlightSends,
  ])

  // The viewport slice for a given scroll anchor (pure math in viewportSlice;
  // a stale/missing scroll key falls back to following the bottom).
  const sliceFor = useCallback(
    (anchorKey: string | null): { start: number; end: number } => {
      if (anchorKey !== null) {
        const idx = entries.keys.indexOf(anchorKey)
        if (idx >= 0) return viewportSlice(entries.heights, viewBudget, { type: 'top', index: idx })
      }
      return viewportSlice(entries.heights, viewBudget, { type: 'bottom' })
    },
    [entries, viewBudget],
  )

  // Wheel/trackpad scroll by whole entries; scrolling down to the newest
  // entry re-pins the viewport to the bottom so new content follows again.
  const wheelScroll = useCallback(
    (delta: number): void => {
      const cur = sliceFor(scrollKey)
      const newStart = Math.max(0, Math.min(cur.start + delta, entries.keys.length - 1))
      const next = viewportSlice(entries.heights, viewBudget, { type: 'top', index: newStart })
      setScrollKey(next.end >= entries.keys.length ? null : entries.keys[next.start])
    },
    [sliceFor, scrollKey, entries, viewBudget],
  )

  // Snap the viewport so the given entry is in frame: above the window it
  // becomes the top edge, below it becomes the bottom edge (bottom-pinned
  // when it's the newest entry). Keyed, because navigation walks navKeys
  // (which skips unselectable entries) while the viewport slices entries.
  const ensureVisible = useCallback(
    (key: string): void => {
      const idx = entries.keys.indexOf(key)
      if (idx < 0) return
      const cur = sliceFor(scrollKey)
      if (idx < cur.start) {
        setScrollKey(entries.keys[idx])
      } else if (idx >= cur.end) {
        if (idx >= entries.keys.length - 1) setScrollKey(null)
        else {
          const snapped = viewportSlice(entries.heights, viewBudget, { type: 'end', index: idx })
          setScrollKey(entries.keys[snapped.start])
        }
      }
    },
    [sliceFor, scrollKey, entries, viewBudget],
  )

  const insertAtCursor = useCallback((ch: string): void => {
    setComposer(({ text, cursor }) => ({
      text: text.slice(0, cursor) + ch + text.slice(cursor),
      cursor: cursor + ch.length,
    }))
  }, [])

  useInput(
    (ch, key) => {
      // SGR mouse reports (enabled above) arrive as escape sequences that
      // ink's key parser passes through as plain text — catch them before
      // they reach any text handling. Wheel up/down (buttons 64/65) scroll
      // the viewport; everything else (clicks, drags) is swallowed.
      if (ch && MOUSE_SEQ_RE.test(ch)) {
        let delta = 0
        for (const m of ch.matchAll(/\[<(\d+);\d+;\d+[Mm]/g)) {
          if (m[1] === '64') delta -= 1
          else if (m[1] === '65') delta += 1
        }
        if (delta !== 0) wheelScroll(delta)
        return
      }
      if (key.escape) {
        // Modal-first: an open sandbox panel closes, then transcript
        // navigation drops back to the composer, before esc means "stop".
        if (sandboxOpen) {
          setSandboxOpen(false)
          setStepLogsOpen(false)
          return
        }
        if (navKey !== null) {
          setNavKey(null)
          setScrollKey(null)
          return
        }
        if (working) submit('/stop')
        return
      }
      if (key.ctrl && ch === 'r') {
        setExpanded((v) => !v)
        return
      }
      // ctrl+s releases/re-arms the mouse capture: released, the terminal
      // gets the mouse back for normal select/copy; armed, wheel/trackpad
      // scrolls the transcript. (The sandbox step list is opened by
      // highlighting the startup block with ↑ and pressing →.)
      if (key.ctrl && ch === 's') {
        const next = !mouseCapture
        setMouseCapture(next)
        setNotice(
          next
            ? 'mouse scrolling restored'
            : 'mouse released for select/copy · ctrl+s to restore scrolling',
        )
        return
      }
      if (sandboxOpen) {
        if (key.upArrow) {
          setStepCursor((c) => Math.max(0, c - 1))
          return
        }
        if (key.downArrow) {
          setStepCursor((c) => Math.min(Math.max(0, (sandbox?.steps.length ?? 0) - 1), c + 1))
          return
        }
        if (key.rightArrow) {
          setStepLogsOpen(true)
          return
        }
        if (key.leftArrow) {
          // ← with logs open hides them; with logs hidden it backs out of
          // the panel (to the nav highlight if that's how it was opened).
          if (stepLogsOpen) setStepLogsOpen(false)
          else setSandboxOpen(false)
          return
        }
      } else if (navKey !== null) {
        // Transcript navigation: ↑/↓ walk the lines (snapping the viewport
        // so the highlight stays in frame), →/enter opens the highlighted
        // one, ← closes it, typing drops back to the composer.
        const idx = navKeys.indexOf(navKey)
        if (key.upArrow) {
          const target = idx === -1 ? navKeys.length - 1 : Math.max(0, idx - 1)
          if (navKeys.length > 0) {
            setNavKey(navKeys[target])
            ensureVisible(navKeys[target])
          }
          return
        }
        if (key.downArrow) {
          if (idx === -1 || idx >= navKeys.length - 1) {
            setNavKey(null)
            setScrollKey(null)
          } else {
            setNavKey(navKeys[idx + 1])
            ensureVisible(navKeys[idx + 1])
          }
          return
        }
        if (key.rightArrow || key.return) {
          if (navKey === 'sandbox') {
            setSandboxOpen(true)
            setStepLogsOpen(false)
            setStepCursor(Math.max(0, (sandbox?.steps.length ?? 0) - 1))
          } else {
            const item = visible.find((i) => i.key === navKey)
            if (item && (navKey.startsWith('grp:') || isCollapsible(item))) {
              setOpenedKeys((prev) => new Set(prev).add(navKey))
            }
          }
          return
        }
        if (key.leftArrow) {
          if (openedKeys.has(navKey)) {
            setOpenedKeys((prev) => {
              const next = new Set(prev)
              next.delete(navKey)
              return next
            })
          }
          return
        }
        if (ch && !key.ctrl && !key.meta) {
          setNavKey(null)
          setScrollKey(null)
          insertAtCursor(ch)
        }
        return
      }
      if (key.return) {
        submit(composer.text)
        return
      }
      if (key.upArrow) {
        // Up inside a multi-line input climbs a line; up on line 1 moves
        // focus into the transcript, landing on the newest line.
        const up = cursorLineUp(composer.text, composer.cursor)
        if (up !== null) setComposer((c) => ({ ...c, cursor: up }))
        else if (navKeys.length > 0) {
          setNavKey(navKeys[navKeys.length - 1])
          setScrollKey(null)
        }
        return
      }
      if (key.downArrow) {
        const down = cursorLineDown(composer.text, composer.cursor)
        if (down !== null) setComposer((c) => ({ ...c, cursor: down }))
        return
      }
      if (key.leftArrow) {
        setComposer((c) => ({ ...c, cursor: Math.max(0, c.cursor - 1) }))
        return
      }
      if (key.rightArrow) {
        setComposer((c) => ({ ...c, cursor: Math.min(c.text.length, c.cursor + 1) }))
        return
      }
      if (key.backspace || key.delete) {
        setComposer(({ text, cursor }) =>
          cursor > 0
            ? { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 }
            : { text, cursor },
        )
        return
      }
      if (key.ctrl || key.meta) return
      if (ch) insertAtCursor(ch)
    },
    { isActive: inputActive },
  )

  // Render the transcript from state (not <Static>) so ctrl+r can re-expand
  // committed blocks. Collapsed (the default), runs of consecutive tool
  // activity fold into one "Ran N shell commands" line, Claude-Code-app-style;
  // ctrl+r restores the full ● call / ⎿ result blocks (and un-clamps long
  // bodies). In-flight calls are excluded from the collapsed fold — they render
  // as the live "Running …" line appended right below (see runningTool), so the
  // fold only counts what actually ran. The pieces are memoized on
  // [items, expanded] (pendingTools derives from items), so the elapsed-second
  // ticks reuse the same elements and don't re-lay-out the transcript.
  // The viewport slice actually rendered this frame; atBottom means the
  // newest entry is in frame (live activity lines render only then).
  const slice = useMemo(() => sliceFor(scrollKey), [sliceFor, scrollKey])
  const atBottom = slice.end >= entries.keys.length
  // Whether the live "Running …" line should hug the block above it: in
  // expanded mode the pending ● call itself is the last line; collapsed,
  // when the trailing fold ("Ran N …", key grp:*) — or an opened fold's
  // trailing tool line — is the same burst the pending call belongs to.
  // Otherwise the line opens its own block.
  const lastVisible = visible[visible.length - 1]
  const runningHug = expanded
    ? pendingTools.length > 0
    : lastVisible != null &&
      (lastVisible.key.startsWith('grp:') ||
        lastVisible.kind === 'tool' ||
        lastVisible.kind === 'tool_result')

  // The persistent footer status line: the current status, the running spend
  // (cumulative total + the last turn's cost), and the session identity — the
  // dashboard link rendered as the session id, the agent config (when the
  // session has one), the model, and the CLI version. Command hints live in
  // --help. The total prefers the server's ledger figure (live via the
  // session frames' cost columns, climbing mid-turn); the CC-derived result
  // total is the fallback against older backends.
  const totalStr = `$${(serverCostUsd ?? cost.total ?? 0).toFixed(2)}`
  const lastStepStr = cost.lastStep != null ? ` (Last step: $${cost.lastStep.toFixed(2)})` : ''
  const metaLine = [
    `${statusWord} · ${totalStr} total${lastStepStr}`,
    hyperlink(props.sessionUrl, sessionId),
    ...(props.configName ? [`config: ${props.configName}`] : []),
    ...(props.model ? [props.model] : []),
    `v${VERSION}`,
  ].join(' · ')
  // Three distinct, factual activity signals — never whimsy. All render IN the
  // transcript, on the block they describe, not above the composer:
  // - `infraActivity`: the sandbox is spawning/waking (scheduled/starting/
  //   retrying). Shown at the TOP, under the banner, where a startup message
  //   belongs — there's no conversation yet.
  // - `generating`: the model is streaming tokens (delta frames flowing) —
  //   the ✻ line under the streamed prose, with elapsed + token count.
  // - `runningTool`: a committed tool call awaits its result — a ✻ line
  //   attached to the tool burst it belongs to ("Ran 2 shell commands" then
  //   the live third), naming the tool and ticking its own timer (generating
  //   wins if both somehow read true; the model can't stream past an
  //   unresolved call).
  const liveText = snapshot.liveText
  const liveTokens = snapshot.liveOutputTokens
  const generating = statusWord === 'working' && (liveText !== '' || liveTokens != null)
  const generatingBits = [
    formatDuration(elapsed),
    ...(liveTokens != null ? [`↓ ${formatTokens(liveTokens)} tokens`] : []),
    ...(inputActive ? ['esc to interrupt'] : []),
  ].join(' · ')
  const runningTool = statusWord === 'working' && !generating && pendingTools.length > 0
  const runningToolLabel =
    pendingTools.length === 1
      ? `Running ${pendingTools[0].text}${pendingTools[0].detail ?? ''}`
      : `Running ${pendingTools.length} tool calls (${[...new Set(pendingTools.map((t) => t.text))].join(', ')})`
  const runningToolBits = [
    formatDuration(toolElapsed),
    ...(inputActive ? ['esc to interrupt'] : []),
  ].join(' · ')

  return (
    <Box flexDirection="column" minHeight={Math.max(0, termRows - 1)}>
      {/* Top padding — see the termRows comment: absorbs terminal row-
          accounting quirks and the post-exit sign-off so the first content
          line never scrolls out of the window. */}
      <Box height={TOP_PAD} flexShrink={0} />
      {/* No banner: session identity (dashboard link, model, version) lives in
          the footer meta line, so the transcript starts right under the top
          padding and nothing is printed to scrollback before the app. */}
      {/* The startup story, session-first, at most three levels deep:
              ✻ Session starting…
                ✻ Sandbox starting…
                  ✓ Preparing image · incremental build · 3.4s
                  ✻ Running setup…
          While in progress the whole hierarchy shows, the live level ticking.
          Once ready it COLLAPSES to the single "✓ Session ready!" line —
          highlighting it (↑ from the composer) and pressing → drills back
          into the hierarchy, →/← on a phase shows/hides its logs. It is the
          viewport's first entry, so it scrolls out of frame like any line. */}
      {(infraActivity || sandbox) && entries.keys[0] === 'sandbox' && slice.start === 0 && (
        <Box flexDirection="column">
          {/* Level 1: the session headline. The › replaces the mark while
              highlighted (same 1-char slot), so the header never shifts. */}
          <Text>
            {navKey === 'sandbox' ? (
              <Text color="cyan">›</Text>
            ) : sandbox?.done && !infraActivity ? (
              <Text color="green">✓</Text>
            ) : (
              <Text color="cyan">✻</Text>
            )}{' '}
            <Text color={navKey === 'sandbox' ? 'cyan' : undefined} dimColor={navKey !== 'sandbox'}>
              {/* A live status word overrides a stale done-headline: on a
                  wake the status flips before the new session_starting
                  record lands, and "Session ready!" must not linger. */}
              {sandbox?.done && !infraActivity
                ? sandbox.headline
                : `${(!sandbox || sandbox.done ? (infraActivity ?? 'Session starting') : sandbox.headline).replace(/…$/, '')}… (${formatDuration(elapsed)})`}
              {inputActive && navKey === 'sandbox' && !sandboxOpen && sandbox?.sandboxLine
                ? ' (→: details)'
                : ''}
            </Text>
          </Text>
          {/* Levels 2+3: the config line, the sandbox line and its phases —
              always visible while starting, behind → once the session is
              ready. */}
          {sandbox &&
            (sandbox.configName || sandbox.sandboxLine) &&
            (!sandbox.done || sandboxOpen || infraActivity) && (
            <Box flexDirection="column">
              {sandbox.configName && (
                <Text>
                  {'  '}
                  <Text color="green">✓</Text>{' '}
                  <Text dimColor>
                    Using {sandbox.configName}
                    {sandbox.configCommitSha
                      ? ` @ ${sandbox.configCommitSha.slice(0, 7)}`
                      : ''}
                  </Text>
                </Text>
              )}
              {sandbox.sandboxLine && (
              <Text>
                {'  '}
                {sandbox.sandboxDone ? (
                  <Text color="green">✓</Text>
                ) : (
                  <Text color="cyan">✻</Text>
                )}{' '}
                <Text dimColor>{oneLine(sandbox.sandboxLine, 110)}</Text>
              </Text>
              )}
              {sandbox.steps.map((step, i) => {
                const running = step.status === 'running' && !sandbox.sandboxDone
                const cursor = Math.min(stepCursor, sandbox.steps.length - 1)
                const selected = sandboxOpen && i === cursor
                const logLines = running
                  ? step.lines.slice(-RUNNING_TAIL_LINES)
                  : step.lines.slice(-FINISHED_LOG_LINES)
                const hidden = step.lines.length - logLines.length
                const mark =
                  step.status === 'failed' ? (
                    <Text color="red">✗</Text>
                  ) : running ? (
                    <Text color="cyan">✻</Text>
                  ) : (
                    <Text color="green">✓</Text>
                  )
                return (
                  <Box key={step.key} flexDirection="column">
                    {/* The › cursor column is always reserved (a space when
                        unselected), so opening the panel never shifts the
                        rows; the selected phase reads cyan like the
                        transcript highlight. */}
                    <Text>
                      {'    '}
                      <Text color="cyan">{selected ? '›' : ' '}</Text> {mark}{' '}
                      <Text
                        color={selected ? 'cyan' : step.status === 'failed' ? 'red' : undefined}
                        dimColor={!selected && step.status !== 'failed'}
                      >
                        {oneLine(sandboxStepLine(step), 108)}
                      </Text>
                      {sandboxOpen && step.lines.length > 0 && (
                        <Text color={selected ? 'cyan' : undefined} dimColor={!selected}>
                          {' '}
                          ({step.lines.length} log line{step.lines.length === 1 ? '' : 's'})
                        </Text>
                      )}
                    </Text>
                    {(selected && stepLogsOpen ? logLines : []).map((l, j) => (
                      <Text key={`${step.key}:${j}`} dimColor>
                        {'        '}
                        {j === 0 && hidden > 0 ? `… +${hidden} earlier · ` : ''}
                        {oneLine(l, 100)}
                      </Text>
                    ))}
                  </Box>
                )
              })}
              {sandboxOpen && (
                <Text dimColor>{'    '}↑/↓ phase · → logs · ← back · esc close</Text>
              )}
            </Box>
          )}
        </Box>
      )}
      {/* The transcript viewport grows through the middle of the terminal,
          pinning the composer + meta to the bottom edge (flexGrow fills the
          slack). Only the slice that fits the window renders; dim markers
          show what's out of frame above/below. */}
      <Box flexDirection="column" flexGrow={1}>
        {slice.start > 0 && (
          <Text dimColor>… {slice.start} earlier (scroll or ↑)</Text>
        )}
        {entries.keys.slice(slice.start, slice.end).map((k) => {
          if (k === 'sandbox') return null
          const item = entries.byKey.get(k)
          if (!item) return null
          return (
            <TranscriptLine
              key={k}
              item={item}
              expanded={expanded}
              opened={openedKeys.has(k)}
              selected={navKey === k}
            />
          )
        })}
        {!atBottom && (
          <Text dimColor>… {entries.keys.length - slice.end} newer (scroll or ↓)</Text>
        )}
        {/* The live tool-call status, attached to the burst it belongs to: hugs
            the collapsed "Ran N …" fold (or the expanded ● call) above it, and
            disappears into the fold's count once the result lands. Live lines
            only render while the viewport follows the bottom. */}
        {atBottom && runningTool && (
          <Box marginTop={runningHug ? 0 : 1}>
            <Text>
              <Text color="cyan">✻</Text>{' '}
              <Text dimColor>
                {runningToolLabel}… ({runningToolBits})
              </Text>
            </Text>
          </Box>
        )}
        {/* The in-progress assistant response, streamed token-by-token from delta
            frames, with its live status hugging beneath; replaced by the
            committed step when it lands. */}
        {/* Indented to the same 2-column gutter as the committed assistant
            item it becomes, so the text doesn't jump when it lands. */}
        {atBottom && liveText && (
          <Box marginTop={1}>
            <Box width={2} flexShrink={0} />
            <Text>{liveText}</Text>
          </Box>
        )}
        {atBottom && generating && (
          <Box marginTop={liveText ? 0 : 1}>
            <Text>
              <Text color="cyan">✻</Text>{' '}
              <Text dimColor>Generating… ({generatingBits})</Text>
            </Text>
          </Box>
        )}
        {/* Your in-flight sends, at the chat's bottom edge the moment you hit
            enter: dim ◆ rows stamped (sending…) while the POST is in flight,
            (queued) once the server accepts, then FULL COLOUR the moment the
            agent takes the message — it holds that spot through the echo gap
            (which spans a whole sandbox wake) until the agent's own user-echo
            transcript item replaces it. */}
        {atBottom &&
          inFlightSends.map((q) => (
            <Box key={q.key} marginTop={1}>
              <Box width={2} flexShrink={0}>
                <Text color="cyan" dimColor={q.state !== 'accepted'}>
                  ◆
                </Text>
              </Box>
              <Text bold={q.state === 'accepted'} dimColor={q.state !== 'accepted'}>
                {q.text}
                {q.state === 'sending' ? ' (sending…)' : q.state === 'queued' ? ' (queued)' : ''}
              </Text>
            </Box>
          ))}
        {/* The fallback live line: the session is working but nothing else
            says so — no tokens streaming, no tool pending, no infra startup
            block ticking. This is the harness-boot dead air (a fresh
            execution takes ~15-20s to start Claude Code before its first
            event) and the between-records lull; without it a send looks
            like the app hung. */}
        {atBottom && working && !generating && !runningTool && !infraActivity && (
          <Box marginTop={1}>
            <Text>
              <Text color="cyan">✻</Text>{' '}
              <Text dimColor>
                {awaitingAgent === 'boot' ? 'Starting the agent' : 'Working'}… (
                {formatDuration(elapsed)}
                {inputActive ? ' · esc to interrupt' : ''})
              </Text>
            </Text>
          </Box>
        )}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {notice && <Text dimColor>· {notice}</Text>}
        {/* The composer, framed by a full-width rule above and below (Claude
            Code-style): the › prompt sits between the two lines. Only the top and
            bottom borders are drawn, so the rules span the terminal width. */}
        {inputActive && (
          <Box borderStyle="single" borderLeft={false} borderRight={false} borderDimColor>
            {/* One parent Text so a multi-line input flows as a single block
                (sibling Texts in a row Box would render as columns). The
                caret is the inverse cell at the cursor, hidden while the
                transcript has focus (navKey). A caret sitting on a newline
                renders as an inverse space at that line's end. The key
                remounts the node on every content change: ink reuses the
                previous measurement when nested text mutates in place, and
                the stale (narrower) width wraps the caret onto the border
                row below. */}
            <Text key={`${composer.text}:${composer.cursor}:${navKey === null}`}>
              <Text color="cyan">› </Text>
              {composer.text.slice(0, composer.cursor)}
              {navKey === null && (
                <Text inverse>
                  {composer.cursor < composer.text.length &&
                  composer.text[composer.cursor] !== '\n'
                    ? composer.text[composer.cursor]
                    : ' '}
                </Text>
              )}
              {composer.cursor < composer.text.length
                ? navKey === null && composer.text[composer.cursor] !== '\n'
                  ? composer.text.slice(composer.cursor + 1)
                  : composer.text.slice(composer.cursor)
                : ''}
            </Text>
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

// Where the caret lands after ↑ in the composer: the same column on the
// previous line (clamped to that line's length, text-editor style), or null
// when the caret is already on the first line — the signal to move focus up
// into the transcript. Pure, for tests.
export function cursorLineUp(text: string, cursor: number): number | null {
  const lineStart = cursor > 0 ? text.lastIndexOf('\n', cursor - 1) + 1 : 0
  if (lineStart === 0) return null
  const col = cursor - lineStart
  const prevStart = lineStart >= 2 ? text.lastIndexOf('\n', lineStart - 2) + 1 : 0
  const prevLen = lineStart - 1 - prevStart
  return prevStart + Math.min(col, prevLen)
}

// Where the caret lands after ↓: the same column on the next line (clamped),
// or null when already on the last line. Pure, for tests.
export function cursorLineDown(text: string, cursor: number): number | null {
  const nextNewline = text.indexOf('\n', cursor)
  if (nextNewline < 0) return null
  const lineStart = cursor > 0 ? text.lastIndexOf('\n', cursor - 1) + 1 : 0
  const col = cursor - lineStart
  const nextStart = nextNewline + 1
  const nextEnd = text.indexOf('\n', nextStart)
  const nextLen = (nextEnd < 0 ? text.length : nextEnd) - nextStart
  return nextStart + Math.min(col, nextLen)
}

// One or more SGR mouse reports (\x1b[<button;x;yM), and nothing else — ink's
// key parser doesn't recognise them and would pass them through as text (the
// leading escape of the first report is already stripped by ink).
const MOUSE_SEQ_RE = /^(?:\u001B?\[<\d+;\d+;\d+[Mm])+$/

// The viewport slice over a list of entry heights: which contiguous run of
// entries fits in `budget` rows, anchored to the bottom (follow newest), to
// a top entry (scrolled), or with an entry pinned to the bottom edge (the
// ↓-snap when the highlight walks below the frame). Always includes at least
// the anchor entry, even when it alone overflows the budget. Pure, for tests.
export function viewportSlice(
  heights: readonly number[],
  budget: number,
  anchor: { type: 'bottom' } | { type: 'top'; index: number } | { type: 'end'; index: number },
): { start: number; end: number } {
  const n = heights.length
  if (n === 0) return { start: 0, end: 0 }
  if (anchor.type === 'top') {
    const start = Math.max(0, Math.min(anchor.index, n - 1))
    let used = 0
    let end = start
    while (end < n) {
      if (used + heights[end] > budget && end > start) break
      used += heights[end]
      end++
    }
    return { start, end }
  }
  const endIdx = anchor.type === 'bottom' ? n - 1 : Math.max(0, Math.min(anchor.index, n - 1))
  let used = 0
  let start = endIdx + 1
  while (start > 0) {
    if (used + heights[start - 1] > budget && start <= endIdx) break
    used += heights[start - 1]
    start--
  }
  return { start, end: endIdx + 1 }
}

// Estimated rows a transcript item occupies on screen: its (possibly
// clamped) body lines, wrapped at the given width, plus the "+N lines"
// marker and the blank spacer row. An estimate is enough — the viewport
// budget leans conservative. Pure, for tests.
export function estimateItemRows(item: TranscriptItem, width: number, clamp: boolean): number {
  const clamped =
    clamp && isCollapsible(item)
      ? clampLines(item.text, COLLAPSE_LINES)
      : { body: item.text, more: 0 }
  let rows = (item.spaceBefore ? 1 : 0) + (clamped.more > 0 ? 1 : 0)
  for (const line of clamped.body.split('\n')) {
    rows += Math.max(1, Math.ceil(line.length / width))
  }
  return rows
}

// Estimated rows of the startup block in its current shape: the headline,
// plus — while starting or drilled into — the config line, the sandbox line,
// one row per phase, the selected phase's open log lines, and the key hint.
function sandboxBlockRows(
  sandbox: SandboxState | null,
  open: boolean,
  logsOpen: boolean,
  stepCursor: number,
  infraActive: boolean,
): number {
  let rows = 1 // the headline
  const expanded =
    sandbox != null &&
    (sandbox.configName != null || sandbox.sandboxLine != null) &&
    (!sandbox.done || open || infraActive)
  if (!expanded) return rows
  if (sandbox.configName != null) rows += 1
  const steps = sandbox.steps
  if (sandbox.sandboxLine != null) rows += 1 + steps.length
  if (open) rows += 1 // the key hint
  if (open && logsOpen && steps.length > 0) {
    const i = Math.min(stepCursor, steps.length - 1)
    const step = steps[i]
    const running = step.status === 'running' && !sandbox.sandboxDone
    rows += Math.min(step.lines.length, running ? RUNNING_TAIL_LINES : FINISHED_LOG_LINES)
  }
  return rows
}

// The run of tool/tool_result items a collapsed fold stands for. A fold's key
// is grp:<first item's key> (see the SDK's collapseToolRuns), so the run is
// the consecutive tool activity starting at that item in the unfolded list.
// Pure, for tests.
export function foldRun(foldKey: string, items: readonly TranscriptItem[]): TranscriptItem[] {
  const firstKey = foldKey.slice('grp:'.length)
  const start = items.findIndex((i) => i.key === firstKey)
  if (start < 0) return []
  const run: TranscriptItem[] = []
  for (let i = start; i < items.length; i++) {
    const item = items[i]
    if (item.kind !== 'tool' && item.kind !== 'tool_result') break
    run.push(item)
  }
  return run
}

// A sandbox_output step identifier — payload.step ?? payload.phase — as a
// human startup-phase label. Steps are null/'post_start'/'post_clone' and
// phases 'setup'/'clone'/'hooks'; 'image.setup' is the legacy image step.
// Unknown values pass through verbatim (§3.6).
export function hookPhrase(step: string): string {
  switch (step) {
    case 'setup':
    case 'image.setup':
      return 'Building image'
    case 'clone':
      return 'Fetching repositories'
    case 'post_start':
      return 'Post-start setup'
    case 'post_clone':
      return 'Post-clone setup'
    default:
      return step
  }
}

// A running step's live log tail height, and how much of a finished step's
// log the panel shows before eliding the head with a "+N earlier lines" row.
const RUNNING_TAIL_LINES = 5
const FINISHED_LOG_LINES = 100

export type SandboxStepStatus = 'running' | 'done' | 'failed'
export type SandboxStep = {
  key: string
  label: string
  status: SandboxStepStatus
  // "cached image · 1.2s" — the completed/failed transition's cache-tier
  // detail and duration, for the step's closing summary.
  note: string | null
  lines: string[]
  // Created from output chunks alone (a feed recorded before sandbox_phase
  // transitions existed) — such steps close on the next step, not on a
  // transition.
  inferred: boolean
}
// The startup story as a THREE-LEVEL hierarchy, session-first: the headline
// is the SESSION's state ("Session scheduled…" → "Session starting…" →
// "Session ready!"), the sandbox is one child line under it, and the
// provisioning phases are children of the sandbox. `done` collapses the
// whole block to the single ✓ headline (drill back in with →).
export type SandboxState = {
  // The current top-level line ("Session scheduled…", "Session starting…",
  // "Waking the session…", "Retrying…", "Session ready!").
  headline: string
  done: boolean
  // The agent config resolved at scheduling, shown as its own child line
  // under the headline (NOT in the headline, which the next lifecycle
  // record replaces — a config baked in there flashes and vanishes).
  configName: string | null
  // The commit of the config file in the repo it's owned at (the sync
  // provenance), when the backend sends it. Shortened for display.
  configCommitSha: string | null
  // Level 2: the sandbox child line ("Sandbox starting…" or the
  // "Sandbox ready · cached image · 29s" summary), null before provisioning.
  sandboxLine: string | null
  sandboxDone: boolean
  // Level 3: the provisioning phases under the sandbox line.
  steps: SandboxStep[]
}

// The structural slice of a session record the derivations need (the SDK's
// SessionRecordWire is not exported from its store entry).
type LifecycleRecordLike = {
  feed_seq: number
  source: string
  record_type: string
  payload: Record<string, unknown>
  // The inbox message a user-echo transcript record answers for (§3.3).
  session_message_id?: string | null
}

// Whether a turn has started that the agent process hasn't spoken for yet (a
// turn_started record with no claude_code record after it), and which silence
// it is: 'boot' when the harness has emitted NOTHING this execution — Claude
// Code is still starting up in the sandbox, the ~15-20s dead air after a send
// lands a fresh execution's first turn — vs 'turn', the warm agent working
// between records. null when no turn is awaiting the agent. Drives the
// fallback live line so a send never looks like the app hung. Pure, for tests.
export function awaitingAgentPhase(
  records: readonly LifecycleRecordLike[],
): 'boot' | 'turn' | null {
  let pending = false
  let sawAgent = false
  for (const r of records) {
    if (r.source === 'claude_code') {
      pending = false
      sawAgent = true
    } else if (r.source === 'lifecycle') {
      if (r.record_type === 'turn_started') pending = true
      else if (
        r.record_type === 'session_starting' ||
        r.record_type === 'session_retrying'
      ) {
        // A fresh execution: the harness must boot again before it speaks.
        pending = false
        sawAgent = false
      }
    }
  }
  if (!pending) return null
  return sawAgent ? 'turn' : 'boot'
}

// Sends the agent has TAKEN but not yet echoed into the transcript: each
// message_received body, walked through delivered/requeued transitions, minus
// the ids whose user-echo record (session_message_id back-reference) has
// landed. The store's pending set drops a message the instant it's delivered,
// but the agent's echo record can lag by a whole sandbox wake — without this
// bridge a send flashes and vanishes for the gap. Rendered as full-colour
// user rows at the transcript's bottom edge (the mid-turn send is part of the
// running turn, Claude Code-style). Pure, for tests.
export function deliveredUnechoedSends(
  records: readonly LifecycleRecordLike[],
): { id: string; body: string }[] {
  const received = new Map<string, string>()
  const delivered = new Set<string>()
  const echoed = new Set<string>()
  for (const r of records) {
    if (r.session_message_id != null) echoed.add(r.session_message_id)
    if (r.source !== 'lifecycle') continue
    const id = typeof r.payload.message_id === 'string' ? r.payload.message_id : null
    if (!id) continue
    if (r.record_type === 'message_received') {
      if (!received.has(id))
        received.set(id, typeof r.payload.body === 'string' ? r.payload.body : '')
    } else if (r.record_type === 'message_delivered') delivered.add(id)
    else if (r.record_type === 'message_requeued') delivered.delete(id)
  }
  const out: { id: string; body: string }[] = []
  for (const [id, body] of received) {
    if (delivered.has(id) && !echoed.has(id)) out.push({ id, body })
  }
  return out
}

function msLabel(ms: unknown): string | null {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return null
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

// Human label for a timeline step: hooks sub-items keep their hook phrasing,
// other sub-items (a clone's "owner/repo") read as themselves, whole phases
// go through the SDK's open-vocabulary phase labels.
function stepLabel(phase: string, step: string | null): string {
  if (step) return phase === 'hooks' ? hookPhrase(step) : step
  return sandboxPhaseLabel(phase)
}

// The startup story from the lifecycle records of the LATEST start, as the
// session-first hierarchy: the headline tracks the session-subject records
// ("Session scheduled…" → "Session starting…"/"Waking…"/"Retrying…" →
// "Session ready!" when the sandbox comes up), the sandbox is one child line,
// and the provisioning phases are its children — opened by their
// sandbox_phase `started` transition, closed (with cache-tier/duration note)
// by `completed`/`failed` — with sandbox_output chunks attaching their lines
// to the matching step (exact phase:step, then the bare phase, then an
// inferred step for feeds that predate phase transitions). session_starting
// begins a fresh story (a wake or infra retry drops the previous one).
// null when no lifecycle record has been seen. Pure, for tests.
export function deriveSandboxState(
  records: readonly LifecycleRecordLike[],
  minFeedSeq: number,
): SandboxState | null {
  let seen = false
  let headline = 'Session starting…'
  let done = false
  let configName: string | null = null
  let configCommitSha: string | null = null
  let sandboxLine: string | null = null
  let sandboxDone = false
  let steps: SandboxStep[] = []
  for (const record of records) {
    if (record.feed_seq <= minFeedSeq || record.source !== 'lifecycle') continue
    const p = record.payload
    if (record.record_type === 'session_scheduled') {
      seen = true
      headline = 'Session scheduled…'
      configName = typeof p.config_name === 'string' && p.config_name ? p.config_name : null
      configCommitSha =
        typeof p.config_commit_sha === 'string' && p.config_commit_sha
          ? p.config_commit_sha
          : null
      done = false
    } else if (
      record.record_type === 'session_starting' ||
      record.record_type === 'session_retrying'
    ) {
      seen = true
      // Every claim starts a fresh story: the headline takes over ("Session
      // starting…", "Waking the session…", "Retrying…") and the previous
      // start's sandbox children drop.
      headline = lifecycleText(record.record_type, p) ?? 'Session starting…'
      done = false
      sandboxLine = null
      sandboxDone = false
      steps = []
    } else if (record.record_type === 'session_resumed') {
      seen = true
      // The wake mounted its snapshots and the conversation continues — the
      // session-level outcome, same beat as ready on a fresh start.
      headline = 'Session ready!'
      done = true
    } else if (record.record_type === 'session_idle') {
      seen = true
      headline = 'Session idle — your next message wakes it'
      done = true
    } else if (record.record_type === 'sandbox_starting') {
      seen = true
      sandboxLine = 'Sandbox starting…'
      sandboxDone = false
      steps = []
    } else if (record.record_type === 'sandbox_phase') {
      seen = true
      const phase = typeof p.phase === 'string' && p.phase ? p.phase : 'setup'
      const step = typeof p.step === 'string' && p.step ? p.step : null
      const key = step ? `${phase}:${step}` : phase
      let entry = steps.find((s) => s.key === key)
      if (!entry) {
        entry = {
          key,
          label: stepLabel(phase, step),
          status: 'running',
          note: null,
          lines: [],
          inferred: false,
        }
        steps.push(entry)
      }
      entry.inferred = false
      if (p.status === 'completed' || p.status === 'failed') {
        entry.status = p.status === 'completed' ? 'done' : 'failed'
        const detail =
          p.detail && typeof p.detail === 'object'
            ? (p.detail as Record<string, unknown>)
            : {}
        const bits = [cacheTierLabel(detail.cache_tier), msLabel(p.duration_ms)].filter(
          (b): b is string => b != null,
        )
        entry.note = bits.length ? bits.join(' · ') : null
      }
    } else if (record.record_type === 'sandbox_output') {
      seen = true
      const phase = typeof p.phase === 'string' && p.phase ? p.phase : 'setup'
      const step = typeof p.step === 'string' && p.step ? p.step : null
      const outputKey = sandboxOutputStep(p)
      let entry =
        (step ? steps.find((s) => s.key === `${phase}:${step}`) : undefined) ??
        steps.find((s) => s.key === phase) ??
        steps.find((s) => s.key === outputKey)
      if (!entry) {
        // No transition opened a home for this output: an inferred step (old
        // feeds). A new inferred step means the previous inferred one ended.
        for (const s of steps) if (s.inferred && s.status === 'running') s.status = 'done'
        entry = {
          key: outputKey,
          label: hookPhrase(outputKey),
          status: 'running',
          note: null,
          lines: [],
          inferred: true,
        }
        steps.push(entry)
      }
      entry.lines.push(...sandboxOutputLines(p))
    } else if (record.record_type === 'sandbox_ready') {
      seen = true
      for (const s of steps) if (s.status === 'running') s.status = 'done'
      const timings =
        p.phase_timings && typeof p.phase_timings === 'object'
          ? Object.values(p.phase_timings as Record<string, unknown>)
          : []
      const totalSeconds = timings.reduce<number>(
        (acc, v) => (typeof v === 'number' && isFinite(v) ? acc + v : acc),
        0,
      )
      const bits = [
        cacheTierLabel(p.cache_tier),
        totalSeconds > 0 ? formatDuration(Math.round(totalSeconds)) : null,
      ].filter((b): b is string => b != null)
      sandboxLine = ['Sandbox ready', ...bits].join(' · ')
      sandboxDone = true
      // The box coming up is the session-level outcome too: the block
      // collapses to the ✓ headline (drill in with →).
      headline = 'Session ready!'
      done = true
    }
  }
  return seen
    ? { headline, done, configName, configCommitSha, sandboxLine, sandboxDone, steps }
    : null
}

// One timeline step as its collapsed display line: a running step shows its
// label with the latest log line, a finished one its closing note (cache
// tier, duration), a failed one says so. Pure, for tests.
export function sandboxStepLine(step: SandboxStep): string {
  if (step.status === 'running') {
    const last = step.lines[step.lines.length - 1]
    return last ? `${step.label}… · ${last}` : `${step.label}…`
  }
  if (step.status === 'failed') {
    return step.note ? `${step.label} failed · ${step.note}` : `${step.label} failed`
  }
  return step.note ? `${step.label} · ${step.note}` : step.label
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

// The sender icon in the 2-column gutter: ◆ (cyan) marks a message you sent
// (the --prompt initial message included — it's a user message), ⏺ marks the
// assistant's prose. Everything else keeps the SDK's glyph (● tool calls,
// ⎿ results, ✻ thinking) or none. The › selection highlight replaces the
// icon in the same slot, so a selected line always reads differently from
// its resting state. Pure, for tests.
export function gutterFor(item: TranscriptItem): string {
  if (item.kind === 'user') return '◆'
  if (item.kind === 'assistant') return '⏺'
  return item.gutter ?? ''
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
    // User copy stays white like the assistant's (the ◆ icon marks the
    // sender); cyan text always and only means "the selection is here".
    case 'user':
      return { gutterColor: 'cyan', bold: true, dim: false }
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
  opened,
  selected,
}: {
  item: TranscriptItem
  expanded: boolean
  // This line was opened in place with → while highlighted (un-clamps it).
  opened: boolean
  // This line is the transcript-navigation highlight: › gutter, cyan text.
  selected: boolean
}): React.ReactElement {
  const mt = item.spaceBefore ? 1 : 0
  const { gutterColor, textColor, dim, bold } = styleFor(item)

  // Every line (assistant prose included) reserves the same 2-column gutter,
  // so the › highlight fills the slot IN PLACE of whatever glyph lives there
  // and the text never shifts when the selection lands on it.

  // Long tool results and user turns collapse to a compact body with a
  // "+N lines" marker unless ctrl+r has expanded the transcript or → opened
  // this line.
  const clamped =
    !expanded && !opened && isCollapsible(item)
      ? clampLines(item.text, COLLAPSE_LINES)
      : { body: item.text, more: 0 }

  return (
    <Box marginTop={mt}>
      <Box width={2}>
        <Text
          color={selected ? 'cyan' : gutterColor}
          dimColor={!selected && dim && !item.isError}
        >
          {selected ? '›' : gutterFor(item)}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Text color={selected ? 'cyan' : textColor} dimColor={!selected && dim} bold={bold}>
          {clamped.body}
          {item.detail ? (
            <Text color={selected ? 'cyan' : undefined} dimColor={!selected}>
              {item.detail}
            </Text>
          ) : null}
        </Text>
        {clamped.more > 0 && (
          <Text dimColor>
            … +{clamped.more} lines ({selected ? '→' : 'ctrl+r'} to expand)
          </Text>
        )}
      </Box>
    </Box>
  )
})
