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
  // The clickable dashboard link for this session (app.ellipsis.dev/…/sessions/{id}),
  // shown in the footer status line.
  sessionUrl: string
  // A one-line caveat shown as the app's opening notice (e.g. "watch-only:
  // this conversation is closed"). null for the normal connect.
  initialNotice?: string | null
  // The session's model (backend tokens_model, fixed at creation), shown in
  // the footer meta line.
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
  useEffect(() => {
    if (!stdout) return
    const onResize = (): void => setTermRows(stdout.rows)
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
  const [input, setInput] = useState('')
  // ctrl+r toggles full vs. collapsed tool output across the whole transcript.
  const [expanded, setExpanded] = useState(false)
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
  // setup… · <latest output line>" → "Ready!"); ctrl+s opens the step list
  // and arrow keys drill into a step's logs (a running step shows a live
  // 5-line tail, a finished one its stored log). The block persists after
  // startup as the durable trace (the sandbox_ready transcript notice is
  // suppressed below in its favour).
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
  useInput(
    (ch, key) => {
      if (key.return) {
        submit(input)
        return
      }
      if (key.escape) {
        // Modal-first: an open sandbox panel closes before esc means "stop".
        if (sandboxOpen) {
          setSandboxOpen(false)
          setStepLogsOpen(false)
          return
        }
        if (working) submit('/stop')
        return
      }
      if (key.ctrl && ch === 'r') {
        setExpanded((v) => !v)
        return
      }
      // ctrl+s opens the sandbox step list; ↑/↓ pick a step, → opens its
      // logs, ← closes them. Opening lands on the newest (= running) step.
      if (key.ctrl && ch === 's') {
        setSandboxOpen((v) => !v)
        setStepLogsOpen(false)
        setStepCursor(Math.max(0, (sandbox?.steps.length ?? 0) - 1))
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
          setStepLogsOpen(false)
          return
        }
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
  // bodies). In-flight calls are excluded from the collapsed fold — they render
  // as the live "Running …" line appended right below (see runningTool), so the
  // fold only counts what actually ran. The pieces are memoized on
  // [items, expanded] (pendingTools derives from items), so the elapsed-second
  // ticks reuse the same elements and don't re-lay-out the transcript.
  const { lines, runningHug } = useMemo(() => {
    const pendingKeys = new Set(pendingTools.map((t) => t.key))
    const visible = expanded
      ? items
      : collapseToolRuns(pendingKeys.size ? items.filter((i) => !pendingKeys.has(i.key)) : items)
    const last = visible[visible.length - 1]
    return {
      lines: visible.map((item) => (
        <TranscriptLine key={item.key} item={item} expanded={expanded} />
      )),
      // Whether the live "Running …" line should hug the block above it: in
      // expanded mode the pending ● call itself is the last line; collapsed,
      // only when the trailing fold ("Ran N …", key grp:*) is the same burst
      // the pending call belongs to — otherwise the line opens its own block.
      runningHug: expanded ? pendingKeys.size > 0 : (last?.key.startsWith('grp:') ?? false),
    }
  }, [items, expanded, pendingTools])

  // The persistent footer status line: the current status, the running spend
  // (cumulative total + the last turn's cost), and the session identity — the
  // dashboard link rendered as the session id, the model, and the CLI version.
  // Command hints live in --help. The total prefers the server's ledger figure
  // (live via the session frames' cost columns, climbing mid-turn); the
  // CC-derived result total is the fallback against older backends.
  const totalStr = `$${(serverCostUsd ?? cost.total ?? 0).toFixed(2)}`
  const lastStepStr = cost.lastStep != null ? ` (Last step: $${cost.lastStep.toFixed(2)})` : ''
  const metaLine = [
    `${statusWord} · ${totalStr} total${lastStepStr}`,
    hyperlink(props.sessionUrl, sessionId),
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
  const infraActivity = statusActivityText(statusWord)
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
          one line under it, rewritten in place as phases pass. ctrl+s swaps
          the line for the full step list; →/← on a step shows/hides its logs
          (a live 5-line tail while the step runs). The block stays after
          startup — frozen at "Ready!" — as the durable trace. */}
      {(infraActivity || sandbox) && (
        <Box flexDirection="column">
          <Text>
            <Text color="cyan">✻</Text>{' '}
            <Text dimColor>
              {infraActivity ? `${infraActivity}… (${formatDuration(elapsed)})` : 'Starting sandbox…'}
            </Text>
          </Text>
          {!sandboxOpen && sandboxPhaseLine(sandbox) && (
            <Text>
              {'  '}
              <Text dimColor>
                ⎿ {oneLine(sandboxPhaseLine(sandbox) as string, 110)}
                {inputActive ? ' (ctrl+s: steps)' : ''}
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
                    <Text>
                      {'  '}
                      <Text color="cyan">{selected ? '›' : ' '}</Text>{' '}
                      <Text color={running ? 'cyan' : 'green'}>{running ? '✻' : '✓'}</Text>{' '}
                      <Text dimColor={!selected}>
                        {step.label}
                        {running ? '…' : ''}
                      </Text>{' '}
                      <Text dimColor>
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
              <Text dimColor>{'    '}↑/↓ step · → logs · ← hide logs · ctrl+s collapse</Text>
            </Box>
          )}
        </Box>
      )}
      {/* The transcript grows through the middle of the terminal, pinning the
          composer + meta to the bottom edge (flexGrow fills the slack). */}
      <Box flexDirection="column" flexGrow={1}>
        {lines}
        {/* The live tool-call status, attached to the burst it belongs to: hugs
            the collapsed "Ran N …" fold (or the expanded ● call) above it, and
            disappears into the fold's count once the result lands. */}
        {runningTool && (
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
        {liveText && (
          <Box marginTop={1}>
            <Text>{liveText}</Text>
          </Box>
        )}
        {generating && (
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
