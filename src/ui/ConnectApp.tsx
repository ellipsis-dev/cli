import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Box, Static, Text, useApp, useInput, useStdin, useStdout } from 'ink'
import {
  streamSession,
  sessionStatusWord,
  StreamUnavailableError,
  type OpenSocket,
} from '@ellipsis-dev/sdk/stream'
import {
  cacheTierLabel,
  collapseToolRuns,
  foldCosts,
  lifecycleText,
  pendingToolCalls,
  recordToItems,
  sandboxOutputLines,
  sandboxOutputStep,
  sandboxPhaseLabel,
  statusActivityText,
  type CCEvent,
  type SessionTranscriptStore,
  type TranscriptItem,
} from '@ellipsis-dev/sdk/store'
import { errorDetail } from '../lib/api'
import type { Ellipsis } from '@ellipsis-dev/sdk'
import { hyperlink } from '../lib/urls'
import { usdNumberFromMillicents } from '../lib/output'
import { applyEditShortcut } from '../lib/editing'
import { CTRL_C_QUIT_HINT, useCtrlCQuit } from './ctrlC'
import { fitLines, visibleWidth } from '../lib/markdown'
import { SELECTION_GLYPH } from '../lib/sessions'
import { SURFACE_ACTIVE, SURFACE_ELEVATED, theme } from '../lib/theme'
import { useAltScreen } from './altScreen'
import { VERSION } from '../lib/constants'
import {
  activityRows,
  anchorAt,
  anchorIndex,
  contentWidth,
  entryRange,
  GUTTER_COLS,
  isAgentSpeech,
  isCollapsible,
  isToolActivity,
  itemRows,
  layOutItems,
  LIVE_GLYPH,
  MESSAGE_PAD,
  navKeyOf,
  padPanelBlocks,
  pendingMessageRows,
  rowViewport,
  settledItemKeys,
  settledRowCount,
  snapAnchorForEntry,
  spacerRow,
  spanColor,
  type RowSpan,
  type ScrollAnchor,
  type TranscriptRow,
} from './transcriptRows'

// The interactive `agent session connect` UI, modelled on Claude Code: a
// committed transcript that groups tool calls with their results and spaces
// messages apart — live activity (✻ Running/Generating) rendered on the
// transcript block it describes — above a footer with a composer that echoes
// what you send. Rendering shape lives in @ellipsis-dev/sdk/store (pure); this
// component owns the data flow, the composer, and the colours.
//
// TWO VIEWS of the same transcript, because they want opposite things from the
// terminal:
//
//   * THE CHAT (resting). Settled rows are handed to <Static>, which prints them
//     ONCE into the terminal's own scrollback and never repaints them. That is
//     what makes wheel/trackpad scrolling, select/copy and clickable links work
//     natively — they are the terminal's, not reimplementations. The price is
//     that a printed row is frozen: it cannot re-wrap, re-fold, or take a
//     selection marker. Only the unsettled tail plus the footer repaint.
//   * THE BROWSER (ctrl+r). A windowed view of the whole conversation on the
//     ALTERNATE screen, where rows can be repainted: folding tool runs open and
//     shut, walking entries with ↑/↓, app-read wheel scrolling. esc restores the
//     chat's screen exactly as it was.
//
// `windowed` is the flag that says which one this frame is painting.
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
  api: Ellipsis
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
  // ---- hosting (the multi-session UI) ----
  // Whether the app owns the keyboard. The host keeps exactly one input handler
  // active (session picker or chat); default true for the solo app.
  focused?: boolean
  // Hand focus to the host's session picker. Fired by ctrl+j, by esc with
  // nothing open (no browser, no transcript nav), and by ↓ at the bottom edge
  // (the composer's last line, or a watch-only follow). Absent in the solo app,
  // which has no picker to open.
  onFocusNav?: () => void
  // Print a header above this session's first flushed row. Set by the host when
  // this chat REPLACES another session's chat: both print into the same
  // scrollback, one under the other, so without a break the second reads as a
  // continuation of the first. Absent for the first chat of the process, which
  // has nothing above it.
  scrollbackBreak?: boolean
  // Terminal outcomes, reported to the host INSTEAD of exiting the app:
  // 'closed' = the conversation closed; 'preflight' = the session died
  // before it became connectable; 'ended' = a watch-only stream finished.
  // Absent in the solo app, which exits the Ink render instead.
  onDone?: (reason: 'closed' | 'preflight' | 'ended') => void
}

// Surface statuses in which something is actively happening — drives the
// spinner. `waiting` (turn done, warm, your move) and `sleeping` (parked) are
// deliberately NOT here: the spinner stops and the footer reads the calm state
// instead of a misleading "running".
function isWorkingStatus(status: string): boolean {
  return ['scheduled', 'starting', 'working', 'retrying'].includes(status)
}

// Text rows inside the composer panel, before its 1-cell pad above and below.
// One row: the input grows as you type past it, and the rows it isn't using
// belong to the conversation.
const COMPOSER_INTERIOR_ROWS = 1

// Horizontal breathing room inside the composer panel — wider than the 1-cell
// vertical pad so the caret and text start well clear of the panel edge.
const COMPOSER_PAD_X = 2

// Rows one wheel notch moves. Terminals report a notch per tick, and one row
// per tick makes a trackpad feel like it's dragging through treacle.
const WHEEL_ROWS = 3

// The startup block's entry key — it is one block, not a transcript item, so it
// owns a fixed key rather than a feed_seq one.
const SANDBOX_KEY = 'sandbox'

// Half the period of the live ⏺ pulse: the glyph dims for this long, then
// brightens for this long. ~1.4s a cycle — slow enough to read as breathing
// rather than flashing, and it lands off the 1s duration tick so the two
// don't visibly beat against each other.
const PULSE_MS = 700

