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
  clampLines,
  collapseToolRuns,
  foldCosts,
  formatDuration,
  pendingToolCalls,
  recordToItems,
  setupOutputHook,
  setupOutputLine,
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
  // Messages you've sent that the server hasn't acknowledged yet — shown as a
  // queued region below the composer, exactly like Claude Code. From the first
  // acknowledgement on (a messages frame or the user-echo record carrying the
  // id), the server's own pending rows (serverQueued) are the queued truth.
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

  // The sandbox startup story, derived from the lifecycle records of the
  // latest start (a sandbox_starting record resets it, so a wake tells a
  // fresh story): the ordered setup steps with their full log lines, plus
  // whether the box reached ready. Collapsed, it renders as ONE line showing
  // the current phase, rewritten in place ("Building image…" → "Post-clone
  // setup… · <latest output line>" → "Ready!"); highlighting the block (↑
  // from the composer) and pressing → opens the step list, and arrow keys
  // drill into a step's logs (a running step shows a live 5-line tail, a
  // finished one its stored log). The block persists after startup as the
  // durable trace (the sandbox_ready transcript notice is suppressed below
  // in its favour).
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
          store.ingest({ type: 'records_append', records: page.records })
        }
        store.ingest({ type: 'messages', messages: page.messages ?? [] })
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
  const navKeys = entries.keys

  // Rows available to the transcript viewport: the window minus the shell
  // row, top padding, the footer (composer + meta + queued + notice), the
  // live-activity reserve while the agent works, and the two possible
  // "… N above/below" indicator rows. Heights are estimates, so this leans
  // conservative rather than overflow the window into scrollback.
  const viewBudget = useMemo(() => {
    const width = Math.max(20, termCols - 3)
    const composerRows = inputActive ? 3 + composer.text.split('\n').length : 0
    const liveReserve =
      statusWord === 'working'
        ? 2 + (snapshot.liveText ? Math.ceil(snapshot.liveText.length / width) + 1 : 0)
        : 0
    const footerRows =
      1 + (notice ? 1 : 0) + queuedDisplay.length + composerRows + 1 /* footer margin */
    return Math.max(3, termRows - 1 - TOP_PAD - footerRows - liveReserve - 2)
  }, [
    termRows,
    termCols,
    inputActive,
    composer.text,
    statusWord,
    snapshot.liveText,
    notice,
    queuedDisplay.length,
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

  // Snap the viewport so the entry at idx is in frame: above the window it
  // becomes the top edge, below it becomes the bottom edge (bottom-pinned
  // when it's the newest entry).
  const ensureVisible = useCallback(
    (idx: number): void => {
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
            ensureVisible(target)
          }
          return
        }
        if (key.downArrow) {
          if (idx === -1 || idx >= navKeys.length - 1) {
            setNavKey(null)
            setScrollKey(null)
          } else {
            setNavKey(navKeys[idx + 1])
            ensureVisible(idx + 1)
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
      {/* Sandbox spawn/wake progress, at the top where startup belongs: the
          ✻ header (ticking while infra is active) with the current phase on
          one line under it, rewritten in place as phases pass. Highlighting
          the block (↑) and pressing → swaps the line for the full step list;
          →/← on a step shows/hides its logs (a live 5-line tail while the
          step runs). The block stays after
          startup — frozen at "Ready!" — as the durable trace. It is the
          viewport's first entry, so it scrolls out of frame like any line. */}
      {(infraActivity || sandbox) && entries.keys[0] === 'sandbox' && slice.start === 0 && (
        <Box flexDirection="column">
          {/* The › replaces the ✻ while highlighted (same 1-char slot), so
              the header never shifts; the block's text goes cyan with it. */}
          <Text>
            {navKey === 'sandbox' ? (
              <Text color="cyan">›</Text>
            ) : (
              <Text color="cyan">✻</Text>
            )}{' '}
            <Text color={navKey === 'sandbox' ? 'cyan' : undefined} dimColor={navKey !== 'sandbox'}>
              {infraActivity ? `${infraActivity}… (${formatDuration(elapsed)})` : 'Starting sandbox…'}
            </Text>
          </Text>
          {!sandboxOpen && sandboxPhaseLine(sandbox) && (
            <Text>
              {'  '}
              <Text color={navKey === 'sandbox' ? 'cyan' : undefined} dimColor={navKey !== 'sandbox'}>
                ⎿ {oneLine(sandboxPhaseLine(sandbox) as string, 110)}
                {inputActive && navKey === 'sandbox' ? ' (→: steps)' : ''}
              </Text>
            </Text>
          )}
          {sandboxOpen && (
            <Box flexDirection="column">
              {(sandbox?.steps.length ?? 0) === 0 && (
                <Text dimColor>{'    '}no setup output yet</Text>
              )}
              {sandbox?.steps.map((step, i) => {
                const running =
                  !sandbox.ready && infraActivity != null && i === sandbox.steps.length - 1
                const cursor = Math.min(stepCursor, sandbox.steps.length - 1)
                const selected = i === cursor
                const logLines = running
                  ? step.lines.slice(-RUNNING_TAIL_LINES)
                  : step.lines.slice(-FINISHED_LOG_LINES)
                const hidden = step.lines.length - logLines.length
                return (
                  <Box key={step.hook} flexDirection="column">
                    {/* The › cursor column is always reserved (a space when
                        unselected), so selection never shifts the row; the
                        selected step reads cyan like the transcript
                        highlight. */}
                    <Text>
                      {'  '}
                      <Text color="cyan">{selected ? '›' : ' '}</Text>{' '}
                      <Text color={running ? 'cyan' : 'green'}>{running ? '✻' : '✓'}</Text>{' '}
                      <Text color={selected ? 'cyan' : undefined} dimColor={!selected}>
                        {step.label}
                        {running ? '…' : ''}
                      </Text>{' '}
                      <Text color={selected ? 'cyan' : undefined} dimColor={!selected}>
                        ({step.lines.length} log line{step.lines.length === 1 ? '' : 's'})
                      </Text>
                    </Text>
                    {selected && stepLogsOpen && (
                      <Box flexDirection="column" marginLeft={6}>
                        {hidden > 0 && <Text dimColor>… +{hidden} earlier lines</Text>}
                        {logLines.map((l, j) => (
                          <Text key={`${step.hook}:${j}`} dimColor>
                            {oneLine(l, 110)}
                          </Text>
                        ))}
                      </Box>
                    )}
                  </Box>
                )
              })}
              {sandbox?.ready && <Text dimColor>{'    '}Ready!</Text>}
              <Text dimColor>{'    '}↑/↓ step · → logs · ← back · esc close</Text>
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

// Estimated rows of the sandbox startup block in its current shape (header +
// phase line collapsed; header + step list + open logs + hint expanded).
function sandboxBlockRows(
  sandbox: SandboxState | null,
  open: boolean,
  logsOpen: boolean,
  stepCursor: number,
  infraActive: boolean,
): number {
  if (!open) return 1 + (sandboxPhaseLine(sandbox) ? 1 : 0)
  const steps = sandbox?.steps ?? []
  let rows = 1 + Math.max(1, steps.length) + (sandbox?.ready ? 1 : 0) + 1
  if (logsOpen && steps.length > 0) {
    const i = Math.min(stepCursor, steps.length - 1)
    const step = steps[i]
    const running = sandbox != null && !sandbox.ready && infraActive && i === steps.length - 1
    const shown = Math.min(step.lines.length, running ? RUNNING_TAIL_LINES : FINISHED_LOG_LINES)
    rows += shown + (step.lines.length > shown ? 1 : 0)
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

// A setup hook name ("image.setup", "post_clone") as a startup phase.
export function hookPhrase(hook: string): string {
  switch (hook) {
    case 'image.setup':
      return 'Building image'
    case 'post_clone':
      return 'Post-clone setup'
    case 'post_start':
      return 'Post-start setup'
    default:
      return hook
  }
}

// A running step's live log tail height, and how much of a finished step's
// log the panel shows before eliding the head with a "+N earlier lines" row.
const RUNNING_TAIL_LINES = 5
const FINISHED_LOG_LINES = 100

export type SandboxStep = { hook: string; label: string; lines: string[] }
export type SandboxState = { steps: SandboxStep[]; ready: boolean }

// The structural slice of a session record the derivation needs (the SDK's
// SessionRecordWire is not exported from its store entry).
type LifecycleRecordLike = {
  feed_seq: number
  source: string
  record_type: string
  payload: Record<string, unknown>
}

// The sandbox startup story from the lifecycle records of the LATEST start:
// one step per setup hook in first-seen order, each accumulating the log
// lines of its chunked sandbox_setup_output records, plus whether the box
// reached ready. sandbox_starting resets everything (a wake tells a fresh
// story); null when no start has been seen. Pure, for tests.
export function deriveSandboxState(
  records: readonly LifecycleRecordLike[],
  minFeedSeq: number,
): SandboxState | null {
  let seen = false
  let steps: SandboxStep[] = []
  let ready = false
  for (const record of records) {
    if (record.feed_seq <= minFeedSeq || record.source !== 'lifecycle') continue
    if (record.record_type === 'sandbox_starting') {
      seen = true
      steps = []
      ready = false
    } else if (record.record_type === 'sandbox_setup_output') {
      seen = true
      const hook = setupOutputHook(record.payload)
      let step = steps.find((s) => s.hook === hook)
      if (!step) {
        step = { hook, label: hookPhrase(hook), lines: [] }
        steps.push(step)
      }
      const lines = Array.isArray(record.payload.lines)
        ? record.payload.lines.filter((l): l is string => typeof l === 'string')
        : []
      step.lines.push(...lines)
    } else if (record.record_type === 'sandbox_ready') {
      seen = true
      ready = true
    }
  }
  return seen ? { steps, ready } : null
}

// The collapsed one-liner under the ✻ header: the CURRENT phase only,
// rewritten in place as phases pass — the latest step with its latest log
// line, or "Ready!" once the box is up. Pure, for tests.
export function sandboxPhaseLine(state: SandboxState | null): string | null {
  if (!state) return null
  if (state.ready) return 'Ready!'
  const last = state.steps[state.steps.length - 1]
  if (!last) return null
  const lastLine = last.lines[last.lines.length - 1]
  return lastLine ? `${last.label}… · ${lastLine}` : `${last.label}…`
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
          {/* Unselected user turns swap the SDK's › gutter for a plain >,
              so › on screen always means "the selection is here". */}
          {selected ? '›' : item.gutter === '›' ? '>' : (item.gutter ?? '')}
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
