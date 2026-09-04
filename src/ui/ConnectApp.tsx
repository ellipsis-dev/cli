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
  awaitingAgentPhase,
  collapseToolRuns,
  deliveredUnechoedSends,
  foldCosts,
  groupRecordsToChatTurns,
  humanDuration,
  lastLines,
  pendingToolCalls,
  recordSlice,
  sandboxSummary,
  statusActivityText,
  type SandboxState,
  type SessionTranscriptStore,
} from '@ellipsis-dev/sdk/store'
import { deriveSandboxState } from '../lib/steps'
import { chatTurnsToItems, undisplayedRecordCount } from '../lib/chatItems'
import { errorDetail } from '../lib/api'
import type { Ellipsis, SdkRecord } from '@ellipsis-dev/sdk'
import { hyperlink } from '../lib/urls'
import { usdNumberFromMillicents } from '../lib/output'
import { applyEditShortcut } from '../lib/editing'
import { CTRL_C_QUIT_HINT, useCtrlCQuit } from './ctrlC'
import { fitLines, visibleWidth } from '../lib/markdown'
import { SELECTION_GLYPH } from '../lib/sessions'
import { inputSurface, theme } from '../lib/theme'
import {
  completedText,
  isCommandInput,
  matchCommands,
  resolveCommand,
  type SlashCommand,
} from './commands'
import { VERSION } from '../lib/constants'
import {
  activityRows,
  BRANCH_GLYPH,
  BRANCH_TEXT_PAD,
  contentWidth,
  GUTTER_COLS,
  isAgentSpeech,
  isToolActivity,
  itemRows,
  layOutItems,
  LIVE_GLYPH,
  MESSAGE_PAD,
  NEST_INDENT,
  pendingMessageRows,
  settledItemKeys,
  settledRowCount,
  spacerRow,
  spanColor,
  USER_BAR,
  type RowSpan,
  type TranscriptRow,
} from './transcriptRows'

// The interactive `agent session connect` UI, modelled on Claude Code: a
// committed transcript that groups tool calls with their results and spaces
// messages apart — live activity (✻ Running/Generating) rendered on the
// transcript block it describes — above a footer with a composer that echoes
// what you send. Rendering shape lives in @ellipsis-dev/sdk/store (pure); this
// component owns the data flow, the composer, and the colours.
//
// ONE VIEW of the transcript: settled rows are handed to <Static>, which prints
// them ONCE into the terminal's own scrollback and never repaints them. That is
// what makes wheel/trackpad scrolling, select/copy and clickable links work
// natively — they are the terminal's, not reimplementations. The price is that a
// printed row is frozen: it cannot re-wrap or re-fold. Only the unsettled tail
// plus the footer repaint.
//
// There used to be a second, windowed view on the alternate screen (ctrl+r) that
// bought back repaintability — entry navigation, folding, app-read scrolling. It
// cost a scroll/anchor/selection machine bigger than the chat itself for a screen
// that duplicated what the terminal's own scrollback already shows, so it is
// gone. Long bodies stay clamped, and their full text is up in the scrollback.
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
  // The session's automation (resolved name, falling back to the config
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
  // Hand focus to the host's session picker. Fired by esc, and by ↓ at the
  // bottom edge (the composer's last line, or a watch-only follow). Absent in
  // the solo app, which has no picker to open.
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

// Horizontal breathing room inside the composer panel. With the panel inset by
// MESSAGE_PAD and its accent bar taking one column, this lands the composer's
// text in the same column as a transcript message's text.
const COMPOSER_PAD_X = 1

// The startup block's entry key — it is one block, not a transcript item, so it
// owns a fixed key rather than a feed_seq one.
const SANDBOX_KEY = 'sandbox'

// Gap between the footer's status fields — whitespace, no glyph.
const META_SEP = '   '

// Half the period of the live ⏺ pulse: the glyph dims for this long, then
// brightens for this long. ~1.4s a cycle — slow enough to read as breathing
// rather than flashing, and it lands off the 1s duration tick so the two
// don't visibly beat against each other.
const PULSE_MS = 700