// Columns the composer's text actually gets: the panel's horizontal pad on
// both sides, then the prompt glyph and its trailing space.
function composerTextCols(cols: number): number {
  return Math.max(8, cols - COMPOSER_PAD_X * 2 - 2)
}

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

  // Terminal size, tracked across resizes. It bounds the LIVE region — the
  // unsettled tail, the composer and the meta line — rather than sizing a window
  // the whole conversation has to fit in: the settled transcript above has been
  // handed to the terminal, which is what makes the wheel work, and it is the
  // terminal's business how tall that is now.
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

  // The app always owns the terminal now (there is no pane host left), so the
  // resting view is SCROLLBACK: the settled transcript is flushed ONCE into the
  // terminal's own scrollback (<Static>) and only the live tail + composer
  // repaint. Wheel/trackpad scrolling, select/copy and clickable links are then
  // the terminal's own, which is the whole point.
  const rows = termRows
  const cols = termCols
  const focused = props.focused ?? true
  // A row left for the shell cursor and the caller's sign-off line.
  const bottomSlack = 1

  // Terminal outcomes: reported to the host when there is one (the app stays
  // mounted; the host decides what to show), otherwise exit the Ink render.
  // The callback rides a ref so `finish` (and everything memoized on it, the
  // stream pump above all) stays stable even when the host passes a fresh
  // closure every render — a changing pump identity would abort the socket.
  const onDoneRef = useRef(props.onDone)
  onDoneRef.current = props.onDone
  const hasHost = props.onDone != null
  const finish = useCallback(
    (reason: 'closed' | 'preflight' | 'ended'): void => {
      if (onDoneRef.current) onDoneRef.current(reason)
      else exit()
    },
    [exit],
  )

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
  // line renders the cyan selection glyph in its gutter.
  const [navKey, setNavKey] = useState<string | null>(null)
  // Local ✦ lines in the transcript, for things the CLIENT did that the record
  // log will never carry: so far, /stop. It belongs in the conversation because
  // it is an event in the conversation — the notice bar above the composer is
  // for transient status, and scrolls away with nothing to show you asked.
  const [chatNotes, setChatNotes] = useState<readonly { key: string; text: string }[]>([])
  // Lines opened in place with → while highlighted: a grp:* fold expands into
  // its tool calls, a clamped long body un-clamps. ← closes them again.
  const [openedKeys, setOpenedKeys] = useState<ReadonlySet<string>>(new Set())
  // The transcript viewport: the ROW pinned to the top of the window (as an
  // entry + row offset, so appends and re-wraps can't slide it), or null to
  // follow the bottom — the default, so streamed content stays in view. The
  // wheel and ↑/↓ move it a row at a time; the highlight snaps it so the
  // selected entry comes into frame.
  const [scrollAnchor, setScrollAnchor] = useState<ScrollAnchor | null>(null)
  // The transcript BROWSER: a windowed view of the whole conversation, opened
  // over the alternate screen with ctrl+r and closed with esc. It exists because
  // the scrollback view gives up the things a repaintable window can do —
  // folding tool runs open and shut, walking entries with ↑/↓, re-wrapping on
  // resize — so those move here instead of disappearing.
  //
  // While it is open the <Static> flush is withheld: a row flushed onto the alt
  // screen would die with that buffer, so the primary buffer would come back
  // missing exactly the rows that settled while you were reading. Held back,
  // they flush on the way out.
  const [windowed, setWindowed] = useState(false)
  useAltScreen(windowed)
  // Everything ↑/↓ can land on, read through a ref so opening the browser can
  // select the newest entry without the selection effect re-firing every time a
  // record lands and dragging the highlight back down the transcript.
  const navKeysRef = useRef<readonly string[]>([])
  // Opening the browser lands on the newest entry, so →/← have something to
  // open the moment the screen appears. Leaving drops the selection, the scroll
  // position and the expand toggle: re-opening starts at the bottom of the
  // conversation rather than wherever it was parked a conversation ago.
  useEffect(() => {
    if (windowed) {
      const keys = navKeysRef.current
      if (keys.length > 0) setNavKey(keys[keys.length - 1])
      return
    }
    setNavKey(null)
    setScrollAnchor(null)
    setExpanded(false)
  }, [windowed])
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
  // Each turn's closing duration/cost summary is dropped too (see
  // reshapeTranscript) — the footer carries the session's spend.
  const { items } = useMemo(() => {
    const shaped = reshapeTranscript(snapshot.records, props.minRenderFeedSeq)
    // Client-side notes land at the end: they describe what you just did, so
    // they belong under everything the server has sent so far.
    for (const note of chatNotes) {
      shaped.items.push({ key: note.key, kind: 'notice', text: note.text, spaceBefore: true })
    }
    return shaped
  }, [snapshot.records, props.minRenderFeedSeq, chatNotes])

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
  // resets it, so a wake tells a fresh story): a headline tracking the
  // session's state, plus ONE FLAT LOG of every milestone and every line of
  // build/setup output, newest last. While the session comes up the block
  // shows the tail of that log; once ready it collapses to the bare headline,
  // and → while highlighted re-opens the log to re-read it. The block persists
  // after startup as the durable trace (the sandbox_ready transcript notice is
  // suppressed below in its favour).
  const sandbox = useMemo(
    () => deriveSandboxState(snapshot.records, props.minRenderFeedSeq),
    [snapshot.records, props.minRenderFeedSeq],
  )
  // Whether a SETTLED block is showing its log again (→ opens it, ← closes it).
  // A live start always shows the log — there is nothing to collapse until the
  // session is up.
  const [sandboxLogOpen, setSandboxLogOpen] = useState(false)

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
    finish('closed')
  }, [finish, props.exitState])
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
        // No cursor: the store drops records at or below its own feed_seq,
        // so a full re-read is deduped rather than re-rendered.
        const [page, { session }] = await Promise.all([
          api.sessions.records(sessionId).then((p) => p.response),
          api.sessions.get(sessionId),
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
          if (!hasHost) process.exitCode = 1
          finish('preflight')
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
          finish('ended')
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
        if (!canSend) finish('ended')
      })
      .finally(() => {
        streaming.current = false
      })
  }, [canSend, finish, finishClosed, hasHost, openSocket, sessionId, startPollFallback, store])

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
  // POST is in flight — dim), 'cancelled' (taken by a turn that died without
  // answering it — see deliveredUnechoedSends). Local chips are multiset-
  // subtracted by text so a send never renders twice during the
  // received-record handoff window.
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
      ...acceptedSends.map((m) => ({
        key: m.id,
        text: m.body,
        state: m.cancelled ? ('cancelled' as const) : ('accepted' as const),
      })),
      ...serverQueued.map((text, i) => ({ key: `sq${i}`, text, state: 'queued' as const })),
      ...extras.map((text, i) => ({ key: `lq${i}`, text, state: 'sending' as const })),
    ]
  }, [acceptedSends, serverQueued, queued])

  // The session's opening prompt, shown as a queued row while the sandbox comes
  // up. A prompt given at creation is NOT an inbox message yet — the worker
  // inserts it as turn 0's message once Claude Code is running in the sandbox,
  // which can be minutes later — so without this the chat sits empty and the
  // message you just sent is nowhere on screen.
  //
  // It retires on the first message_received record: from there the inbox rows
  // (queued → delivered → the echo) are the truth for the same text, so the two
  // never both render. That record is also what keeps an OLD session's original
  // prompt out of the chat — its turn-0 message_received is in the feed, even
  // when --no-records hides the transcript itself.
  const pendingPrompt = useMemo(() => {
    if (items.length > 0) return null
    if (snapshot.records.some((r) => r.record_type === 'message_received')) return null
    const prompt = snapshot.session?.prompt
    return typeof prompt === 'string' && prompt.trim() ? prompt : null
  }, [items.length, snapshot.records, snapshot.session?.prompt])

  // Whether a send is waiting on the agent — a queued row breathes while it
  // waits, like a running tool does.
  const sendsWaiting =
    pendingPrompt !== null ||
    inFlightSends.some((q) => q.state === 'queued' || q.state === 'sending')

  // The heartbeat behind every live ⏺ mark: one timer for the whole app, so
  // each pulsing glyph breathes in step instead of drifting out of phase. It
  // runs only while something is actually in flight — a still ⏺ on a settled
  // transcript would be a lie, and an idle interval would wake the render loop
  // for nothing. Reset on the way in so a new turn starts bright.
  const [pulseOn, setPulseOn] = useState(true)
  const pulsing = working || sendsWaiting
  useEffect(() => {
    if (!pulsing) {
      setPulseOn(true)
      return
    }
    const t = setInterval(() => setPulseOn((on) => !on), PULSE_MS)
    return () => clearInterval(t)
  }, [pulsing])
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
            const { session: s } = await api.sessions.stop(sessionId)
            setNotice(null)
            setChatNotes((prev) => [
              ...prev,
              {
                key: `note${prev.length}`,
                text: `Stopped the agent (${s.status}). The conversation is saved. Send a message to pick it back up.`,
              },
            ])
            return
          }
          // Show the message as queued, then post it. The POST returns the
          // created SessionMessage (protocol v2 §4.2): stamp the chip with its
          // id so the first messages frame / user-echo record carrying that id
          // retires it in favour of the server's own row.
          setQueued((prev) => [...prev, { text, messageId: null }])
          setNotice(null)
          const { message: created } = await api.sessions.sendMessage(sessionId, { message: text })
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
          setNotice(`✗ ${errorDetail(err)}`)
        }
      })()
    },
    [api, exit, pump, sessionId],
  )

  // The composer renders whenever sending is possible.
  // The browser drops the composer: it is a reader, and those rows are better
  // spent on conversation. The keyboard handler stays active (it owns the
  // browser's own keys), and its composer-editing branches are gated below.
  const composerVisible = canSend && isRawModeSupported && !windowed
  // The browser keeps the keyboard even though it has no composer — it is
  // driven entirely by keys, esc included, so gating input on the composer
  // would strand you on the alt screen.
  const inputActive = (composerVisible || windowed) && focused

  // Mouse reporting (SGR) — the browser's wheel scrolling, and ONLY the
  // browser's. It owns the alternate screen, whose scrollback is empty by
  // definition, so the wheel is useless there unless the app reads it. The chat
  // never arms it: down there the transcript is in the terminal's real
  // scrollback, and capturing the mouse would take native scrolling, select/copy
  // and clickable links away to reimplement what the terminal just did for free.
  useEffect(() => {
    if (!windowed || !inputActive || !stdout?.isTTY) return
    stdout.write('\u001B[?1000h\u001B[?1006h')
    return () => {
      stdout.write('\u001B[?1006l\u001B[?1000l')
    }
  }, [windowed, inputActive, stdout])

  // The rendered transcript lines, in order: collapsed (the default) folds
  // consecutive tool activity into "Ran N …" notices, except the runs under a
  // MESSAGE opened in place with → (openedKeys), where the fold is REPLACED by
  // the calls it stood for — "Ran 2 shell commands" above the two commands is
  // just a stale count of what you can already see — and ← folds them back. The
  // message is what opens, not the fold: a run of tool calls is work that
  // message did, so it is reached by opening the message (see layOutItems).
  // Expanded (ctrl+r) shows everything, flat.
  const visible = useMemo(() => {
    const pendingKeys = new Set(pendingTools.map((t) => t.key))
    const base = pendingKeys.size ? items.filter((i) => !pendingKeys.has(i.key)) : items
    if (expanded) return items
    const folded = collapseToolRuns(base)
    if (openedKeys.size === 0) return folded
    const out: TranscriptItem[] = []
    // The message a fold hangs off: opening THAT is what reveals the run.
    let parent: string | null = null
    for (const item of folded) {
      if (!isToolActivity(item)) {
        out.push(item)
        parent = item.key
        continue
      }
      const open = item.key.startsWith('grp:') && parent !== null && openedKeys.has(parent)
      if (open) out.push(...foldRun(item.key, base))
      else out.push(item)
    }
    return out
  }, [items, expanded, pendingTools, openedKeys])

  const infraActivity = statusActivityText(statusWord)
  // The startup story has settled: the headline is final ("Session ready!"),
  // nothing is live. This is when the block collapses to the bare headline.
  const sandboxSettled = (sandbox?.done ?? false) && !infraActivity
  useEffect(() => {
    // A fresh start (wake/retry) re-opens the live hierarchy and re-arms the
    // collapse for when it settles again.
    if (!sandboxSettled) setSandboxLogOpen(false)
  }, [sandboxSettled])
  // How the pane's rows are divided: the footer (notice + composer + meta
  // line) is fixed, the chat window takes the rest, and the top padding is the
  // give — it shrinks, to nothing if it must, so the frame always fits.
  //
  // Fitting is not cosmetic: an over-tall frame scrolls ink's render region and
  // smears stale rows up the terminal. So the window's budget is whatever is
  // left AFTER the footer, never a floor that could exceed the pane, and the
  // window itself renders exactly that many rows (see rowViewport).
  // ctrl+c interrupts the turn, then quits: the first press sends the same
  // /stop the composer's command does, the second exits. Active whenever this
  // pane owns the keyboard, watch-only follows included (nothing to stop there,
  // but ctrl+c still has to be the way out).
  const ctrlCArmed = useCtrlCQuit(
    isRawModeSupported && focused && (composerVisible || windowed || !hasHost),
    () => {
      if (working && canSend) submit('/stop')
    },
  )
  // The notice bar doubles as the ctrl+c prompt: armed, it says what a second
  // press does, so the quit is never a surprise.
  // The browser is for reading, not sending: it drops the composer for the rows
  // (a whole screen of conversation is the point of opening it) and says so on
  // the notice line, which is where the app's one line of transient guidance
  // already lives.
  const browserNotice = '↑↓ scroll · → open · ← close · ctrl+r expand all · esc back to the chat'
  // With nothing else to say, the chat names the screens it can open — neither
  // is visible from here, so without this they are undiscoverable. Only where
  // the keyboard actually reaches us: a headless `--no-input` follow (piped into
  // a script or an agent) would otherwise advertise keys nothing can press.
  const restingHint = isRawModeSupported
    ? `ctrl+r transcript${props.onFocusNav ? ' · ctrl+j sessions' : ''}`
    : null
  const shownNotice = windowed
    ? browserNotice
    : ctrlCArmed
      ? CTRL_C_QUIT_HINT
      : (notice ?? restingHint)
  const { viewBudget, padRows, composerRows, noticeRows } = useMemo(() => {
    // Both wrapping parts of the footer are measured as the rows they will
    // actually OCCUPY, not as the newlines they contain: a notice ("stream
    // error: …") and a typed paragraph both wrap, and counting either as one
    // row means the footer quietly outgrows the space reserved for it.
    const fixed = 1 /* meta line */ + 1 /* footer margin */
    // What the wrapping parts share. Each takes what it needs and yields the
    // rest, in priority order: the chat window always keeps a row, then the
    // composer, and the notice gives up its extra rows first (it truncates —
    // the important half of "stream error: …" is the front).
    let free = rows - bottomSlack - fixed
    // A pane with no room for chat + composer + notice drops the notice
    // entirely: overflowing the frame would smear the whole app.
    const noticeRows = shownNotice
      ? Math.max(0, Math.min(fitLines(`· ${shownNotice}`, cols).length, free - 2))
      : 0
    free -= noticeRows
    // The composer panel: its interior grows with the input, plus the 1-cell
    // pad above and below. No rules to account for — the tint is the frame. In
    // a pane too short for all of it the pad goes, then the interior shrinks
    // toward a single row.
    const typedRows = fitLines(composer.text, composerTextCols(cols)).length
    const wanted = Math.max(COMPOSER_INTERIOR_ROWS, typedRows) + 2
    const composerRows = composerVisible ? Math.max(1, Math.min(wanted, free - 1)) : 0
    const forContent = Math.max(1, free - composerRows)
    // The browser fills the screen it took over, so it keeps a row of top
    // padding; the chat is content-sized and grows downward, so it has no window
    // edge to protect and takes none.
    const pad = windowed ? Math.max(0, Math.min(1, forContent - 1)) : 0
    return { viewBudget: forContent - pad, padRows: pad, composerRows, noticeRows }
  }, [
    rows,
    cols,
    bottomSlack,
    windowed,
    composerVisible,
    composer.text,
    shownNotice,
  ])

  // The live tail: the in-progress response and the one activity line under
  // it. Three distinct, factual signals — never whimsy — each rendered on the
  // block it describes, not above the composer:
  // - `generating`: the model is streaming tokens (delta frames flowing) —
  //   the ✻ line under the streamed prose, with elapsed + token count.
  // - a running tool: a committed tool call awaits its result — a ✻ line
  //   attached to the burst it belongs to ("Ran 2 shell commands" then the
  //   live third), naming the tool and ticking its own timer. `hug` drops the
  //   spacer so it reads as part of that burst.
  // - the fallback: a turn is in flight but nothing else says so — the
  //   harness-boot dead air (~15-20s before Claude Code's first event) and a
  //   running turn's between-records lull. Without it a send looks like the
  //   app hung. Gated on the TURN, not the session status: a bare interactive
  //   session reads 'working' while it waits for your first message, and
  //   narrating that would claim work that isn't happening.
  // (`infraActivity` is the fourth signal, and lives in the startup block at
  // the top, where a startup message belongs.)
  const liveTail = useMemo(() => {
    const liveText = snapshot.liveText
    const liveTokens = snapshot.liveOutputTokens
    const generating = statusWord === 'working' && (liveText !== '' || liveTokens != null)
    const runningTool = statusWord === 'working' && !generating && pendingTools.length > 0
    // Whether the activity line hugs the block above it: in expanded mode the
    // pending ● call itself is the last line; collapsed, when the trailing
    // fold ("Ran N …", key grp:*) — or an opened fold's trailing tool line —
    // is the same burst the pending call belongs to.
    const last = visible[visible.length - 1]
    const hug = expanded
      ? pendingTools.length > 0
      : last != null &&
        (last.key.startsWith('grp:') || last.kind === 'tool' || last.kind === 'tool_result')
    if (generating) {
      return {
        text: liveText,
        label: 'Generating…',
        tick: 'elapsed' as const,
        suffix: liveTokens != null ? `${formatTokens(liveTokens)} tokens` : '',
        // The ⏺ line sits directly under the prose it describes.
        hug: liveText !== '',
        nested: false,
      }
    }
    if (runningTool) {
      const label =
        pendingTools.length === 1
          ? `Running ${pendingTools[0].text}${pendingTools[0].detail ?? ''}…`
          : `Running ${pendingTools.length} tool calls (${[...new Set(pendingTools.map((t) => t.text))].join(', ')})…`
      // A running tool call nests under the message that made it, in the same
      // place its ⎿ result will land — so it takes the SAME predicate
      // layOutItems uses for that result. Any disagreement here shows up as the
      // live line sitting flat and then jumping a level when the result lands.
      const said = visible.filter((i) => !isToolActivity(i)).pop()
      return {
        text: '',
        label,
        tick: 'tool' as const,
        suffix: '',
        hug,
        nested: said != null && isAgentSpeech(said),
      }
    }
    if (working && !infraActivity && (awaitingAgent !== null || sendPending)) {
      return {
        text: '',
        label: `${awaitingAgent === 'boot' ? 'Starting the agent' : 'Working'}…`,
        tick: 'elapsed' as const,
        suffix: '',
        hug: false,
        nested: false,
      }
    }
    return { text: '', label: '', tick: 'elapsed' as const, suffix: '', hug: false, nested: false }
  }, [
    snapshot.liveText,
    snapshot.liveOutputTokens,
    statusWord,
    pendingTools,
    visible,
    expanded,
    working,
    infraActivity,
    awaitingAgent,
    sendPending,
  ])

  // EVERY row the chat window can show, top to bottom: the startup block, the
  // committed transcript, then the tail that only exists while a turn is live
  // (accepted sends, the streaming response, the activity line, queued sends).
  // The tail rides in the same list rather than rendering below the window, so
  // it can't overflow the frame — and so scrolling up through it works like
  // scrolling up through anything else.
  const allRows = useMemo(() => {
    const out: TranscriptRow[] = []
    if (infraActivity || sandbox) {
      out.push(
        ...sandboxRows({
          sandbox,
          infraActivity,
          settled: sandboxSettled,
          expanded: sandboxLogOpen,
          cols,
        }),
      )
    }
    // Tool activity is nested under the message that produced it (layOutItems
    // decides what hangs off what, and what ↑/↓ can land on), so a call and its
    // result read as work the agent did mid-message rather than as turns of
    // their own.
    for (const placed of layOutItems(visible, { openedKeys, revealAll: expanded })) {
      const rows = itemRows(placed.item, cols, {
        indent: placed.indent,
        nested: placed.nested,
        attach: placed.attach,
        // Opening a block un-clamps what it owns as well as itself: → on a
        // revealed tool call shows the full output of the ⎿ result under it,
        // which is the line that actually carries the body.
        clamp:
          !expanded &&
          !openedKeys.has(placed.item.key) &&
          !(placed.navKey !== undefined && openedKeys.has(placed.navKey)),
      })
      // A line inside another's block carries that block's nav key, so ↑/↓
      // land on the block and this line travels with it.
      out.push(
        ...(placed.navKey || placed.parentKey
          ? rows.map((r) => ({ ...r, navKey: placed.navKey, parentKey: placed.parentKey }))
          : rows),
      )
    }
    // Sends the agent has TAKEN (delivered, echo record still in flight):
    // full-colour ◆ rows ABOVE the live activity — the running turn is the
    // response to THIS message, so its stream belongs below it.
    for (const q of inFlightSends.filter((q) => q.state === 'accepted')) {
      out.push(...pendingMessageRows(q.key, q.text, cols, { gutter: '◆', bold: true, panel: true }))
    }
    if (liveTail.text) {
      out.push(...pendingMessageRows('live', liveTail.text, cols, { gutter: '' }))
    }
    if (liveTail.label) {
      out.push(
        ...activityRows(
          'live:act',
          liveTail.label,
          liveTail.tick,
          liveTail.suffix,
          cols,
          liveTail.hug,
          liveTail.nested,
        ),
      )
    }
    // The session's opening prompt while it is still only a start request: the
    // same queued row a mid-session send gets, so the message you sent is on
    // screen from the first frame.
    if (pendingPrompt) {
      out.push(
        ...pendingMessageRows('prompt', pendingPrompt, cols, {
          gutter: LIVE_GLYPH,
          dim: true,
          right: 'queued',
          pulse: true,
          panel: true,
        }),
      )
    }
    for (const q of inFlightSends.filter((q) => q.state !== 'accepted')) {
      const waiting = q.state !== 'cancelled'
      out.push(
        ...pendingMessageRows(q.key, q.text, cols, {
          // A waiting send wears the breathing ⏺, the app's one "in flight"
          // mark; a cancelled one keeps the ◆ sender glyph — it was a real
          // message, it just never got answered.
          gutter: waiting ? LIVE_GLYPH : '◆',
          dim: true,
          right: q.state === 'sending' ? 'sending' : q.state === 'queued' ? 'queued' : 'cancelled',
          pulse: waiting,
          panel: true,
        }),
      )
    }
    // Every lifted block gets its blank tinted row above and below, here so a
    // message and the tool run attached under it share one pad.
    return padPanelBlocks(out)
  }, [
    infraActivity,
    sandbox,
    sandboxSettled,
    sandboxLogOpen,
    visible,
    expanded,
    openedKeys,
    inFlightSends,
    pendingPrompt,
    liveTail,
    cols,
  ])

  // Everything ↑/↓ can land on, top to bottom: the BLOCKS with rows on the list
  // (a nested tool line is part of its message's block, not a stop of its own —
  // see layOutItems), minus turn summaries ("turn complete · 3s · $0.03") —
  // informational trailers, not content, so the walk skips them (they still
  // render and scroll) — and minus the live tail, which moves under you as it
  // streams.
  const navKeys = useMemo(() => {
    const skip = new Set(visible.filter((i) => i.kind === 'summary').map((i) => i.key))
    const seen = new Set<string>()
    const out: string[] = []
    for (const row of allRows) {
      const key = navKeyOf(row)
      if (skip.has(key) || key.startsWith('live')) continue
      if (seen.has(key)) continue
      seen.add(key)
      out.push(key)
    }
    return out
  }, [allRows, visible])
  navKeysRef.current = navKeys

  // The window on screen this frame. A stale anchor (its entry folded away or
  // scrolled off the record log) falls back to following the bottom.
  const view = useMemo(() => {
    const anchor = scrollAnchor ? anchorIndex(allRows, scrollAnchor) : null
    return rowViewport(allRows.length, viewBudget, anchor)
  }, [allRows, viewBudget, scrollAnchor])

  // ---- the scrollback split ----
  // Rows whose content is FINAL go to <Static>: printed once, into the
  // terminal's own scrollback, never repainted. Everything after them is the
  // live region, repainted each frame. See settledItemKeys for what "final"
  // means and why it is decided per message rather than per turn.
  //
  // The startup block is final once it has settled (it collapses to its bare
  // headline then, so the flushed copy is the one that lasts). It sits at the
  // top of the list, so nothing below it can flush while it is still moving.
  const settledKeys = useMemo(() => {
    if (windowed) return new Set<string>()
    const keys = settledItemKeys(visible, working)
    if (sandboxSettled) keys.add(SANDBOX_KEY)
    return keys
  }, [windowed, visible, working, sandboxSettled])
  // The rows already handed to <Static>, held APPEND-ONLY in a ref, and the
  // entries they covered. Both are needed, and neither can be replaced by
  // re-slicing allRows each frame:
  //
  //   * <Static> prints `items.slice(printedCount)` and re-syncs printedCount
  //     from items.length. So the list may only GROW, and the rows already in it
  //     may never change. Hand it a shorter list — which withholding the flush
  //     for the browser does — and it re-prints everything on the way back.
  //   * The rows on the terminal are FROZEN TEXT, wrapped at the width they were
  //     printed at. allRows re-wraps on resize, so a re-slice would hand
  //     <Static> different rows for the same content and print them again. What
  //     was flushed is history: it is kept verbatim, and a resize re-wraps only
  //     the live region below. (Claude Code's scrollback has the same artifact —
  //     printed output does not reflow.)
  //
  // So an entry is flushed ONCE, keyed by entryKey, and its rows are kept as they
  // were built. Seeded with the session break when this chat replaces another
  // one's, so the rule prints above the first row of history, not after it.
  const flushedRows = useRef<TranscriptRow[]>(
    props.scrollbackBreak ? [sessionBreakRow(sessionId, cols)] : [],
  )
  const flushedEntries = useRef<Set<string>>(new Set())
  if (!windowed) {
    const settledRows = allRows.slice(0, settledRowCount(allRows, settledKeys))
    const fresh = settledRows.filter((r) => !flushedEntries.current.has(r.entryKey))
    if (fresh.length > 0) {
      flushedRows.current = [...flushedRows.current, ...fresh]
      for (const row of fresh) flushedEntries.current.add(row.entryKey)
    }
  }
  const staticRows = flushedRows.current
  // The live region: everything not yet flushed, capped to the rows the frame
  // has for it. Capped from the FRONT (keep the newest) because an over-tall
  // live frame scrolls ink's render region and smears stale rows up the
  // terminal — and nothing is lost, since these rows flush as they settle.
  const liveRows = useMemo(() => {
    const rest = allRows.filter((r) => !flushedEntries.current.has(r.entryKey))
    return rest.length > viewBudget ? rest.slice(rest.length - viewBudget) : rest
    // flushedEntries is a ref mutated above during this same render, so the
    // filter always sees the boundary this frame just committed to.
  }, [allRows, viewBudget, staticRows])

  // The one row that wears the ▶ marker: the selected block's FIRST row with a
  // gutter glyph, since the marker replaces that glyph in place. Only one row
  // takes it — a block with nested tool activity has a glyph on the call and on
  // its ⎿ result, and marking both reads as two separate selections.
  //
  // Restricted to rows ON SCREEN, because the marker is now the ONLY thing that
  // says "you are here" (there is no highlight bar any more). A block taller
  // than the window is bottom-aligned by the ↑ snap, which puts its first row
  // above the frame — so the marker falls to the topmost visible row of the
  // block, and the selection stays legible instead of vanishing.
  const markerRowId = useMemo(() => {
    if (navKey === null) return null
    const onScreen = allRows.slice(view.start, view.end).filter((r) => navKeyOf(r) === navKey)
    return (onScreen.find((r) => r.gutter) ?? onScreen.find((r) => !r.spacer))?.id ?? null
  }, [allRows, navKey, view.start, view.end])

  // Move the window by `delta` ROWS. Reaching the last row re-pins it to the
  // bottom, so streamed content follows again.
  const scrollByRows = useCallback(
    (delta: number): void => {
      const next = view.start + delta
      // Reaching the last screenful re-pins to the bottom, so streamed content
      // follows again instead of the window sitting one row short of it.
      if (next >= allRows.length - view.capacity) setScrollAnchor(null)
      else setScrollAnchor(anchorAt(allRows, Math.max(0, next)))
    },
    [allRows, view],
  )

  // Snap the window so a highlighted entry is readable, given which way the
  // highlight is travelling (`dir`: 1 for ↓, -1 for ↑). See snapToEntry.
  const ensureVisible = useCallback(
    (key: string, dir: 1 | -1 = 1): void => {
      const move = snapAnchorForEntry(allRows, key, view, view.capacity, dir)
      if (move) setScrollAnchor(move.anchor)
    },
    [allRows, view],
  )

  // An entry too tall for the window is scrolled THROUGH before the highlight
  // leaves it: while part of it is still out of frame in the direction you're
  // heading, ↑/↓ move the window a row instead of jumping to the next entry.
  // Returns whether it handled the keypress.
  const revealMore = useCallback(
    (key: string, delta: number): boolean => {
      const range = entryRange(allRows, key)
      if (!range) return false
      const more = delta < 0 ? range.first < view.start : range.last >= view.end
      if (!more) return false
      scrollByRows(delta)
      return true
    },
    [allRows, view, scrollByRows],
  )

  // Whether a block has tool activity nested under it that → can reveal: rows
  // that name it as their block but aren't its own (see layOutItems).
  const hasToolRun = useCallback(
    (key: string): boolean => allRows.some((r) => r.navKey === key),
    [allRows],
  )

  // The block a stop sits inside, for ← to step out to: a tool call revealed
  // under an opened message names that message.
  const parentOf = useCallback(
    (key: string): string | null =>
      allRows.find((r) => navKeyOf(r) === key && r.parentKey)?.parentKey ?? null,
    [allRows],
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
          if (m[1] === '64') delta -= WHEEL_ROWS
          else if (m[1] === '65') delta += WHEEL_ROWS
        }
        if (delta !== 0 && windowed) scrollByRows(delta)
        return
      }
      // Page keys scroll the window a frame at a time, from the composer or
      // the transcript alike — the fast way through a long conversation. In
      // the scrollback view the terminal's own page keys do this, over the real
      // scrollback, so the app leaves them alone.
      if (key.pageUp || key.pageDown) {
        if (windowed) scrollByRows(key.pageUp ? -view.capacity : view.capacity)
        return
      }
      if (key.escape) {
        // Modal-first, outermost modal first: the browser is a screen of its
        // own, so esc closes it before anything inside it is considered.
        if (windowed) {
          setWindowed(false)
          return
        }
        // Transcript navigation drops back to the composer, then esc leaves
        // the pane.
        if (navKey !== null) {
          setNavKey(null)
          setScrollAnchor(null)
          return
        }
        // Hosted: hand focus to the session nav (stopping is the composer's
        // /stop command). Solo: esc-while-working keeps meaning stop.
        if (props.onFocusNav) props.onFocusNav()
        else if (working) submit('/stop')
        return
      }
      // ctrl+r means "show me everything", and what that takes depends on where
      // the transcript lives. In a repaintable window it expands every collapsed
      // body and tool fold in place. In the scrollback view the printed rows
      // can't be re-folded, so ctrl+r OPENS THE BROWSER — the windowed view of
      // the whole conversation on the alt screen — where it can. Inside the
      // browser it goes back to being the expand toggle.
      if (key.ctrl && ch === 'r') {
        if (windowed) setExpanded((v) => !v)
        else setWindowed(true)
        return
      }
      // ctrl+j opens the session picker. It needs a key of its own now that the
      // list is a screen rather than a band you can see: esc and ↓ still reach
      // it, but neither says it is there.
      if (key.ctrl && ch === 'j' && props.onFocusNav) {
        props.onFocusNav()
        return
      }
      if (navKey !== null) {
        // Transcript navigation: ↑/↓ walk the entries, snapping the window so
        // the highlighted one is readable; →/enter opens the highlighted one,
        // ← closes it, typing drops back to the composer.
        const idx = navKeys.indexOf(navKey)
        if (key.upArrow) {
          // A message taller than the window is READ before it is left: ↑
          // scrolls up inside it while any of it is still below the frame,
          // and only moves to the previous entry once its top is on screen.
          if (revealMore(navKey, -1)) return
          const target = idx === -1 ? navKeys.length - 1 : Math.max(0, idx - 1)
          if (navKeys.length > 0) {
            setNavKey(navKeys[target])
            ensureVisible(navKeys[target], -1)
          }
          return
        }
        if (key.downArrow) {
          if (revealMore(navKey, 1)) return
          if (idx === -1 || idx >= navKeys.length - 1) {
            setNavKey(null)
            setScrollAnchor(null)
          } else {
            setNavKey(navKeys[idx + 1])
            ensureVisible(navKeys[idx + 1], 1)
          }
          return
        }
        if (key.rightArrow || key.return) {
          if (navKey === 'sandbox') {
            // One level, one keystroke: → shows the startup log again on a
            // settled block (a live one is already showing it).
            setSandboxLogOpen(true)
          } else {
            // → opens the highlighted block one level: a message reveals the
            // tool calls it made (which ↑/↓ then step through one at a time), a
            // call reveals its full output, a clamped body un-clamps.
            const item = visible.find((i) => i.key === navKey)
            if (item && (hasToolRun(navKey) || isCollapsible(item))) {
              setOpenedKeys((prev) => new Set(prev).add(navKey))
            }
          }
          return
        }
        if (key.leftArrow) {
          // ← closes the highlighted block, or — with nothing of its own open —
          // steps back OUT to the block it sits inside, closing that (a
          // revealed tool call returns the highlight to its message). Inert at
          // the top level with nothing open; the session nav lives BELOW the
          // composer, so ↓ is what walks to it.
          if (navKey === 'sandbox') {
            setSandboxLogOpen(false)
          } else if (openedKeys.has(navKey)) {
            setOpenedKeys((prev) => {
              const next = new Set(prev)
              next.delete(navKey)
              return next
            })
          } else {
            const parent = parentOf(navKey)
            if (parent) {
              setOpenedKeys((prev) => {
                const next = new Set(prev)
                next.delete(parent)
                return next
              })
              setNavKey(parent)
              ensureVisible(parent)
            }
          }
          return
        }
        if (ch && !key.ctrl && !key.meta && composerVisible) {
          setNavKey(null)
          setScrollAnchor(null)
          insertAtCursor(ch)
        }
        return
      }
      // The browser has no composer and no session nav to hand focus to: with
      // nothing highlighted yet, ↑/↓ scroll the window a notch (entering the
      // ↑ walk above once something is selected). esc — handled at the top — is
      // the only way out.
      if (windowed) {
        if (key.upArrow) scrollByRows(-1)
        else if (key.downArrow) scrollByRows(1)
        return
      }
      // Below here are the composer's own keys. Watch-only (no composer):
      // ↑ still enters transcript navigation, ↓ leaves for the session nav;
      // everything else is inert.
      if (!composerVisible) {
        if (key.upArrow && windowed && navKeys.length > 0) {
          setNavKey(navKeys[navKeys.length - 1])
          setScrollAnchor(null)
        } else if (key.downArrow && props.onFocusNav) {
          props.onFocusNav()
        }
        return
      }
      if (key.return) {
        submit(composer.text)
        return
      }
      // Word/line jumps and kills (option+←/→, ctrl+a/e/w/u/k, …) before the
      // plain arrow handling below, which moves by one character.
      const edited = applyEditShortcut(composer, ch, key)
      if (edited) {
        setComposer(edited)
        return
      }
      if (key.upArrow) {
        // Up inside a multi-line input climbs a line; up on line 1 moves
        // focus into the transcript, landing on the newest line. Not in
        // the scrollback view: the transcript up there is the terminal's, not
        // the app's, so there is nothing to put a highlight on.
        const up = cursorLineUp(composer.text, composer.cursor)
        if (up !== null) setComposer((c) => ({ ...c, cursor: up }))
        else if (windowed && navKeys.length > 0) {
          setNavKey(navKeys[navKeys.length - 1])
          setScrollAnchor(null)
        }
        return
      }
      if (key.downArrow) {
        // Down inside a multi-line input walks a line; down on the last
        // line moves focus to the host's session nav (the bar below).
        const down = cursorLineDown(composer.text, composer.cursor)
        if (down !== null) setComposer((c) => ({ ...c, cursor: down }))
        else if (props.onFocusNav) props.onFocusNav()
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

  // The persistent footer status line: status · running spend · model ·
  // session id (the dashboard link) · agent config (when the session has
  // one) · CLI version. Per-step costs live on the transcript's metadata
  // column, so the footer carries the total alone. Command hints live in
  // --help. The total prefers the server's ledger figure (live via the
  // session frames' cost columns, climbing mid-turn); the CC-derived result
  // total is the fallback against older backends.
  const totalStr = `$${(serverCostUsd ?? cost.total ?? 0).toFixed(2)}`
  // Sized to fit by construction: Ink measures the OSC-8 hyperlink's
  // invisible URL bytes as width, so a linked id only ships when the whole
  // line — escape bytes included — fits the pane; otherwise the id renders
  // as plain text, shortened if even that overflows. Never rely on Ink
  // wrapping/truncating this line: it's budgeted at exactly one row.
  const metaParts = (id: string): string[] => [
    `${statusWord} · ${totalStr} total`,
    ...(props.model ? [props.model] : []),
    id,
    ...(props.configName ? [props.configName] : []),
    `v${VERSION}`,
  ]
  const linked = metaParts(hyperlink(props.sessionUrl, sessionId)).join(' · ')
  const plain = metaParts(sessionId).join(' · ')
  const metaLine =
    linked.length < cols
      ? linked
      : plain.length < cols
        ? plain
        : metaParts(`${sessionId.slice(0, 20)}…`).join(' · ')
  return (
    // Hosted panes pin BOTH dimensions: without the width the root sizes to
    // its widest child (the unwrapped meta line) and smears rows across the
    // terminal; without the fixed height an over-estimated transcript slice
    // grows the root past the pane and the host clips the footer off. Fixed,
    // the squeeze resolves inside (the overflow-hidden viewport absorbs it).
    <Box
      flexDirection="column"
      // Scrollback mode does NOT fill the terminal: the frame is only as tall
      // as the live tail plus the footer, and it grows downward from wherever
      // the last flushed row left the cursor. A minHeight here would hold the
      // composer at the bottom of the screen with a screenful of blank canvas
      // above it, and every flushed row would push that blank block down. The
      // browser is the opposite: it fills the alt screen it took over.
      minHeight={windowed ? Math.max(0, rows - bottomSlack) : undefined}
      backgroundColor={theme.canvas}
    >
      {/* The settled transcript, printed once into the terminal's own
          scrollback and never repainted — which is what makes the wheel, the
          trackpad, and select/copy work natively above the live frame. Empty
          (and inert) in a hosted pane, which can't own the scrollback, and
          while the browser holds the alt screen. */}
      {!windowed && (
        <Static items={staticRows}>
          {(row) => (
            // Flushed rows are frozen: no selection marker, no live tick, no
            // pulse — every one of those repaints, and a printed row can't
            // repaint. `seconds` is 0 and `pulseOn` true so a row that WAS
            // live prints in its settled state.
            <RowLine key={row.id} row={row} cols={cols} selected={false} marker={false} seconds={0} pulseOn />
          )}
        </Static>
      )}
      {/* Top padding — see the termRows comment: absorbs terminal row-
          accounting quirks and the post-exit sign-off so the first content
          line never scrolls out of the window. */}
      {padRows > 0 && <Box height={padRows} flexShrink={0} />}
      {/* The one-line opener is the whole banner — the rest of the session
          identity (dashboard link, model, version) lives in the footer meta
          line, so nothing is printed to scrollback before the app. */}
      {/* The chat window: ONE flat list of rows, sliced to exactly the rows
          that fit. Everything lives in it — the startup block, the
          transcript, in-flight sends, the live activity lines — so nothing
          can render past the frame and every line on screen is scrollable.
          Dim markers count what is out of frame above/below, and they sit
          inside the budget so they never push a row out. justify-end puts a
          short transcript's slack ABOVE the rows, so a new session's messages
          hug the composer and grow upward; a full window is unaffected —
          rowViewport already emits exactly the rows that fit. */}
      <Box
        flexDirection="column"
        // Scrollback mode sizes the live region to its content: it must not
        // claim the terminal's leftover height, or the composer would sit at
        // the bottom of the screen with blank canvas above it.
        flexGrow={windowed ? 1 : 0}
        flexShrink={1}
        overflow="hidden"
        justifyContent="flex-end"
      >
        {windowed && view.showAbove && (
          <Text color={theme.muted} wrap="truncate">
            {`   ↑ ${view.hiddenAbove} more line${view.hiddenAbove === 1 ? '' : 's'} above`}
          </Text>
        )}
        {(windowed ? allRows.slice(view.start, view.end) : liveRows).map((row) => (
          <RowLine
            key={row.id}
            row={row}
            cols={cols}
            // Every row of the selected BLOCK, tool rows included: the ▶ marks
            // one of them, and the rest read "→ to expand" on their clamp hint.
            selected={navKey !== null && navKeyOf(row) === navKey}
            marker={row.id === markerRowId}
            // Both ticking values are passed as constants to rows that don't
            // use them, so React.memo skips those rows entirely: the
            // once-a-second clock and the pulse repaint the live lines, not
            // the whole window.
            seconds={row.tick ? (row.tick === 'tool' ? toolElapsed : elapsed) : 0}
            pulseOn={row.pulse ? pulseOn : true}
          />
        ))}
        {windowed && view.showBelow && (
          <Text color={theme.muted} wrap="truncate">
            {`   ↓ ${view.hiddenBelow} more line${view.hiddenBelow === 1 ? '' : 's'} below`}
          </Text>
        )}
      </Box>
      {/* flexShrink=0: when a mis-estimated transcript slice overflows the
          fixed pane, the squeeze lands on the (overflow-hidden) viewport
          above, never on the composer/meta rows. */}
      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        {/* The notice is budgeted at its wrapped height (noticeRows) and
            pinned to it, so an unbounded one (a stream error, an API error
            detail) can't grow the frame past the pane. */}
        {shownNotice && noticeRows > 0 && (
          <Box height={noticeRows} flexShrink={0} overflow="hidden">
            <Text color={theme.muted}>· {shownNotice}</Text>
          </Box>
        )}
        {/* The composer: the input area on the elevated surface — one step
            lighter (the active surface) while it's where you are (focused, no
            transcript highlight), matching the transcript's selection
            treatment. The tint is the whole frame — no rules — so the panel
            reads as lifted off the canvas rather than fenced in by lines. A
            uniform 1-cell pad keeps the text off all four edges, and because
            it's inside the tinted Box the gutter carries the panel color too.
            The panel is pinned to the rows budgeted for it, and clips: a pane
            too short for the whole input scrolls it (below) rather than
            painting the overflow across the meta line. */}
        {composerVisible && (
          <Box
            backgroundColor={focused && navKey === null ? SURFACE_ACTIVE : SURFACE_ELEVATED}
            height={composerRows}
            flexShrink={0}
            overflow="hidden"
            // Squeezed, the panel shows the END of the input, not the start:
            // the caret is where you're typing, so that's the part to keep on
            // screen.
            alignItems="flex-end"
            // The vertical pad is the first thing to go in a pane too short
            // for the whole panel — the input's own row is never negotiable.
            paddingY={composerRows >= COMPOSER_INTERIOR_ROWS + 2 ? 1 : 0}
            paddingX={COMPOSER_PAD_X}
          >
            {/* One parent Text so a multi-line input flows as a single block
                (sibling Texts in a row Box would render as columns). The
                caret is the inverse cell at the cursor, hidden while the
                transcript has focus (navKey) and while the pane itself is
                unfocused (the sidebar has the keyboard). A caret sitting on
                a newline renders as an inverse space at that line's end. The
                key remounts the node on every content change: ink reuses the
                previous measurement when nested text mutates in place, and
                the stale (narrower) width wraps the caret onto the border
                row below. */}
            {/* The prompt is the selection glyph while the composer is where
                you are (focused, no transcript highlight) — the same cyan
                marker as everywhere else — and dim when it isn't. */}
            {/* The explicit colour on the parent is what the bare text
                children below inherit — ink would otherwise leave the typed
                text on the terminal's default foreground, unreadable against
                the panel on a light theme — and it gives the inverse caret a
                known pair of colours to swap. */}
            <Text
              key={`${composer.text}:${composer.cursor}:${focused && navKey === null}`}
              color={theme.foreground}
            >
              <Text color={focused && navKey === null ? theme.cursor : theme.muted}>
                {SELECTION_GLYPH}{' '}
              </Text>
              {composer.text.slice(0, composer.cursor)}
              {focused && navKey === null && (
                <Text inverse>
                  {composer.cursor < composer.text.length &&
                  composer.text[composer.cursor] !== '\n'
                    ? composer.text[composer.cursor]
                    : ' '}
                </Text>
              )}
              {composer.cursor < composer.text.length
                ? focused && navKey === null && composer.text[composer.cursor] !== '\n'
                  ? composer.text.slice(composer.cursor + 1)
                  : composer.text.slice(composer.cursor)
                : ''}
            </Text>
          </Box>
        )}
        <Text color={theme.muted}>{metaLine}</Text>
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

// The rule printed into scrollback above a session that replaced another in the
// same terminal: two conversations otherwise run together, and the second's
// opening line reads as the first's next turn. Names the session it opens, since
// that is the thing the reader needs to know about the text below it.
function sessionBreakRow(sessionId: string, cols: number): TranscriptRow {
  const label = ` ${sessionId} `
  const rule = '─'.repeat(Math.max(0, contentWidth(cols) - visibleWidth(label)))
  return {
    id: `break:${sessionId}`,
    entryKey: `break:${sessionId}`,
    spans: [
      { text: label, dim: true },
      { text: rule, dim: true },
    ],
  }
}

// One or more SGR mouse reports (\x1b[<button;x;yM), and nothing else — ink's
// key parser doesn't recognise them and would pass them through as text (the
// leading escape of the first report is already stripped by ink).
const MOUSE_SEQ_RE = /^(?:\u001B?\[<\d+;\d+;\d+[Mm])+$/

// The startup block as screen rows: the "Connected" opener, then the
// session-first hierarchy on its message panel —
//     ✻ Session starting…
//       ✻ Sandbox starting…
//         ✓ Preparing image · incremental build · 3.4s
//         ✻ Running setup…
// While in progress the whole hierarchy shows, the live level ticking with its
// log tail. Once ready it collapses to the bare headline; highlighting it (↑
// from the composer) and pressing → reveals the config + sandbox lines, →
// again opens the phase panel, →/← on a phase shows/hides its logs. Its rows
// sit at the top of the same flat list as everything else, so it scrolls out
// of frame like any other content.
function sandboxRows(o: {
  sandbox: SandboxState | null
  infraActivity: string | null
  settled: boolean
  expanded: boolean
  cols: number
}): TranscriptRow[] {
  const { sandbox, infraActivity, settled, cols } = o
  const key = SANDBOX_KEY
  const rows: TranscriptRow[] = []
  const width = contentWidth(cols)
  // Every row of the block reserves the standard gutter, so the ▶ marker lands
  // in the headline's mark slot when the block is highlighted — the same
  // treatment every other entry gets.
  const line = (spans: RowSpan[], extra: Partial<TranscriptRow> = {}): void => {
    rows.push({ id: `${key}:r${rows.length}`, entryKey: key, spans, ...extra })
  }
  // The conversation's opening line: where it lives. Plain text — an OSC 8
  // hyperlink here gets broken by ink's wrapping and swallows the label; the
  // clickable dashboard link lives in the footer meta line. It introduces the
  // block rather than being part of the startup story, so it keeps its own ✦
  // and never takes the selection marker — the headline below does.
  rows.push({
    id: `${key}:hdr`,
    entryKey: key,
    spans: [{ text: '✦ Connected to ellipsis.dev', bold: true }],
  })
  rows.push(spacerRow(key, `${key}:hdr-sp`))
  const ready = (sandbox?.done ?? false) && !infraActivity
  // A live status word overrides a stale done-headline: on a wake the status
  // flips before the new session_starting record lands, and "Session ready!"
  // must not linger.
  const headline = ready
    ? (sandbox?.headline ?? '')
    : `${(!sandbox || sandbox.done ? (infraActivity ?? 'Session starting') : sandbox.headline).replace(/…$/, '')}…`
  line(
    [
      // The settled headline ("Session ready!") reads bold in the default
      // foreground over the dim trace beneath it; while starting it stays dim
      // like the rest of the block.
      { text: fit(headline, width - 18), dim: !ready, bold: ready },
    ],
    {
      gutter: {
        text: ready ? '✓' : LIVE_GLYPH,
        color: ready ? theme.success : theme.foreground,
      },
      // While starting, the headline pulses and carries the elapsed clock.
      ...(ready ? {} : { tick: 'elapsed' as const, pulse: true }),
    },
  )

  // The log, ONE level under the headline: no phase tree, no per-phase tails,
  // no drilling. While the session is coming up you see the last
  // SANDBOX_LOG_ROWS lines of everything that has happened — including build
  // and setup output, which is the whole point of showing it — headed by a
  // count of what scrolled past. Once it settles the block collapses to the
  // bare headline, and → re-opens the same log to re-read it.
  if (!sandbox) return rows
  const show = settled && !o.expanded ? [] : lastLines(sandbox.log, SANDBOX_LOG_ROWS)
  const hidden = sandbox.log.length - show.length
  if (show.length > 0 && hidden > 0) {
    line([
      { text: '  ' },
      { text: `… +${hidden} earlier line${hidden === 1 ? '' : 's'}`, dim: true },
    ])
  }
  for (const entry of show) {
    // A milestone still open pulses; output lines and closed milestones are
    // plain dim trace. Marks stay in one column, so the log reads as a list.
    const live = entry.kind === 'step' && !sandbox.sandboxDone
    const mark: RowSpan =
      entry.kind === 'failed'
        ? { text: '✗', color: theme.error }
        : entry.kind === 'output'
          ? { text: ' ' }
          : live
            ? { text: LIVE_GLYPH, color: theme.foreground, pulse: true }
            : { text: '✓', color: theme.success };
    line(
      [
        { text: '  ' },
        mark,
        { text: ' ' },
        {
          text: fit(entry.text, width - 5),
          color: entry.kind === 'failed' ? theme.error : undefined,
          dim: entry.kind !== 'failed',
        },
      ],
      live ? { pulse: true } : {},
    )
  }
  return rows
}

// The tail of the startup log: the last `max` lines, which is what you want
// while a session comes up — the newest output, not the oldest. Pure, for
// tests.
export function lastLines(log: readonly SandboxLogLine[], max: number): SandboxLogLine[] {
  return log.length <= max ? [...log] : log.slice(log.length - max)
}

// A single line, truncated to `width` visible columns — the startup block's
// lines are structural (indent + mark + label), so an over-long one is cut
// rather than reflowed onto a row the layout didn't account for.
function fit(text: string, width: number): string {
  return fitLines(text, Math.max(4, width))[0] ?? ''
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

// Lines of the startup log the block shows: the last ten, which is enough to
// watch an image build or a setup hook make progress without the block taking
// over the chat window. Anything older is counted in the "… +N earlier lines"
// head above them.
const SANDBOX_LOG_ROWS = 10

// One line of the startup log: a milestone (a phase opening or closing, the
// config resolving, the box coming up) or a line of output from whatever the
// sandbox was running. They all live in ONE flat list in feed order, because
// that is how they happened and how you read them.
export type SandboxLogKind = 'step' | 'output' | 'done' | 'failed'
export type SandboxLogLine = {
  key: string
  kind: SandboxLogKind
  text: string
}

// The startup story as a HEADLINE plus a FLAT LOG.
//
// It used to be a three-level tree (session → sandbox → phases → each phase's
// own log tail), drilled into with →. That shape hid the thing you actually
// want when a session is slow to come up — the build output — three keystrokes
// deep, and it split one chronological story across separate per-phase tails.
// Now every milestone and every line of build/setup output goes into one
// ordered list, and the block shows the LAST few (SANDBOX_LOG_ROWS) of it.
export type SandboxState = {
  // The current top-level line ("Session scheduled…", "Session starting…",
  // "Waking the session…", "Retrying…", "Session ready!").
  headline: string
  done: boolean
  // Whether the sandbox itself has finished provisioning, so the log's live
  // lines stop pulsing.
  sandboxDone: boolean
  // The agent config resolved at scheduling, held apart from the log because it
  // outlives a restart: the log drops on a retry/wake, but which config the
  // session runs is still true. Rendered as the log's first line.
  configName: string | null
  // The commit of the config file in the repo it's owned at (the sync
  // provenance), when the backend sends it. Shortened for display.
  configCommitSha: string | null
  // Everything that happened during this start, oldest first.
  log: SandboxLogLine[]
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

// The chat is a LOG of the session: what was said, and what happened to the
// session while it was being said. So the milestones — it went to sleep, it is
// waking again, it was cancelled — land in the transcript, in feed order,
// alongside the conversation (see SESSION_LOG_RECORDS). Without them a session
// that naps between turns leaves an unexplained gap, and the only account of
// the wake is the startup block up top silently rewriting itself.
//
// Each turn's closing `result` summary is dropped: its duration and cost are
// bookkeeping, not conversation — the footer's running spend is where that
// story lives. An error summary survives as its own (red) line under a plain
// label: a failed turn is content. Pure, for tests.
export function reshapeTranscript(
  records: readonly LifecycleRecordLike[],
  minRenderFeedSeq: number,
): { items: TranscriptItem[] } {
  const items: TranscriptItem[] = []
  // Index of the "Waking the session…" line still awaiting its outcome, so the
  // resumed record can settle it in place instead of adding a second row. The
  // line KEEPS ITS KEY, so settling it doesn't move the scroll anchor or the
  // ↑/↓ walk.
  let wakeAt = -1
  for (const r of records) {
    if (r.feed_seq <= minRenderFeedSeq) continue
    if (r.source === 'lifecycle') {
      if (r.record_type === 'session_resumed' && wakeAt >= 0) {
        items[wakeAt] = { ...items[wakeAt], text: 'Session awake' }
        wakeAt = -1
        continue
      }
      const text = sessionLogText(r)
      if (text) {
        items.push({ key: `s${r.feed_seq}`, kind: 'notice', text, spaceBefore: true })
        wakeAt = text === 'Waking the session…' ? items.length - 1 : -1
      }
      continue
    }
    const isResult = r.source === 'claude_code' && r.payload.type === 'result'
    // recordToItems reads only the structural slice (source, record_type,
    // payload); its SessionRecordWire param type isn't exported from the
    // SDK's store entry, hence the cast.
    for (const item of recordToItems(
      r as Parameters<typeof recordToItems>[0],
      `s${r.feed_seq}`,
    )) {
      if (item.kind === 'summary' && isResult) {
        if (item.isError) items.push({ ...item, text: 'turn ended with an error' })
        continue
      }
      items.push(item)
    }
  }
  return { items }
}

// The session milestones worth a line in the chat log, and how each reads.
// Deliberately a SHORT list of state changes a reader would otherwise be left
// guessing about:
//   - the session parked between turns
//   - it is coming back up (a wake, or an infra retry after a wobble)
//   - it was stopped or cancelled
// Everything else the lifecycle feed carries is startup detail (sandbox phases,
// setup log chunks, per-phase timings) and belongs to the startup block up top,
// not the conversation — logging it would bury the chat in provisioning noise.
//
// A wake is ONE line, not two: "Waking the session…" is the same event as
// "Session awake" a few seconds later, so reshapeTranscript settles the waking
// line in place rather than adding a second row under it.
//
// `session_ready`-style milestones are deliberately absent for a FIRST start:
// the startup block already tells that story in place. A wake is different —
// it happens long after the block settled, mid-conversation. Pure, for tests.
export function sessionLogText(record: LifecycleRecordLike): string | null {
  const p = record.payload
  switch (record.record_type) {
    case 'session_idle':
      return 'Session asleep'
    case 'session_starting': {
      // Only a WAKE is logged: the first start is the startup block's story.
      const wake = typeof p.wake_index === 'number' ? p.wake_index : 0
      const attempt = typeof p.attempt === 'number' ? p.attempt : 0
      if (attempt > 0) return 'Restarting the sandbox after a transient error…'
      return wake > 0 ? 'Waking the session…' : null
    }
    case 'session_retrying':
      return typeof p.reason === 'string' && p.reason
        ? `Retrying · ${p.reason}`
        : 'Retrying after a transient error…'
    case 'session_resumed':
      return 'Session awake'
    case 'session_cancelled': {
      const reason = typeof p.reason === 'string' && p.reason ? ` · ${p.reason}` : ''
      return `Session cancelled${reason}`
    }
    default:
      return null
  }
}

// Whether a turn is IN FLIGHT (a turn_started record without its
// turn_completed/turn_failed), and which silence it is: 'boot' when the
// harness has emitted NOTHING this execution — Claude Code is still starting
// up in the sandbox, the ~15-20s dead air after a send lands a fresh
// execution's first turn — vs 'turn', a running turn's lull between records.
// null when no turn is in flight, which INCLUDES the bare interactive
// session sitting at 'working' status waiting for its first message (no
// turn, no Claude Code process — nothing to narrate). Drives the fallback
// live line so a send never looks like the app hung. Pure, for tests.
export function awaitingAgentPhase(
  records: readonly LifecycleRecordLike[],
): 'boot' | 'turn' | null {
  let inFlight = false
  let sawAgent = false
  for (const r of records) {
    if (r.source === 'claude_code') {
      sawAgent = true
    } else if (r.source === 'lifecycle') {
      if (r.record_type === 'turn_started') inFlight = true
      else if (r.record_type === 'turn_completed' || r.record_type === 'turn_failed') {
        inFlight = false
      } else if (
        r.record_type === 'session_starting' ||
        r.record_type === 'session_retrying'
      ) {
        // A fresh execution: no turn is in flight and the harness must boot
        // again before it speaks.
        inFlight = false
        sawAgent = false
      }
    }
  }
  if (!inFlight) return null
  return sawAgent ? 'turn' : 'boot'
}

// Sends the agent has TAKEN but not yet echoed into the transcript: each
// message_received body, walked through delivered/requeued transitions, minus
// the ids whose user-echo record (session_message_id back-reference) has
// landed. The store's pending set drops a message the instant it's delivered,
// but the agent's echo record can lag by a whole sandbox wake — without this
// bridge a send flashes and vanishes for the gap. Rendered as full-colour
// user rows at the transcript's bottom edge (the mid-turn send is part of the
// running turn, Claude Code-style).
//
// `cancelled` means the turn that took the message DIED without answering it —
// the /stop path, where the backend deliberately does not requeue an
// interrupted turn's messages (the message is consumed, the answer never
// comes). Rendered "cancelled" rather than left breathing forever, which is the
// bug this distinction fixes. A message_requeued instead puts the message back
// in the inbox, so it is queued again, not cancelled. Pure, for tests.
export function deliveredUnechoedSends(
  records: readonly LifecycleRecordLike[],
): { id: string; body: string; cancelled: boolean }[] {
  const received = new Map<string, string>()
  // Message id -> the turn that consumed it, for the turn_failed correlation.
  const delivered = new Map<string, string>()
  const failedTurns = new Set<string>()
  const echoed = new Set<string>()
  for (const r of records) {
    if (r.session_message_id != null) echoed.add(r.session_message_id)
    if (r.source !== 'lifecycle') continue
    if (r.record_type === 'turn_failed') {
      if (typeof r.payload.turn_id === 'string') failedTurns.add(r.payload.turn_id)
      continue
    }
    const id = typeof r.payload.message_id === 'string' ? r.payload.message_id : null
    if (!id) continue
    if (r.record_type === 'message_received') {
      if (!received.has(id))
        received.set(id, typeof r.payload.body === 'string' ? r.payload.body : '')
    } else if (r.record_type === 'message_delivered') {
      delivered.set(id, typeof r.payload.turn_id === 'string' ? r.payload.turn_id : '')
    } else if (r.record_type === 'message_requeued') delivered.delete(id)
  }
  const out: { id: string; body: string; cancelled: boolean }[] = []
  for (const [id, body] of received) {
    const turnId = delivered.get(id)
    if (turnId === undefined || echoed.has(id)) continue
    out.push({ id, body, cancelled: failedTurns.has(turnId) })
  }
  return out
}

// A duration in seconds as compact human-readable components. Precision
// scales down with size: under 1s reads as milliseconds ("428ms"), under 5s
// keeps one decimal ("1.2s", trimming a trailing .0), and everything longer
// reads as whole h/m/s components with zero parts dropped ("10s", "1m 2s",
// "2m", "1h 3m 30s"). The one duration format everywhere in the app, and it
// reads bare — a readout, not a parenthetical aside. Pure, for tests.
export function humanDuration(seconds: number): string {
  const clamped = Math.max(0, seconds)
  if (clamped === 0) return '0s'
  if (clamped < 1) return `${Math.round(clamped * 1000)}ms`
  if (clamped < 5) {
    const s = clamped.toFixed(1)
    return s.endsWith('.0') ? `${Math.round(clamped)}s` : `${s}s`
  }
  const total = Math.round(clamped)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const bits: string[] = []
  if (h > 0) bits.push(`${h}h`)
  if (m > 0) bits.push(`${m}m`)
  if (s > 0 || bits.length === 0) bits.push(`${s}s`)
  return bits.join(' ')
}

function msLabel(ms: unknown): string | null {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return null
  return humanDuration(ms / 1000)
}

// The image phase's provisioning sub-steps as sentences: the Modal
// dockerfile build, the Sandbox.create container start (minutes for a
// multi-GB image), and the post-create smoke test. The step vocabulary is
// open by contract, so unknown steps pass through verbatim.
function imageStepLabel(step: string): string {
  switch (step) {
    case 'build':
      return 'Building image'
    case 'container':
      return 'Starting container'
    case 'smoke':
      return 'Smoke check'
    default:
      return step
  }
}

// Human label for a timeline step: hooks sub-items keep their hook phrasing,
// image sub-items read as sentences, other sub-items (a clone's
// "owner/repo") read as themselves, whole phases go through the SDK's
// open-vocabulary phase labels.
function stepLabel(phase: string, step: string | null): string {
  if (step) {
    if (phase === 'hooks') return hookPhrase(step)
    if (phase === 'image') return imageStepLabel(step)
    return step
  }
  return sandboxPhaseLabel(phase)
}

// The startup story from the lifecycle records of the LATEST start: a headline
// tracking the session's own state ("Session scheduled…" → "Session starting…"
// / "Waking…" / "Retrying…" → "Session ready!"), plus ONE FLAT LOG of
// everything that happened on the way up, in feed order — the config
// resolving, each provisioning phase opening and closing (with its cache tier
// and duration), and every line of output those phases produced (image builds,
// clones, setup hooks).
//
// session_starting begins a fresh story: a wake or an infra retry drops the
// previous start's log rather than appending to it. null when no lifecycle
// record has been seen. Pure, for tests.
export function deriveSandboxState(
  records: readonly LifecycleRecordLike[],
  minFeedSeq: number,
): SandboxState | null {
  let seen = false
  let headline = 'Session starting…'
  let done = false
  let sandboxDone = false
  let configName: string | null = null
  let configCommitSha: string | null = null
  let log: SandboxLogLine[] = []
  // Phases still open, so a `completed`/`failed` transition can close the line
  // it opened rather than adding a second one.
  let open = new Map<string, SandboxLogLine>()
  const push = (record: LifecycleRecordLike, kind: SandboxLogKind, text: string): SandboxLogLine => {
    const entry = { key: `${record.feed_seq}:${log.length}`, kind, text }
    log.push(entry)
    return entry
  }
  const reset = (): void => {
    log = []
    open = new Map()
    sandboxDone = false
  }

  for (const record of records) {
    if (record.feed_seq <= minFeedSeq || record.source !== 'lifecycle') continue
    const p = record.payload
    switch (record.record_type) {
      case 'session_scheduled': {
        seen = true
        headline = 'Session scheduled…'
        done = false
        configName = typeof p.config_name === 'string' && p.config_name ? p.config_name : null
        configCommitSha =
          typeof p.config_commit_sha === 'string' && p.config_commit_sha
            ? p.config_commit_sha
            : null
        break
      }
      case 'session_starting':
      case 'session_retrying': {
        seen = true
        // Every claim starts a fresh story: the headline takes over and the
        // previous start's log drops.
        headline = lifecycleText(record.record_type, p) ?? 'Session starting…'
        done = false
        reset()
        break
      }
      case 'session_resumed': {
        seen = true
        // The wake mounted its snapshots and the conversation continues — the
        // session-level outcome, same beat as ready on a fresh start.
        headline = 'Session ready!'
        done = true
        break
      }
      case 'session_idle': {
        seen = true
        headline = 'Session asleep'
        done = true
        break
      }
      case 'sandbox_starting': {
        seen = true
        reset()
        push(record, 'step', 'Starting sandbox…')
        break
      }
      case 'sandbox_phase': {
        seen = true
        const phase = typeof p.phase === 'string' && p.phase ? p.phase : 'setup'
        const step = typeof p.step === 'string' && p.step ? p.step : null
        const key = step ? `${phase}:${step}` : phase
        const label = stepLabel(phase, step)
        if (p.status === 'completed' || p.status === 'failed') {
          const detail =
            p.detail && typeof p.detail === 'object' ? (p.detail as Record<string, unknown>) : {}
          // "Preparing image, full build, 2s" — the label then its readout,
          // comma-separated like every other metadata line in the app.
          const tier = cacheTierLabel(detail.cache_tier)
          const dur = msLabel(p.duration_ms)
          const failed = p.status === 'failed'
          const base = failed ? `${label} failed` : label
          const text = [base, ...(tier ? [tier] : []), ...(dur ? [dur] : [])].join(', ')
          const line = open.get(key)
          if (line) {
            // Close the line this phase opened, in place: one line per phase,
            // not an opening line and a closing one.
            line.kind = failed ? 'failed' : 'done'
            line.text = text
            open.delete(key)
          } else {
            push(record, failed ? 'failed' : 'done', text)
          }
        } else if (!open.has(key)) {
          open.set(key, push(record, 'step', `${label}…`))
        }
        break
      }
      case 'sandbox_output': {
        seen = true
        for (const l of sandboxOutputLines(p)) push(record, 'output', l)
        break
      }
      case 'sandbox_ready': {
        seen = true
        // Anything still open finished when the box came up.
        for (const [, line] of open) line.kind = 'done'
        open = new Map()
        const timings =
          p.phase_timings && typeof p.phase_timings === 'object'
            ? Object.values(p.phase_timings as Record<string, unknown>)
            : []
        const totalSeconds = timings.reduce<number>(
          (acc, v) => (typeof v === 'number' && isFinite(v) ? acc + v : acc),
          0,
        )
        const tier = cacheTierLabel(p.cache_tier)
        push(
          record,
          'done',
          [
            'Sandbox ready',
            ...(tier ? [tier] : []),
            ...(totalSeconds > 0 ? [humanDuration(totalSeconds)] : []),
          ].join(', '),
        )
        sandboxDone = true
        // The box coming up is the session-level outcome too.
        headline = 'Session ready!'
        done = true
        break
      }
      default:
        break
    }
  }
  // The config line heads the log: it is the first thing that was decided, and
  // it survives the restarts that clear everything below it.
  const full: SandboxLogLine[] = configName
    ? [
        {
          key: 'config',
          kind: 'done',
          text: `Using ${configName}${configCommitSha ? ` @ ${configCommitSha.slice(0, 7)}` : ''}`,
        },
        ...log,
      ]
    : log
  return seen ? { headline, done, sandboxDone, configName, configCommitSha, log: full } : null
}

// One screen row. Exactly one terminal line by construction: the text was
// pre-fitted to the pane (see transcriptRows), and wrap="truncate" is the
// belt-and-braces guarantee — a row that wrapped would push every row below it
// down and slide the window out of sync with the scroll position.
//
// Selection is carried by the cyan ▶ in the gutter and NOTHING else: no tint,
// no recolored text. A highlight bar across a multi-row block is a lot of paint
// for "you are here", and it fought with the one panel tint that still means
// something (a message you sent). The marker is one glyph and unmistakable.
const RowLine = React.memo(function RowLine({
  row,
  cols,
  selected,
  marker,
  seconds,
  pulseOn,
}: {
  row: TranscriptRow
  cols: number
  // This row belongs to the selected BLOCK. It changes nothing visually — only
  // which key the "+N lines" hint names (→ vs ctrl+r).
  selected: boolean
  // Whether THIS row carries the ▶ marker in its gutter. Every row of the
  // selected block is `selected`, but only one is the marker row — see
  // markerRowId.
  marker: boolean
  // The row's ticking duration, resolved here so the once-a-second tick
  // repaints this line instead of rebuilding the transcript's rows.
  seconds: number
  // The shared pulse phase (see PULSE_MS). Only a pulsing row reads it, so
  // the blink repaints the live lines and leaves the rest of the window alone.
  pulseOn: boolean
}): React.ReactElement {
  const background = row.panel ? SURFACE_ELEVATED : undefined
  // The "+N lines" marker's hint names the key that actually opens it: → when
  // the line is highlighted, ctrl+r otherwise.
  const spans: RowSpan[] = row.clampedLines
    ? [
        {
          text: `… +${row.clampedLines} lines (${selected ? '→' : 'ctrl+r'} to expand)`,
          dim: true,
        },
      ]
    : row.spans
  // Every span, gutter mark and right-hand readout below paints an explicit
  // brand colour: `spanColor` resolves the pulse's off beat, a `dim` span and a
  // span with no colour of its own onto real hexes, so nothing on the row is
  // left to the terminal's own palette. See its comment in transcriptRows.
  const markColor = (span: RowSpan): string => spanColor(span, pulseOn)
  // The right-hand metadata column reads as plain prose — "23s, 4 tokens", no
  // parentheses and no interpuncts. It is a readout, not an aside.
  const right = row.tick
    ? { text: [humanDuration(seconds), row.right?.text].filter(Boolean).join(', '), dim: true }
    : row.right
  // height=1 is load-bearing: a blank row (a spacer, or a message panel's pad)
  // has no text, and ink collapses an empty Box to zero height — the row would
  // silently vanish, leaving the window short of the rows the scroll math
  // counted. A tinted row also paints its background across the FULL pane
  // width, so the panel reads as a block, not a ragged strip behind the text.
  return (
    <Box width={cols} height={1} flexShrink={0} backgroundColor={background}>
      <Box width={MESSAGE_PAD} flexShrink={0} />
      {row.indent ? <Box width={row.indent} flexShrink={0} /> : null}
      <Box width={GUTTER_COLS} flexShrink={0}>
        {/* The gutter glyph, or the selection marker in its place on the one
            marker row — same 1-char slot, so text never shifts when the
            highlight lands.
            A live row's mark pulses by DIMMING on the off beat: the glyph
            itself never changes, so the column holds still and the eye reads
            a heartbeat rather than a character swapping in and out. */}
        <Text
          color={marker ? theme.cursor : row.gutter ? markColor(row.gutter) : theme.foreground}
          wrap="truncate"
        >
          {marker ? SELECTION_GLYPH : (row.gutter?.text ?? '')}
        </Text>
      </Box>
      {/* A ⎿ item's extra breathing room, on every row of it so a wrapped
          result stays aligned under its first line. */}
      {row.textPad ? <Box width={row.textPad} flexShrink={0} /> : null}
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text wrap="truncate">
          {spans.map((span, i) => (
            <Text key={i} color={markColor(span)} bold={span.bold}>
              {span.text}
            </Text>
          ))}
        </Text>
      </Box>
      {right && (
        <Box flexShrink={0} paddingLeft={1}>
          <Text color={markColor(right)} wrap="truncate">
            {right.text}
          </Text>
        </Box>
      )}
      <Box width={MESSAGE_PAD} flexShrink={0} />
    </Box>
  )
})