// Columns the composer's text actually gets: the pane's message pad on both
// sides, the panel's horizontal pad on both sides, then the accent bar down its
// left edge.
function composerTextCols(cols: number): number {
  return Math.max(8, cols - MESSAGE_PAD * 2 - COMPOSER_PAD_X * 2 - 1)
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
  // How many undisplayable records you've already been told about, so the
  // footer warning clears on your next send and only returns if MORE arrive.
  const [undisplayedSeen, setUndisplayedSeen] = useState(0)
  // The slash-command menu's highlighted index. The menu itself is derived from
  // what is typed (see `menu` below) rather than stored — it is open exactly when
  // the line starts with `/` and something still matches — so this is the only
  // state it needs, and it resets to the top whenever the matches change.
  const [menuIndex, setMenuIndex] = useState(0)
  // The composer's text and caret position (0..text.length), one state so
  // rapid keypresses between renders can't desync them. Left/right move the
  // caret, up/down walk the lines of a multi-line input like a normal text
  // editor.
  const [composer, setComposer] = useState({ text: '', cursor: 0 })
  // Local ✦ lines in the transcript, for things the CLIENT did that the record
  // log will never carry: so far, /stop. It belongs in the conversation because
  // it is an event in the conversation — the notice bar above the composer is
  // for transient status, and scrolls away with nothing to show you asked.
  const [chatNotes, setChatNotes] = useState<readonly { key: string; text: string }[]>([])
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

  // The committed transcript: the SDK's shared ChatTurn grouping (the same
  // turns the dashboard's chat renders — tool calls paired with results,
  // failed turns marked), mapped onto the terminal's item vocabulary.
  // store.chatTurns() memoizes on the records array identity; --no-records
  // (minRenderFeedSeq > 0) groups a filtered slice instead, since turns don't
  // carry feed_seq.
  // The sandbox story is excluded: it renders as the one-line progress block
  // up top, not as transcript rows. Each turn's closing duration/cost summary
  // is dropped too — the footer carries the session's spend.
  const { items, undisplayed } = useMemo(() => {
    const turns =
      props.minRenderFeedSeq > 0
        ? groupRecordsToChatTurns(
            snapshot.records.filter((r) => r.feed_seq > props.minRenderFeedSeq),
          )
        : store.chatTurns()
    const items = chatTurnsToItems(turns)
    // Client-side notes land at the end: they describe what you just did, so
    // they belong under everything the server has sent so far.
    for (const note of chatNotes) {
      items.push({ key: note.key, kind: 'notice', text: note.text, spaceBefore: true })
    }
    return {
      items,
      undisplayed: undisplayedRecordCount(snapshot.records, props.minRenderFeedSeq),
    }
  }, [snapshot.records, props.minRenderFeedSeq, chatNotes, store])

  // Footer spend: the server's ledger total (the session frame's four cost
  // columns — the billing authority, resent on every cost tick) with the
  // CC-result fold as the last-turn readout and older-backend fallback (§6:
  // record folding is display-only).
  const cost = useMemo(
    () =>
      foldCosts(
        snapshot.records
          .filter((r) => r.source === 'claude_code')
          .map((r) => r.payload as SdkRecord),
      ),
    [snapshot.records],
  )
  const serverCostUsd = snapshot.session
    ? usdNumberFromMillicents(snapshot.session.cost?.total ?? 0)
    : null

  // The sandbox startup timeline, derived from the lifecycle records of the
  // latest start (a session_starting wake/retry or sandbox_starting record
  // resets it, so a wake tells a fresh story): a live headline, plus ONE FLAT
  // LOG of every milestone and every line of build/setup output, newest last.
  // While the session comes up the block shows the tail of that log; once ready
  // it collapses to a static one-line summary of the start, and → while
  // highlighted re-opens the log to re-read it. The block persists after startup
  // as the durable trace (the sandbox_ready transcript notice is suppressed
  // below in its favour).
  const sandbox = useMemo(
    () => deriveSandboxState(recordSlice(snapshot.records), props.minRenderFeedSeq),
    [snapshot.records, props.minRenderFeedSeq],
  )
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
  const awaitingAgent = useMemo(() => awaitingAgentPhase(recordSlice(snapshot.records)), [snapshot.records])

  // Sends the agent took mid-gap: delivered to the agent but its user-echo
  // transcript record hasn't landed yet (the echo can lag by a whole sandbox
  // wake). Rendered as full-colour user rows until the echo replaces them.
  const acceptedSends = useMemo(
    () => deliveredUnechoedSends(recordSlice(snapshot.records)),
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
      setUndisplayedSeen(undisplayed)
      // A leading slash claims the line for the CLI. An unknown one is REFUSED,
      // not forwarded: a typo'd command sent on as prose is a message you did
      // not mean to send, and the agent cannot tell it from one you did.
      if (isCommandInput(text)) {
        const command = resolveCommand(text)
        if (!command) {
          setNotice(`✗ no such command: ${text.split(/\s/)[0]}, type / to see them`)
          return
        }
        if (command.id === 'exit') {
          exit()
          return
        }
        if (command.id === 'sessions') {
          if (props.onFocusNav) props.onFocusNav()
          else setNotice('no other sessions here, this is a single-session connect')
          return
        }
      }
      // /stop is the one command that talks to the server, so it rides the async
      // path below with the sends.
      const stopping = resolveCommand(text)?.id === 'stop'
      void (async () => {
        try {
          if (stopping) {
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
    [api, exit, pump, sessionId, undisplayed, props.onFocusNav],
  )

  // The composer renders whenever sending is possible.
  const composerVisible = canSend && isRawModeSupported
  const inputActive = composerVisible && focused

  // The slash-command menu: the commands the typed line still matches. Derived,
  // not stored, so it cannot get out of step with the input — it is open exactly
  // while the line starts with `/` and something matches, and typing a character
  // that matches nothing closes it (the line is then just prose, and submit will
  // say so).
  const menu = useMemo(
    () => (composerVisible ? matchCommands(composer.text) : []),
    [composerVisible, composer.text],
  )
  const menuOpen = menu.length > 0
  // Clamped rather than stored-and-corrected: the matches shrink as you type, and
  // an index left pointing past the end would highlight nothing.
  const menuAt = Math.min(menuIndex, Math.max(0, menu.length - 1))
  // Back to the top whenever the match set changes, so the highlight is on the
  // best match for what you have typed rather than wherever it was left.
  useEffect(() => {
    setMenuIndex(0)
  }, [menu.length])
  const complete = useCallback((command: SlashCommand): void => {
    const text = completedText(command)
    setComposer({ text, cursor: text.length })
  }, [])

  // The rendered transcript lines, in order: consecutive tool activity folds
  // into "Ran N …" notices, so a turn's work reads as one line instead of a
  // wall of calls.
  const visible = useMemo(() => {
    const pendingKeys = new Set(pendingTools.map((t) => t.key))
    const base = pendingKeys.size ? items.filter((i) => !pendingKeys.has(i.key)) : items
    return collapseToolRuns(base)
  }, [items, pendingTools])

  const infraActivity = statusActivityText(statusWord)
  // The startup story has settled: the start finished and nothing is live. This
  // is when the block collapses to its static one-line summary.
  const sandboxSettled = (sandbox?.done ?? false) && !infraActivity
  // How the pane's rows are divided: the footer (notice + composer + meta
  // line) is fixed, the chat window takes the rest, and the top padding is the
  // give — it shrinks, to nothing if it must, so the frame always fits.
  //
  // Fitting is not cosmetic: an over-tall frame scrolls ink's render region and
  // smears stale rows up the terminal. So the window's budget is whatever is
  // left AFTER the footer, never a floor that could exceed the pane.
  // ctrl+c interrupts the turn, then quits: the first press sends the same
  // /stop the composer's command does, the second exits. Active whenever this
  // pane owns the keyboard, watch-only follows included (nothing to stop there,
  // but ctrl+c still has to be the way out).
  const ctrlCArmed = useCtrlCQuit(
    isRawModeSupported && focused && (composerVisible || !hasHost),
    () => {
      if (working && canSend) submit('/stop')
    },
  )
  // Armed, the meta line below the composer becomes the ctrl+c prompt (it
  // says what a second press does), and the arm expires after a few seconds.
  const shownNotice = notice
  const { viewBudget, composerRows, noticeRows, menuRows } = useMemo(() => {
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
      ? Math.max(0, Math.min(fitLines(shownNotice, cols).length, free - 2))
      : 0
    free -= noticeRows
    // The command menu, one row per match, budgeted like everything else: it
    // renders INSIDE the frame, so rows it takes are rows the chat yields. In a
    // terminal with no room for it the list is cut short rather than pushing the
    // composer off the bottom.
    const menuRows = Math.max(0, Math.min(menu.length, free - 3))
    free -= menuRows
    // The composer: its interior grows with the input, plus the 1-cell pad above
    // and below. In a terminal too short for all of it the pad goes, then the
    // interior shrinks toward a single row.
    const typedRows = fitLines(composer.text, composerTextCols(cols)).length
    const wanted = Math.max(COMPOSER_INTERIOR_ROWS, typedRows) + 2
    const composerRows = composerVisible ? Math.max(1, Math.min(wanted, free - 1)) : 0
    return {
      viewBudget: Math.max(1, free - composerRows),
      composerRows,
      noticeRows,
      menuRows,
    }
  }, [rows, cols, bottomSlack, composerVisible, composer.text, shownNotice, menu.length])

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
    // Whether the activity line hugs the block above it: when the trailing fold
    // ("Ran N …", key grp:*) is the same burst the pending call belongs to.
    const last = visible[visible.length - 1]
    const hug =
      last != null &&
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
    working,
    infraActivity,
    awaitingAgent,
    sendPending,
  ])

  // EVERY row the chat window can show, top to bottom: the startup block, the
  // committed transcript, then the tail that only exists while a turn is live
  // (accepted sends, the streaming response, the activity line, queued sends).
  // The tail rides in the same list rather than rendering below the window, so
  // it can't overflow the frame.
  const allRows = useMemo(() => {
    const out: TranscriptRow[] = []
    if (infraActivity || sandbox) {
      out.push(...sandboxRows({ sandbox, infraActivity, settled: sandboxSettled, cols }))
    }
    // Tool activity is nested under the message that produced it (layOutItems
    // decides what hangs off what), so a call and its result read as work the
    // agent did mid-message rather than as turns of their own.
    for (const placed of layOutItems(visible)) {
      out.push(
        ...itemRows(placed.item, cols, {
          indent: placed.nested ? NEST_INDENT : 0,
          nested: placed.nested,
          attach: placed.attach,
        }),
      )
    }
    // Sends the agent has TAKEN (delivered, echo record still in flight):
    // full-colour barred rows ABOVE the live activity — the running turn is the
    // response to THIS message, so its stream belongs below it.
    for (const q of inFlightSends.filter((q) => q.state === 'accepted')) {
      out.push(
        ...pendingMessageRows(q.key, q.text, cols, {
          gutter: USER_BAR,
          gutterColor: theme.cursor,
          bold: true,
        }),
      )
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
          gutter: USER_BAR,
          gutterColor: theme.cursor,
          dim: true,
          right: 'queued',
        }),
      )
    }
    for (const q of inFlightSends.filter((q) => q.state !== 'accepted')) {
      out.push(
        // Every send keeps the sender's bar, waiting or not — it is your
        // message either way. The right-hand label carries the state.
        ...pendingMessageRows(q.key, q.text, cols, {
          gutter: USER_BAR,
          gutterColor: theme.cursor,
          dim: true,
          right: q.state === 'sending' ? 'sending' : q.state === 'queued' ? 'queued' : 'cancelled',
        }),
      )
    }
    return out
  }, [
    infraActivity,
    sandbox,
    sandboxSettled,
    visible,
    inFlightSends,
    pendingPrompt,
    liveTail,
    cols,
  ])

  // ---- the scrollback split ----
  // Rows whose content is FINAL go to <Static>: printed once, into the
  // terminal's own scrollback, never repainted. Everything after them is the
  // live region, repainted each frame. See settledItemKeys for what "final"
  // means and why it is decided per message rather than per turn.
  //
  // The startup block is final once it has settled (it collapses to its static
  // summary then, so the flushed copy is the one that lasts). It sits at the
  // top of the list, so nothing below it can flush while it is still moving.
  const settledKeys = useMemo(() => {
    const keys = settledItemKeys(visible, working)
    if (sandboxSettled) keys.add(SANDBOX_KEY)
    return keys
  }, [visible, working, sandboxSettled])
  // The rows already handed to <Static>, held APPEND-ONLY in a ref, and the
  // entries they covered. Both are needed, and neither can be replaced by
  // re-slicing allRows each frame:
  //
  //   * <Static> prints `items.slice(printedCount)` and re-syncs printedCount
  //     from items.length. So the list may only GROW, and the rows already in it
  //     may never change. Hand it a shorter list and it re-prints everything.
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
  {
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

  const insertAtCursor = useCallback((ch: string): void => {
    setComposer(({ text, cursor }) => ({
      text: text.slice(0, cursor) + ch + text.slice(cursor),
      cursor: cursor + ch.length,
    }))
  }, [])

  useInput(
    (ch, key) => {
      // The command menu is the INNERMOST modal, so it takes its keys before
      // anything else: ↑/↓ walk it, tab/enter complete the highlighted command,
      // esc dismisses it by clearing the slash that opened it. Everything else
      // (typing, editing, ctrl+*) falls through to the composer below, which is
      // what keeps the menu a suggestion rather than a mode you get stuck in.
      if (menuOpen) {
        if (key.upArrow || key.downArrow) {
          const next = key.upArrow ? menuAt - 1 : menuAt + 1
          // Wraps, because the list is short enough that walking off one end
          // meaning "go to the other" is faster than reversing direction.
          setMenuIndex((next + menu.length) % menu.length)
          return
        }
        if (key.tab) {
          complete(menu[menuAt])
          return
        }
        // Enter COMPLETES rather than submits while the line is still a partial
        // command ("/tr"), and submits once it names one exactly ("/transcript"):
        // otherwise enter on a highlighted suggestion would refuse the very
        // command the menu is pointing at.
        if (key.return && !resolveCommand(composer.text)) {
          complete(menu[menuAt])
          return
        }
        if (key.escape) {
          setComposer({ text: '', cursor: 0 })
          return
        }
      }
      if (key.escape) {
        // Hosted: hand focus to the session nav (stopping is the composer's
        // /stop command). Solo: esc-while-working keeps meaning stop.
        if (props.onFocusNav) props.onFocusNav()
        else if (working) submit('/stop')
        return
      }
      // Below here are the composer's own keys. Watch-only (no composer): ↓
      // leaves for the session nav; everything else is inert.
      if (!composerVisible) {
        if (key.downArrow && props.onFocusNav) props.onFocusNav()
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
        // Up inside a multi-line input climbs a line; on line 1 there is
        // nowhere to go — the transcript above is the terminal's scrollback,
        // which its own keys and wheel move.
        const up = cursorLineUp(composer.text, composer.cursor)
        if (up !== null) setComposer((c) => ({ ...c, cursor: up }))
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

  // The persistent footer status line: status, running spend, model,
  // session id (the dashboard link), automation (when the session has
  // one), CLI version. Per-step costs live on the transcript's metadata
  // column, so the footer carries the total alone. Command hints live in
  // --help. The total prefers the server's ledger figure (live via the
  // session frames' cost columns, climbing mid-turn); the CC-derived result
  // total is the fallback against older backends.
  const totalStr = `$${(serverCostUsd ?? cost.total ?? 0).toFixed(2)}`
  // Sized to fit by construction: Ink measures the OSC-8 hyperlink's
  // invisible URL bytes as width, so a linked id only ships when the whole
  // line — escape bytes included — fits the pane; otherwise the line renders
  // as plain text, cut to the pane with a … if even that overflows. Never
  // rely on Ink wrapping/truncating this line: it's budgeted at exactly one
  // row.
  const metaParts = (id: string): string[] => [
    statusWord,
    `${totalStr} total`,
    ...(props.model ? [props.model] : []),
    id,
    ...(props.configName ? [props.configName] : []),
    `v${VERSION}`,
  ]
  // Narrow panes shed fields from the right (version, then config, session
  // id, model) and keep the status and the spend.
  const allParts = metaParts(sessionId)
  let kept = allParts.length
  while (kept > 2 && allParts.slice(0, kept).join(META_SEP).length >= cols) kept--
  const plain = allParts.slice(0, kept).join(META_SEP)
  const linked = metaParts(hyperlink(props.sessionUrl, sessionId))
    .slice(0, kept)
    .join(META_SEP)
  // Records that arrived but rendered nothing take the whole line: a shape this
  // build can't read means the transcript is lying about what was said, which
  // outranks the spend and the session id. It holds the line until the next
  // send, and a further drop brings it back with the new count.
  const undisplayedNew = Math.max(0, undisplayed - undisplayedSeen)
  const dropWarning =
    undisplayedNew > 0
      ? `${undisplayedNew} ${undisplayedNew === 1 ? 'event' : 'events'} could not be displayed, this CLI may be out of date`
      : null
  const body = ctrlCArmed ? CTRL_C_QUIT_HINT : (dropWarning ?? plain)
  const pad = Math.max(0, Math.floor((cols - body.length) / 2))
  // Ink measures the hyperlink's invisible URL bytes as width, so the link
  // only ships when padding plus escape bytes still fit the row; the padding
  // gives way first, then the link itself.
  const linkedPad =
    ctrlCArmed || dropWarning ? -1 : Math.min(pad, cols - 1 - linked.length)
  const metaLine =
    linkedPad >= 0
      ? `${' '.repeat(linkedPad)}${linked}`
      : `${' '.repeat(pad)}${body.length < cols ? body : `${body.slice(0, Math.max(0, cols - 1))}…`}`
  return (
    // Hosted panes pin BOTH dimensions: without the width the root sizes to
    // its widest child (the unwrapped meta line) and smears rows across the
    // terminal; without the fixed height an over-estimated transcript slice
    // grows the root past the pane and the host clips the footer off. Fixed,
    // the squeeze resolves inside (the overflow-hidden viewport absorbs it).
    <Box
      flexDirection="column"
      // The frame does NOT fill the terminal: it is only as tall as the live
      // tail plus the footer, and it grows downward from wherever the last
      // flushed row left the cursor. A minHeight here would hold the composer at
      // the bottom of the screen with a screenful of blank rows above it, and
      // every flushed row would push that block down.
    >
      {/* The settled transcript, printed once into the terminal's own
          scrollback and never repainted — which is what makes the wheel, the
          trackpad, and select/copy work natively above the live frame. */}
      <Static items={staticRows}>
        {(row) => (
          // Flushed rows are frozen: no live tick, no pulse — both repaint, and
          // a printed row can't. `seconds` is 0 and `pulseOn` true so a row that
          // WAS live prints in its settled state.
          <RowLine key={row.id} row={row} cols={cols} seconds={0} pulseOn />
        )}
      </Static>
      {/* The live region: the unsettled tail of the same flat row list — the
          startup block while it runs, the streaming response, in-flight sends,
          the live activity lines. It is sized to its content and grows downward,
          so it must not claim the terminal's leftover height. */}
      <Box
        flexDirection="column"
        flexGrow={0}
        flexShrink={1}
        overflow="hidden"
        justifyContent="flex-end"
      >
        {liveRows.map((row) => (
          <RowLine
            key={row.id}
            row={row}
            cols={cols}
            // Both ticking values are passed as constants to rows that don't
            // use them, so React.memo skips those rows entirely: the
            // once-a-second clock and the pulse repaint the live lines, not
            // the whole window.
            seconds={row.tick ? (row.tick === 'tool' ? toolElapsed : elapsed) : 0}
            pulseOn={row.pulse ? pulseOn : true}
          />
        ))}
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
            <Text color={theme.muted}>{shownNotice}</Text>
          </Box>
        )}
        {/* The slash-command menu, directly above the input it completes: one
            row per match, the highlighted one wearing the same cyan ▶ as every
            other selection in the app. It sits inside the budgeted rows
            (menuRows), so a long list is cut rather than pushing the composer
            off the bottom of the frame. */}
        {menuRows > 0 && (
          <Box flexDirection="column" height={menuRows} flexShrink={0} overflow="hidden">
            {menu.slice(0, menuRows).map((command, i) => (
              <Box key={command.id} width={cols}>
                <Text wrap="truncate">
                  <Text color={theme.cursor}>{i === menuAt ? SELECTION_GLYPH : ' '}</Text>{' '}
                  <Text
                    color={i === menuAt ? theme.foreground : theme.muted}
                    bold={i === menuAt}
                  >{`/${command.name}`}</Text>
                  <Text color={theme.muted}>{`  ${command.detail}`}</Text>
                </Text>
              </Box>
            ))}
          </Box>
        )}
        {/* The composer. It is pinned to the rows budgeted for it and clips, so a
            terminal too short for the whole input scrolls it rather than painting
            the overflow across the meta line. */}
        {composerVisible && (
          <Box
            backgroundColor={inputSurface}
            // The accent bar down the left edge, exactly as the launcher's
            // prompt box wears it — one input, one shape, both screens.
            borderStyle="bold"
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            borderLeftColor={focused ? theme.cursor : theme.muted}
            // Inset like a transcript row, so the bar lands in the same column
            // as a message's ┃ gutter.
            marginLeft={MESSAGE_PAD}
            marginRight={MESSAGE_PAD}
            height={composerRows}
            flexShrink={0}
            overflow="hidden"
            // Squeezed, it shows the END of the input, not the start: the caret
            // is where you're typing, so that's the part to keep on screen.
            alignItems="flex-end"
            // The vertical pad is the first thing to go in a terminal too short
            // for the whole input — its own row is never negotiable.
            paddingY={composerRows >= COMPOSER_INTERIOR_ROWS + 2 ? 1 : 0}
            paddingX={COMPOSER_PAD_X}
          >
            {/* One parent Text so a multi-line input flows as a single block
                (sibling Texts in a row Box would render as columns). The
                caret is the inverse cell at the cursor, hidden while the pane
                itself is unfocused (the sidebar has the keyboard). A caret
                sitting on a newline renders as an inverse space at that line's
                end. The key remounts the node on every content change: ink
                reuses the previous measurement when nested text mutates in
                place, and the stale (narrower) width wraps the caret onto the
                border row below. */}
            {/* The explicit colour on the parent is what the bare text children
                below inherit, and it gives the inverse caret a known pair of
                colours to swap. */}
            <Text
              key={`${composer.text}:${composer.cursor}:${focused}`}
              color={theme.foreground}
            >
              {composer.text.slice(0, composer.cursor)}
              {focused && (
                <Text inverse>
                  {composer.cursor < composer.text.length &&
                  composer.text[composer.cursor] !== '\n'
                    ? composer.text[composer.cursor]
                    : ' '}
                </Text>
              )}
              {composer.cursor < composer.text.length
                ? focused && composer.text[composer.cursor] !== '\n'
                  ? composer.text.slice(composer.cursor + 1)
                  : composer.text.slice(composer.cursor)
                : ''}
            </Text>
          </Box>
        )}
        <Text color={dropWarning && !ctrlCArmed ? theme.error : theme.muted}>{metaLine}</Text>
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
// when the caret is already on the first line — there is nowhere further up to
// go. Pure, for tests.
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

// The startup block as screen rows, in TWO forms.
//
// While the agent comes up it is LIVE — the "Connected" opener, a ticking
// headline, and the tail of the startup log under it:
//     ✦ Connected to ellipsis.dev
//
//     ⏺ Starting cloud agent…                                            12s
//       ✓ Preparing image, incremental build, 3.4s
//       ⏺ Running setup…
//         npm install
//
// Once it settles it becomes a STATIC record of one past event — a cloud agent
// was started — compressed the way a tool call is, and it never moves again:
//     ✦ Cloud agent session on ellipsis.dev
//       ⎿  Sandbox ready in 42s
//
// Live status (asleep/awake) deliberately stays OUT of it: the block narrates
// the start, and a session that fell asleep an hour later says so on its own
// transcript line and in the footer. A header that rendered live status told an
// old session's reader "Session asleep" as its opening line, which is not what
// happened first.
function sandboxRows(o: {
  sandbox: SandboxState | null
  infraActivity: string | null
  settled: boolean
  cols: number
}): TranscriptRow[] {
  const { sandbox, infraActivity, settled, cols } = o
  const key = SANDBOX_KEY
  const rows: TranscriptRow[] = []
  const width = contentWidth(cols)
  // Every row of the block reserves the standard gutter, so its marks line up
  // with every other entry's.
  const line = (spans: RowSpan[], extra: Partial<TranscriptRow> = {}): void => {
    rows.push({ id: `${key}:r${rows.length}`, entryKey: key, spans, ...extra })
  }
  // The opening line. Plain text — an OSC 8 hyperlink here gets broken by ink's
  // wrapping and swallows the label; the clickable dashboard link lives in the
  // footer meta line. Live it reads as an address ("Connected to…"); settled it
  // names the event the block stands for.
  rows.push(spacerRow(key, `${key}:hdr-top`))
  rows.push({
    id: `${key}:hdr`,
    entryKey: key,
    // The ✦ rides the GUTTER, like every other row's mark. Baked into the text
    // span it sits one gutter-width right of every glyph below it, which reads
    // as a stray indent on the app's very first line.
    gutter: { text: '✦', dim: true },
    spans: [
      {
        text: fit(
          settled ? 'Cloud agent session on ellipsis.dev' : 'Connected to ellipsis.dev',
          width,
        ),
        bold: true,
      },
    ],
  })
  if (settled) {
    // The whole start, compressed to ONE branch line under the opener — the
    // same idiom as a collapsed tool run ("Ran 3 shell commands"). No elapsed
    // clock, no live glyph, nothing that can change after the fact.
    line(
      [{ text: fit(sandboxSummary(sandbox), width - NEST_INDENT - BRANCH_TEXT_PAD), dim: true }],
      { gutter: { text: BRANCH_GLYPH, dim: true }, indent: NEST_INDENT, textPad: BRANCH_TEXT_PAD },
    )
  } else {
    rows.push(spacerRow(key, `${key}:hdr-sp`))
    // A live status word overrides a stale headline: on a wake the status flips
    // before the new session_starting record lands.
    const headline = `${(!sandbox || sandbox.done ? (infraActivity ?? 'Starting cloud agent') : sandbox.headline).replace(/…$/, '')}…`
    line([{ text: fit(headline, width - 18), dim: true }], {
      gutter: { text: LIVE_GLYPH, color: theme.foreground },
      // While starting, the headline pulses and carries the elapsed clock.
      tick: 'elapsed' as const,
      pulse: true,
    })
  }

  // The log, ONE level under the opener: no phase tree, no per-phase tails, no
  // drilling. While the agent is coming up you see the last SANDBOX_LOG_ROWS
  // lines of everything that has happened — including build and setup output,
  // which is the whole point of showing it — headed by a count of what scrolled
  // past. Once it settles the block collapses to its summary line; the log
  // itself stays up in the scrollback, where it was printed.
  if (!sandbox) return rows
  const show = settled ? [] : lastLines(sandbox.log, SANDBOX_LOG_ROWS)
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

// A single line, truncated to `width` visible columns — the startup block's
// lines are structural (indent + mark + label), so an over-long one is cut
// rather than reflowed onto a row the layout didn't account for.
function fit(text: string, width: number): string {
  return fitLines(text, Math.max(4, width))[0] ?? ''
}

// Lines of the startup log the block shows: the last ten, which is enough to
// watch an image build or a setup hook make progress without the block taking
// over the chat window. Anything older is counted in the "… +N earlier lines"
// head above them.
const SANDBOX_LOG_ROWS = 10

// One screen row. Exactly one terminal line by construction: the text was
// pre-fitted to the pane (see transcriptRows), and wrap="truncate" is the
// belt-and-braces guarantee — a row that wrapped would push every row below it
// down and misalign the rows the frame budgeted for.
const RowLine = React.memo(function RowLine({
  row,
  cols,
  seconds,
  pulseOn,
}: {
  row: TranscriptRow
  cols: number
  // The row's ticking duration, resolved here so the once-a-second tick
  // repaints this line instead of rebuilding the transcript's rows.
  seconds: number
  // The shared pulse phase (see PULSE_MS). Only a pulsing row reads it, so
  // the blink repaints the live lines and leaves the rest of the window alone.
  pulseOn: boolean
}): React.ReactElement {
  // A clamped body says how much it cut, and nothing more: there is no key that
  // un-clamps it, and the full text is up in the scrollback where it printed.
  const spans: RowSpan[] = row.clampedLines
    ? [{ text: `… +${row.clampedLines} lines`, dim: true }]
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
  // height=1 is load-bearing: a blank separator row has no text, and ink
  // collapses an empty Box to zero height — the row would silently vanish,
  // leaving the frame short of the rows it budgeted for.
  //
  // No background: a row prints into the terminal's scrollback and is never
  // repainted, so any fill it carries is permanent and cannot be kept in step
  // with a frame that resizes or shrinks. Everything structural is carried by
  // the gutter glyph and foreground colour instead.
  return (
    <Box width={cols} height={1} flexShrink={0}>
      <Box width={MESSAGE_PAD} flexShrink={0} />
      {row.indent ? <Box width={row.indent} flexShrink={0} /> : null}
      <Box width={GUTTER_COLS} flexShrink={0}>
        {/* The row's sender glyph. A live row's mark pulses by DIMMING on the
            off beat: the glyph itself never changes, so the column holds still
            and the eye reads a heartbeat rather than a character swapping in
            and out. */}
        <Text
          color={row.gutter ? markColor(row.gutter) : theme.foreground}
          wrap="truncate"
        >
          {row.gutter?.text ?? ''}
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
