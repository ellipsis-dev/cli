import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink'
import type { OpenSocket } from '@ellipsis-dev/sdk/stream'
import { SESSION_STREAM_PROTOCOL_VERSION } from '@ellipsis-dev/sdk/stream'
import { SessionTranscriptStore } from '@ellipsis-dev/sdk/store'
import type { Ellipsis, Session as FrameSession } from '@ellipsis-dev/sdk'
import { errorDetail } from '../lib/api'
import type {
  AgentSession,
  SavedAgentConfig,
  StartAgentSessionRequest,
  SupportedModel,
} from '../lib/types'
import { applyEditShortcut } from '../lib/editing'
import { CTRL_C_QUIT_HINT, useCtrlCQuit } from './ctrlC'
import { hyperlink, sessionUrl } from '../lib/urls'
import { usdNumberFromMillicents } from '../lib/output'
import {
  applyComposerChoices,
  attentionFlip,
  compactTokens,
  composerModelOptions,
  composerPickerRows,
  configDisplayName,
  connectability,
  type ComposerChoices,
  type ComposerModel,
  rowDescription,
  rowGlyph,
  rowMeta,
  rowStatusWord,
  navSlice,
  sessionBarFilterLabel,
  sessionBarQuery,
  sessionSource,
  SELECTION_GLYPH,
  sidebarSlice,
  mergeSidebarSessions,
} from '../lib/sessions'
import type { ResolvedSessionBar } from '../lib/config'
import { randomFact } from '../lib/facts'
import { inputSurface, theme } from '../lib/theme'
import { useAltScreen } from './altScreen'
import { ConnectApp } from './ConnectApp'

// The multi-session UI — what a bare `agent`, `agent "prompt"`, and `agent
// session connect <id>` all open. It is a set of SCREENS, not a stack of bands:
//
//   * the chat (the ConnectApp) owns the terminal outright. Its settled
//     transcript is printed into the terminal's real scrollback, so the wheel,
//     the trackpad and select/copy are the terminal's own — which is the reason
//     for the screen split. Nothing may be pinned above or below it: rows
//     scrolling past would run straight through any such band.
//   * the session picker (ctrl+j, or esc / ↓ out of the chat) takes over the
//     ALTERNATE screen: the full session list, with the chat left untouched on
//     the primary buffer behind it. enter opens a session and returns.
//   * the transcript browser (ctrl+r, owned by ConnectApp) is the other
//     alternate-screen view: the windowed transcript with folding and ↑/↓ nav,
//     which the scrollback view cannot do.
//   * the new-session composer and the loading placeholder do own their frame,
//     so they keep the header band and the frame inset.
//
// Focus is modal and esc steps outward: inside the chat esc closes the browser,
// then transcript navigation, then opens the picker. Exactly one useInput
// handler is active at a time.
//
// Liveness: ONE WebSocket — the focused session's, owned by its ConnectApp —
// plus a 5s REST poll of the session list for the nav. Transcript stores are
// cached per visited session for the process lifetime, so hopping back
// repaints instantly and the stream resumes past the cached cursor.

const SIDEBAR_POLL_MS = 5_000
// The nav clock driving the "12s" age tags.
const AGE_TICK_MS = 5_000
const NAV_NEW_LABEL = '+ New session'
// The header title pinned to the left edge, and its width — the meta line on
// the right budgets itself against what's left of the row.
const HEADER_TITLE = 'ellipsis.dev'
const TITLE_WIDTH = HEADER_TITLE.length

// Blank cells between the frame and the terminal edge, on all four sides.
// Everything inside lays out against the inset width/height.
const APP_INSET = 1

// Extra indent for the session-nav rows, on top of the app inset — the list
// reads as a distinct column rather than type hanging off the frame edge.
const NAV_GUTTER = 1

// Horizontal breathing room inside the composer panel — wider than the 1-cell
// vertical pad so the caret and text start well clear of the panel edge.
const COMPOSER_PAD_X = 2

// Everything an open picker's option row prints before its label: the row
// indent, the selection cell and its space, then the "[x] " checkbox. What the
// price column has to clear on the left.
const OPTION_GUTTER = '  '.length + 2 + '[x] '.length

export interface SessionsAppProps {
  api: Ellipsis
  openSocket: OpenSocket
  // app.ellipsis.dev base + the customer login, for per-session dashboard links.
  appBase: string
  customerLogin: string
  // My GitHub login for the header's "@me in account" tag; null on an API-key
  // credential, which has no GitHub user behind it.
  ghLogin: string | null
  // My GitHub account id — the sidebar lists sessions attributed to me. null
  // (e.g. an API-key credential) lists the whole account's sessions.
  authorId: number | null
  // The repo detected from the cwd's origin remote ("owner/name"), which is
  // what the server's default resolution checks out — shown as the composer's
  // resting Repository value. null when the cwd isn't an enrolled repo.
  detectedRepo: string | null
  // Open focused on this session (connect / prompt shorthand); undefined
  // opens on the new-session composer (a bare `agent`).
  initialSessionId?: string
  // The start response's resolved config name for the initial session, and a
  // caveat to show in its chat (watch-only reasons ride connectability).
  initialConfigName?: string
  initialNotice?: string
  // Which sessions reach the picker. `hidden` drops it entirely — focus then
  // never leaves the chat, so esc, ↓ at the bottom edge and ctrl+j do nothing.
  // Set under "sessionBar" in the config file.
  sessionBar: ResolvedSessionBar
  // Builds the start request for a composer-spawned session (the entry point
  // owns repository detection and defaults).
  buildStartRequest: (prompt: string) => StartAgentSessionRequest
}

// Everything the chat pane needs for one session, cached across hops.
type ChatEntry = {
  store: SessionTranscriptStore
  canSend: boolean
  notice: string | null
  model: string | null
  configName: string | null
  url: string
}

type MainPane = { type: 'new' } | { type: 'chat'; sessionId: string }

export function SessionsApp(props: SessionsAppProps): React.ReactElement {
  const { api, openSocket, appBase, customerLogin, authorId, sessionBar } = props
  const hideNav = sessionBar.hidden
  const { exit } = useApp()
  const { isRawModeSupported } = useStdin()
  const { stdout } = useStdout()

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
  const height = Math.max(8, termRows - 1)
  // The app inset: one blank cell on all four sides of the whole frame, so
  // nothing sits flush against the terminal edge. Everything lays out inside it,
  // so every width/height below is the INNER box, not the terminal.
  const contentCols = Math.max(20, termCols - APP_INSET * 2)
  const contentRows = Math.max(6, height - APP_INSET * 2)

  // ------------------------------ sidebar data ------------------------------

  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [polledOnce, setPolledOnce] = useState(false)
  // Sessions whose status flipped active → waiting since last viewed: the
  // "an agent is blocked on you" dot. Cleared when the row is opened.
  const [attention, setAttention] = useState<ReadonlySet<string>>(new Set())
  const lastWords = useRef(new Map<string, string>())
  // Composer-spawned sessions the poll may not return yet (created < poll
  // lag, or attributed differently); merged into the list until it does.
  const [localSessions, setLocalSessions] = useState<AgentSession[]>([])

  // The last API failure from any background call (the poll, the composer's
  // pickers). Those calls have no output of their own, so without this a broken
  // route or a dead token just shows an empty list. Rendered in the nav hint
  // row, which is the one line always on screen.
  const [apiError, setApiError] = useState<string | null>(null)
  const reportApiError = useCallback((label: string, err: unknown): void => {
    setApiError(`${label}: ${errorDetail(err)}`)
  }, [])

  const poll = useCallback(async (): Promise<void> => {
    try {
      const listed = (
        await api.sessions.list(
          sessionBarQuery(sessionBar, { authorId, detectedRepo: props.detectedRepo }),
        )
      ).items
      setAttention((prev) => {
        const next = new Set(prev)
        for (const s of listed) {
          const word = rowStatusWord(s)
          if (attentionFlip(lastWords.current.get(s.id), word)) next.add(s.id)
          lastWords.current.set(s.id, word)
        }
        return next.size === prev.size ? prev : next
      })
      setSessions(listed)
      setLocalSessions((prev) => prev.filter((l) => !listed.some((s) => s.id === l.id)))
      setPolledOnce(true)
      setApiError(null)
    } catch (err) {
      // Keep the previous list (the next tick retries), but say so: a poll that
      // fails every tick is a broken session list, not a blip.
      reportApiError('sessions', err)
    }
  }, [api, authorId, reportApiError, sessionBar, props.detectedRepo])

  // The poll only feeds the nav's rows and attention dots; with the bar
  // hidden there is nothing on screen it could update.
  useEffect(() => {
    if (hideNav) return
    void poll()
    const t = setInterval(() => void poll(), SIDEBAR_POLL_MS)
    return () => clearInterval(t)
  }, [poll, hideNav])

  // The age lines tick on their own clock (nothing else re-renders idle rows).
  const [, setAgeTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setAgeTick((n) => n + 1), AGE_TICK_MS)
    return () => clearInterval(t)
  }, [])

  // Cloud sessions only. A laptop session is a local `claude` run synced up for
  // the record; opening one here has nothing to connect to, so it would be a
  // dead row taking a slot from a session worth showing. Client-side because
  // it holds whatever `sessionBar.sources` says.
  const rows = useMemo(
    () => mergeSidebarSessions(sessions, localSessions).filter((s) => sessionSource(s) !== 'laptop'),
    [localSessions, sessions],
  )

  // ------------------------------ focus + panes -----------------------------

  // Both openings start with the main pane focused: a connect lands you in
  // the conversation, a bare `agent` lands you in the new-session composer.
  // 'nav' = the session picker owns the keyboard, which now means it is OPEN:
  // the session list is a screen of its own on the alternate buffer (ctrl+j, or
  // ↓/esc out of the chat) rather than a band pinned under every frame.
  //
  // It moved there because the chat gave up its viewport: the transcript is
  // printed into the terminal's real scrollback now, and scrollback is
  // all-or-nothing — a band pinned below the chat would be overwritten by the
  // rows scrolling past it. A screen of its own also gives the list the whole
  // terminal rather than a fixed handful of rows.
  const [focus, setFocus] = useState<'nav' | 'chat'>('chat')
  const navOpen = focus === 'nav' && !hideNav
  useAltScreen(navOpen)
  const [mainPane, setMainPane] = useState<MainPane>(
    props.initialSessionId ? { type: 'chat', sessionId: props.initialSessionId } : { type: 'new' },
  )
  // The nav highlight: 'new' or a session id. Tracks ids, not indices, so
  // the poll re-sorting under the cursor doesn't move the highlight.
  const [selected, setSelected] = useState<string>(props.initialSessionId ?? 'new')

  // ------------------------------ chat entries ------------------------------

  const [entries, setEntries] = useState<ReadonlyMap<string, ChatEntry>>(new Map())
  // Sessions whose chat has already printed into this terminal's scrollback.
  // The NEXT one to open prints a rule naming itself first, so two conversations
  // in one scrollback don't run together (see ConnectApp's scrollbackBreak).
  const shownChats = useRef<Set<string>>(new Set())
  const [loadError, setLoadError] = useState<string | null>(null)
  const loading = useRef(new Set<string>())

  // Seed a transcript store exactly like the solo connect: a synthetic
  // snapshot frame (session + open inbox) then the stored records, so the
  // first paint is instant and the stream resumes past the seeded cursor.
  const loadEntry = useCallback(
    async (sessionId: string, configName?: string, notice?: string): Promise<void> => {
      if (loading.current.has(sessionId)) return
      loading.current.add(sessionId)
      setLoadError(null)
      try {
        const [{ session }, page] = await Promise.all([
          api.sessions.get(sessionId),
          api.sessions.records(sessionId).then((p) => p.response),
        ])
        const store = new SessionTranscriptStore()
        const ordered = [...page.records].sort((a, b) => a.feed_seq - b.feed_seq)
        store.ingest({
          type: 'snapshot',
          protocol: SESSION_STREAM_PROTOCOL_VERSION,
          earliest_feed_seq: page.earliest_feed_seq ?? null,
          session,
          messages: page.messages ?? [],
        })
        if (ordered.length) store.ingest({ type: 'records_append', records: ordered })
        const c = connectability(session)
        const entry: ChatEntry = {
          store,
          canSend: c.canSend,
          notice: [notice, c.reason].filter(Boolean).join(' · ') || null,
          model: session.tokens?.model || null,
          configName: configName ?? session.config_id ?? null,
          url: sessionUrl(appBase, customerLogin, sessionId),
        }
        setEntries((prev) => new Map(prev).set(sessionId, entry))
      } catch (err) {
        setLoadError(errorDetail(err))
        loading.current.delete(sessionId)
        return
      }
      loading.current.delete(sessionId)
    },
    [api, appBase, customerLogin],
  )

  // Load the focused session's entry on demand (initial focus included).
  useEffect(() => {
    if (mainPane.type !== 'chat') return
    if (entries.has(mainPane.sessionId)) return
    void loadEntry(
      mainPane.sessionId,
      mainPane.sessionId === props.initialSessionId ? props.initialConfigName : undefined,
      mainPane.sessionId === props.initialSessionId ? props.initialNotice : undefined,
    )
  }, [mainPane, entries, loadEntry, props.initialSessionId, props.initialConfigName, props.initialNotice])

  // ----------------------------- new session flow ---------------------------

  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  // The composer's picker options, fetched once when the new-session pane
  // first opens: the dashboard composer's three choices — saved agent
  // configs, the account's repositories, and the selectable models. A models
  // failure (an older server without GET /models) leaves the list empty
  // and the composer falls back to its built-in set.
  const [configs, setConfigs] = useState<SavedAgentConfig[] | null>(null)
  const [repos, setRepos] = useState<string[] | null>(null)
  const [models, setModels] = useState<SupportedModel[] | null>(null)
  const pickersLoading = useRef(false)
  useEffect(() => {
    if (mainPane.type !== 'new' || pickersLoading.current) return
    pickersLoading.current = true
    void api.agents.configs
      .list()
      .then((rows) => setConfigs(rows.configs))
      .catch((err) => {
        setConfigs([])
        reportApiError('agent configs', err)
      })
    void api.integrations.github
      .repos()
      .then((r) => setRepos(r.repositories.map((repo) => repo.full_name)))
      .catch((err) => {
        setRepos([])
        reportApiError('repositories', err)
      })
    void api.models
      .list()
      .then((r) => setModels(r.models))
      .catch((err) => {
        setModels([])
        reportApiError('models', err)
      })
  }, [mainPane.type, api, reportApiError])

  const startSession = useCallback(
    async (prompt: string, choices: ComposerChoices): Promise<void> => {
      setStarting(true)
      setStartError(null)
      try {
        const req = applyComposerChoices(props.buildStartRequest(prompt), choices)
        const { session, resolved_config_name } = await api.sessions.start(req)
        lastWords.current.set(session.id, rowStatusWord(session))
        setLocalSessions((prev) => [session, ...prev])
        setSelected(session.id)
        setMainPane({ type: 'chat', sessionId: session.id })
        setFocus('chat')
        // Seed the entry from the start response's resolved config identity.
        void loadEntry(session.id, resolved_config_name ?? session.config_id ?? undefined)
      } catch (err) {
        setStartError(errorDetail(err))
      } finally {
        setStarting(false)
      }
    },
    [api, loadEntry, props],
  )

  // -------------------------------- nav input --------------------------------

  const openSelected = useCallback((): void => {
    if (selected === 'new') {
      setMainPane({ type: 'new' })
      setFocus('chat')
      return
    }
    setAttention((prev) => {
      if (!prev.has(selected)) return prev
      const next = new Set(prev)
      next.delete(selected)
      return next
    })
    setMainPane({ type: 'chat', sessionId: selected })
    setFocus('chat')
  }, [selected])

  // The selectable id list, top to bottom: the pinned new row, then sessions.
  const selectable = useMemo(() => ['new', ...rows.map((s) => s.id)], [rows])

  useInput(
    (ch, key) => {
      // The picker is a vertical list: ↑/↓ move the highlight, enter opens the
      // highlighted session, esc (or ↑ off the top row) returns to the chat.
      if (key.upArrow || key.downArrow) {
        const idx = selectable.indexOf(selected)
        if (key.upArrow && idx <= 0) {
          setFocus('chat')
          return
        }
        const next = key.upArrow
          ? Math.max(0, idx - 1)
          : Math.min(selectable.length - 1, idx < 0 ? 0 : idx + 1)
        setSelected(selectable[next])
        return
      }
      if (key.return) {
        openSelected()
        return
      }
      if (key.escape) {
        setFocus('chat')
        return
      }
      if (ch === 'n') {
        setSelected('new')
        setMainPane({ type: 'new' })
        setFocus('chat')
        return
      }
      if (ch === 'q') {
        exit()
        return
      }
    },
    { isActive: focus === 'nav' && isRawModeSupported },
  )

  // ctrl+c quits from the nav and from the panes that aren't a live chat (the
  // new-session form, a chat still loading) — the chat pane owns its own, where
  // the first press also interrupts the running turn.
  const chatOwnsCtrlC = mainPane.type === 'chat' && entries.has(mainPane.sessionId)
  const navArmed = useCtrlCQuit(focus === 'nav' && isRawModeSupported)
  const paneArmed = useCtrlCQuit(focus === 'chat' && !chatOwnsCtrlC && isRawModeSupported)

  // With the session bar hidden there is nothing to hand focus to: esc and ↓
  // at the chat's bottom edge land where they started.
  const focusNav = useCallback((): void => {
    if (!hideNav) setFocus('nav')
  }, [hideNav])
  const refreshOnDone = useCallback((): void => {
    void poll()
  }, [poll])

  // ------------------------------- rendering --------------------------------

  // The session picker, open, owns the whole screen: the header, the
  // "+ New session" row and the hint line, with every remaining row going to
  // sessions. Nothing caps the list any more — the old row cap existed to stop a
  // pinned band from eating the chat, and a screen of its own has no such
  // conflict. `sessionBar` still scopes WHICH sessions are listed.
  const headerRows = 3
  const navSessionRows = Math.max(1, contentRows - headerRows - 3)
  // The pane height the new-session composer and the loading placeholder get:
  // everything under the header. (A live chat is not sized here at all — it owns
  // the terminal and prints into its scrollback.)
  const paneRows = Math.max(4, contentRows - headerRows)

  // ---- the header ----
  // "ellipsis.dev" pins the left edge as always; the right edge carries the
  // focused session's live meta (id · model · cost · tokens), derived from
  // its transcript store so it ticks like the old footer did. With no
  // session focused the right edge falls back to the who-tag.
  //
  // It is NOT pinned above the chat any more. A live chat prints its transcript
  // into the terminal's scrollback, and a band above a scrolling region is
  // simply overwritten by it — the two cannot coexist. So the chat runs
  // headerless (its own footer meta line carries the same identity, which is
  // why hideMetaLine is dropped below) and the header renders on the screens
  // that DO own their frame: the new-session pane and the session picker.
  const focusedEntry = mainPane.type === 'chat' ? entries.get(mainPane.sessionId) : undefined
  const metaText = useHeaderMeta(focusedEntry, mainPane, appBase, customerLogin, contentCols - 4)
  const whoText = props.ghLogin
    ? `@${props.ghLogin} in ${customerLogin}`
    : customerLogin
  // Over the picker the right edge answers "why is this list short?" instead
  // of carrying the focused session's meta: the filters are why sessions are
  // missing, and the list is the one screen where that question comes up.
  const filterText = navOpen ? sessionBarFilterLabel(sessionBar, props.detectedRepo) : null
  const header = (
    // Unpainted, like every other surface: its own blank rows above and below
    // are what set the title apart, not a tint.
    <Box
      flexDirection="column"
      width={contentCols}
      height={headerRows}
      flexShrink={0}
      paddingLeft={2}
      paddingRight={2}
      justifyContent="center"
    >
      {/* The explicit width is what wrap="truncate" measures against: without
          it the meta line sizes the row to its own content and overflows the
          terminal instead of clipping. */}
      <Box width={contentCols - 4}>
        <Box flexGrow={1}>
          <Text wrap="truncate">
            <Text bold color={theme.foreground}>
              {HEADER_TITLE}
            </Text>
          </Text>
        </Box>
        <Box flexShrink={0}>
          {/* truncate, never wrap: the bar is budgeted at exactly one row, and
              a wrapped meta line pushes the rule off the bottom of the band. */}
          <Text color={theme.muted} wrap="truncate">
            {/* Armed, the bar carries the ctrl+c prompt: the nav and the
                new-session form have no notice line of their own, and the
                header is the one band always on screen. */}
            {navArmed || paneArmed ? CTRL_C_QUIT_HINT : (filterText ?? metaText ?? whoText)}
          </Text>
        </Box>
      </Box>
    </Box>
  )

  // ---- the main screen: the chat, or the new-session composer ----
  let main: React.ReactElement
  if (mainPane.type === 'new') {
    main = (
      // Full width, no side padding: the prompt input's rules span the
      // terminal exactly like the header's and the nav's do.
      <Box width={contentCols} height={paneRows} flexDirection="column" overflow="hidden">
        <NewSessionPane
          width={contentCols}
          height={paneRows}
          focused={focus === 'chat'}
          starting={starting}
          error={startError}
          configs={configs}
          repos={repos}
          models={models}
          detectedRepo={props.detectedRepo}
          onSubmit={(text, choices) => void startSession(text, choices)}
          onLeave={focusNav}
          rawMode={isRawModeSupported}
        />
      </Box>
    )
  } else {
    const entry = entries.get(mainPane.sessionId)
    if (!entry) {
      main = (
        <Box
          width={contentCols}
          height={paneRows}
          flexDirection="column"
          paddingLeft={2}
          paddingRight={1}
          paddingTop={1}
        >
          <Text color={theme.muted}>
            {loadError ? `✗ ${loadError}` : `loading ${mainPane.sessionId}…`}
          </Text>
          {loadError && <Text color={theme.muted}>esc: back to the sessions</Text>}
          <EscOnlyInput active={focus === 'chat'} rawMode={isRawModeSupported} onEsc={focusNav} />
        </Box>
      )
    } else {
      // Anything already printed below means this chat is arriving under another
      // conversation, so it opens with a rule naming itself. Recorded before the
      // render so the flag is stable for this mount: the ref is what makes the
      // FIRST chat of the process print no break.
      const needsBreak = shownChats.current.size > 0 && !shownChats.current.has(mainPane.sessionId)
      shownChats.current.add(mainPane.sessionId)
      main = (
        // The chat, owning the terminal rather than sitting in a pane: no
        // width/height box around it and no pane props, which is what puts
        // ConnectApp in its scrollback view (settled transcript printed into the
        // terminal's own scrollback, native wheel and select/copy, and ctrl+r for
        // the full-screen browser). It renders its own meta line again, since
        // there is no header band above it to carry one.
        <ConnectApp
          key={mainPane.sessionId}
          scrollbackBreak={needsBreak}
          api={api}
          sessionId={mainPane.sessionId}
          store={entry.store}
          openSocket={openSocket}
          canSend={entry.canSend}
          minRenderFeedSeq={0}
          sessionUrl={entry.url}
          initialNotice={entry.notice}
          model={entry.model}
          configName={entry.configName}
          focused={focus === 'chat'}
          onFocusNav={focusNav}
          onDone={refreshOnDone}
        />
      )
    }
  }

  // ---- the session picker ----
  // A vertical list on a screen of its own (the alternate buffer): the pinned
  // new-session row, then the session rows (status dot + description + a dim age
  // tag) in sortSidebarSessions order — status band, newest-born first —
  // windowed so the highlight parks near the bottom and the list scrolls under
  // it. It gets the whole terminal now, so the window is only reached by lists
  // longer than the screen.
  const selectedRowIdx = Math.max(0, rows.findIndex((s) => s.id === selected))
  const win = navSlice(rows.length, navSessionRows, selectedRowIdx)
  const navFocused = focus === 'nav'
  const nav = (
    // The session list gets a gutter of its own on top of the app inset, so the
    // column of dots sits inboard of the frame edge instead of hugging it. The
    // pad is on the band, so every row (and the hint) shares one left edge.
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      paddingLeft={NAV_GUTTER}
      paddingRight={NAV_GUTTER}
    >
      <Box height={1} flexShrink={0} />
      {/* The highlighted row — this one and the session rows below — is marked
          by the cyan ▶ in its gutter and nothing else. No bar: a fill would be
          one more surface to keep in step with the terminal's own. */}
      <Box>
        <Box flexGrow={1}>
          <Text wrap="truncate">
            {selected === 'new' && navFocused ? (
              <Text bold color={theme.foreground}>
                <Text color={theme.cursor}>{SELECTION_GLYPH}</Text>
                {` ${NAV_NEW_LABEL.slice(2)}`}
              </Text>
            ) : (
              <Text bold color={theme.foreground}>
                {NAV_NEW_LABEL}
              </Text>
            )}
          </Text>
        </Box>
      </Box>
      {rows.slice(win.start, win.end).map((s) => {
        const word = rowStatusWord(s)
        const g = rowGlyph(word)
        const cursorHere = selected === s.id && navFocused
        const isOpen = mainPane.type === 'chat' && mainPane.sessionId === s.id
        const desc = rowDescription(s)
        // The meta tag rides the right edge; the description takes what's left
        // and truncates, so a long prompt can never push the tag off the row.
        const meta = `${rowMeta(s)}${attention.has(s.id) ? ' · needs you' : ''}`
        const descW = Math.max(8, contentCols - NAV_GUTTER * 2 - meta.length - 6)
        return (
          <Box key={s.id}>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate">
                <Text color={cursorHere ? theme.cursor : g.color} dimColor={!cursorHere && g.dim}>
                  {cursorHere ? SELECTION_GLYPH : g.glyph}
                </Text>{' '}
                <Text
                  color={
                    cursorHere || attention.has(s.id) || !g.dim
                      ? theme.foreground
                      : theme.muted
                  }
                  bold={isOpen}
                >
                  {desc.slice(0, descW)}
                </Text>
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text color={theme.muted}>{meta}</Text>
            </Box>
          </Box>
        )
      })}
      {rows.length === 0 && (
        <Text color={theme.muted}>{polledOnce ? 'no sessions yet' : 'loading sessions…'}</Text>
      )}
      {/* Absorbs the rows a short list leaves empty, keeping the hint on the
          band's bottom edge. */}
      <Box flexGrow={1} />
      {/* An API failure replaces the key hints rather than sharing the line:
          the hints are always recoverable from muscle memory, a swallowed error
          is not. */}
      {apiError ? (
        <Text wrap="truncate" color={theme.error}>
          {`✗ ${apiError}`}
        </Text>
      ) : (
        <Text wrap="truncate" color={theme.muted}>
          {`↑↓ move · enter open · n new · esc back to the chat · q quit${
            win.end < rows.length ? ` · ${rows.length - win.end} more below` : ''
          }`}
        </Text>
      )}
    </Box>
  )

  // The picker, open, IS the screen: it took over the alternate buffer, so it
  // renders alone (header + list) and the chat is left untouched on the primary
  // buffer, waiting behind it.
  if (navOpen) {
    return (
      <Box flexDirection="column" height={height} padding={APP_INSET}>
        {header}
        {nav}
      </Box>
    )
  }

  // A LIVE CHAT owns the terminal outright: no box around it, no header, no
  // inset. All three would be frame furniture around a region that prints into
  // the terminal's scrollback, and the rows scrolling past would run straight
  // through them.
  const chatOwnsScreen = mainPane.type === 'chat' && entries.has(mainPane.sessionId)
  if (chatOwnsScreen) return main

  // The remaining screens (the new-session composer, a chat still loading) do
  // own their frame, so they keep the inset and the header.
  return (
    <Box flexDirection="column" minHeight={height} padding={APP_INSET}>
      {header}
      {main}
    </Box>
  )
}

// The header's right-edge meta for the focused session: the full id
// (hyperlinked) · model · total cost · tokens, derived from the session's
// transcript store so it ticks with the stream exactly like the old in-chat
// footer. The id is never shortened — it's there to be copy-pasted.
function useHeaderMeta(
  entry: ChatEntry | undefined,
  mainPane: MainPane,
  appBase: string,
  customerLogin: string,
  cols: number,
): string | null {
  const subscribe = useCallback(
    (cb: () => void) => (entry ? entry.store.subscribe(cb) : () => {}),
    [entry],
  )
  const snapshot = useSyncExternalStore(
    subscribe,
    () => (entry ? entry.store.getSnapshot() : null),
    () => (entry ? entry.store.getSnapshot() : null),
  )
  if (mainPane.type !== 'chat' || !entry) return null
  const session = snapshot?.session as FrameSession | undefined | null
  const costUsd = session ? usdNumberFromMillicents(session.cost?.total ?? 0) : 0
  const tokens = session?.tokens?.total ?? 0
  const id = mainPane.sessionId
  const line = (idText: string, model: string | null | undefined): string =>
    [
      idText,
      ...(model ? [model] : []),
      `$${costUsd.toFixed(2)}`,
      `${compactTokens(tokens)} tokens`,
    ].join(' · ')
  // Sized to fit one row by construction: Ink measures the OSC-8 link's
  // invisible URL bytes as width, so the linked id only ships when the whole
  // line fits beside the title. Failing that the id goes out as plain text,
  // then the model drops, then the spend — the id is here to be copy-pasted,
  // so it is the last thing standing and is never shortened.
  const budget = cols - TITLE_WIDTH - 1
  const tiers = [
    line(hyperlink(sessionUrl(appBase, customerLogin, id), id), entry.model),
    line(id, entry.model),
    line(id, undefined),
  ]
  return tiers.find((t) => t.length <= budget) ?? id
}

// Swallows everything except esc and ← — the keyboard owner for placeholder
// panes, either of which hands focus back to the sidebar.
function EscOnlyInput({
  active,
  rawMode,
  onEsc,
}: {
  active: boolean
  rawMode: boolean
  onEsc: () => void
}): React.ReactElement | null {
  useInput(
    (_ch, key) => {
      if (key.escape || key.leftArrow) onEsc()
    },
    { isActive: active && rawMode },
  )
  return null
}

// One row of the new-session form: a label + the picked value(s), opened
// into its option list with →/enter (the dashboard composer's selects,
// terminal-shaped). Repositories multi-select; the others pick one.
type PickerRow = { key: 'config' | 'model' | 'repo'; label: string }
const PICKER_ROWS: readonly PickerRow[] = [
  { key: 'repo', label: 'Repository' },
  { key: 'config', label: 'Agent' },
  { key: 'model', label: 'Model' },
]

// The new-session pane, mirroring the dashboard's home composer
// (app.ellipsis.dev/[login]): a centered "What are we shipping today?"
// heading floating in the empty space, and the input panel docked at the
// bottom — the Repository / Agent / Model rows above the ❯ prompt line (the
// dashboard card's controls-inside-the-composer shape). The ❯ glyph marks
// whichever row is selected. ↑ from
// the prompt climbs into the option rows, ↑/↓ walk them (↓ off the last
// returns to the prompt), →/enter unfolds a row's option list in place,
// inside the panel ([x] marks the pick). Inside an open list ↑/↓ walk, → (or
// enter/space) activates the
// highlighted option, ← (or esc) backs out unchanged. "Default" everywhere
// means the server resolves it (defaults ladder, DEFAULT_AGENT_MODEL, the
// detected repo). Repository is the one multi-select, and a sandbox takes any
// number of repos: check several to clone them all, or uncheck every one for a
// sandbox with no checkout (the row then reads "none"). Esc — or ↓ / ← at the
// prompt's left edge — hands focus to the session nav.
function NewSessionPane({
  width,
  height,
  focused,
  starting,
  error,
  configs,
  repos,
  models,
  detectedRepo,
  onSubmit,
  onLeave,
  rawMode,
}: {
  width: number
  height: number
  focused: boolean
  starting: boolean
  error: string | null
  // null while loading; [] when the account has none / the fetch failed.
  configs: SavedAgentConfig[] | null
  repos: string[] | null
  models: SupportedModel[] | null
  // The cwd's repo ("owner/name") — what the server's default resolution
  // checks out; named on the Repository row instead of a bare "Default".
  detectedRepo: string | null
  onSubmit: (text: string, choices: ComposerChoices) => void
  onLeave: () => void
  rawMode: boolean
}): React.ReactElement {
  const [text, setText] = useState('')
  const [cursor, setCursor] = useState(0)
  // One fact per visit — the lazy initializer keeps it stable across
  // re-renders so the line doesn't shuffle while you type.
  const [fact] = useState(randomFact)
  // Where the form cursor is: the prompt line, or one of the option rows
  // beneath it (by PICKER_ROWS index).
  const [row, setRow] = useState<'prompt' | number>('prompt')
  // Single-pick indices; 0 is always "Default" (server-resolved).
  const [configIdx, setConfigIdx] = useState(0)
  const [modelIdx, setModelIdx] = useState(0)
  // The multi-select repository set ("owner/name" full names). null = the
  // picker is untouched: the run inherits the server's resolution (the
  // detected repo + whatever the resolved config declares). The first toggle
  // materializes an explicit set — zero, one, or many repos are all valid —
  // seeded with the detected repo, since that is what the [x] showed.
  const [repoSel, setRepoSel] = useState<ReadonlySet<string> | null>(null)
  // The open row's dropdown state: which picker is open and where its
  // highlight sits. null = no subtree open.
  const [openPicker, setOpenPicker] = useState<{ key: PickerRow['key']; hover: number } | null>(
    null,
  )

  // All three pickers deal in the same option shape (ComposerModel), so the
  // renderer can ask any of them for a group heading or a subtext; only the
  // model list fills those in.
  const configOptions = useMemo<ComposerModel[]>(
    () => [
      { id: null as string | null, label: 'Default' },
      ...(configs ?? []).map((c) => ({ id: c.id as string | null, label: configDisplayName(c) })),
    ],
    [configs],
  )
  // The server's selectable set (GET /models); before it lands — and on an
  // older server that has no such route — the built-in fallback list.
  const modelOptions = useMemo(() => composerModelOptions(models ?? []), [models])
  // When the cwd names a repo there is no "Default" row: the detected repo
  // heads the list as a normal checkable entry — it reads [x] while the
  // selection is untouched (the server checks it out by default) and can be
  // unchecked, or checked alongside any others (repositories multi-select).
  // Only with no detection does the null Default row appear (the server still
  // resolves the checkout, but there's no name to show).
  const repoOptions = useMemo<ComposerModel[]>(() => {
    const listed = (repos ?? []).filter((r) => r !== detectedRepo)
    return detectedRepo
      ? [detectedRepo, ...listed].map((r) => ({ id: r as string | null, label: r }))
      : [
          { id: null as string | null, label: 'Default' },
          ...listed.map((r) => ({ id: r as string | null, label: r })),
        ]
  }, [repos, detectedRepo])
  const optionsFor = (key: PickerRow['key']) =>
    key === 'config' ? configOptions : key === 'model' ? modelOptions : repoOptions
  // The set a toggle starts from: an explicit selection once one exists, else
  // what the untouched row was already showing as checked (the detected repo).
  // Without this seed, checking a SECOND repo would silently drop the first.
  const repoBaseSet = (prev: ReadonlySet<string> | null): Set<string> =>
    new Set(prev ?? (detectedRepo ? [detectedRepo] : []))
  // Whether an option is currently picked. Repo is a multi-select: an
  // untouched selection is the server's default checkout, so the detected repo
  // (or the null Default row) reads [x] until you touch the list; the
  // single-pickers match their index.
  const isPicked = (key: PickerRow['key'], at: number): boolean => {
    if (key === 'repo') {
      const id = repoOptions[at]?.id
      if (repoSel === null) return id === null || id === detectedRepo
      return id !== null && repoSel.has(id)
    }
    const idx = key === 'config' ? configIdx : modelIdx
    return at === Math.min(idx, optionsFor(key).length - 1)
  }
  // Activating an option: single-pickers pick and close; the repo list
  // TOGGLES the entry ([x]↔[ ]) and stays open so several can be checked, or
  // all of them unchecked for a sandbox with no checkout. The null Default row
  // (shown only with no detected repo) hands resolution back to the server.
  const activate = (key: PickerRow['key'], at: number): void => {
    if (key === 'config') {
      setConfigIdx(at)
      setOpenPicker(null)
    } else if (key === 'model') {
      setModelIdx(at)
      setOpenPicker(null)
    } else {
      const id = repoOptions[at]?.id
      if (id == null) setRepoSel(null)
      else {
        setRepoSel((prev) => {
          const next = repoBaseSet(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }
    }
  }

  // Enter with an empty prompt is a real start: the session comes up idle and
  // waits for the first message, so you can open a sandbox before you know
  // what to ask it.
  const submit = (): void => {
    onSubmit(text.trim(), {
      configId: configOptions[Math.min(configIdx, configOptions.length - 1)]?.id ?? null,
      model: modelOptions[Math.min(modelIdx, modelOptions.length - 1)]?.id ?? null,
      repos: repoSel === null ? null : [...repoSel],
    })
  }

  useInput(
    (ch, key) => {
      // An open dropdown is a modal subtree: ↑/↓ walk the options,
      // → (or enter/space) activates the highlighted one — single-pickers
      // close on pick, the repo list toggles and stays open for more —
      // ← (or esc) backs out of the subtree.
      if (openPicker !== null) {
        const options = optionsFor(openPicker.key)
        if (key.escape || key.leftArrow) {
          setOpenPicker(null)
          return
        }
        if (key.upArrow) {
          setOpenPicker((p) => p && { ...p, hover: Math.max(0, p.hover - 1) })
          return
        }
        if (key.downArrow) {
          setOpenPicker((p) => p && { ...p, hover: Math.min(options.length - 1, p.hover + 1) })
          return
        }
        if (key.rightArrow || key.return || ch === ' ') {
          activate(openPicker.key, Math.min(openPicker.hover, options.length - 1))
          return
        }
        return
      }
      if (key.escape) {
        onLeave()
        return
      }
      if (starting) return
      // Word/line jumps and kills (option+←/→, ctrl+a/e/w/u/k, …) act on the
      // prompt from anywhere in the form, dropping focus back onto it.
      const edited = applyEditShortcut({ text, cursor }, ch, key)
      if (edited) {
        setRow('prompt')
        setText(edited.text)
        setCursor(edited.cursor)
        return
      }
      if (row !== 'prompt') {
        // The option rows above the prompt, inside the panel, walked
        // vertically: ↑/↓ move between them (↑ stops at the first, ↓ off the
        // last returns to the prompt), →/enter opens the row's list, ←
        // leaves for the nav, typing returns to the prompt.
        if (key.upArrow) {
          setRow(Math.max(0, row - 1))
          return
        }
        if (key.downArrow) {
          if (row >= PICKER_ROWS.length - 1) setRow('prompt')
          else setRow(row + 1)
          return
        }
        if (key.return || key.rightArrow) {
          setOpenPicker({ key: PICKER_ROWS[row].key, hover: 0 })
          return
        }
        if (key.leftArrow) {
          onLeave()
          return
        }
        if (ch && !key.ctrl && !key.meta) {
          setRow('prompt')
          setText((t) => t.slice(0, cursor) + ch + t.slice(cursor))
          setCursor((c) => c + ch.length)
        }
        return
      }
      if (key.return) {
        submit()
        return
      }
      // At the prompt: ↑ climbs into the option rows above it (landing on
      // the nearest, Model), ↓ continues past the input to the session nav.
      if (key.upArrow) {
        setRow(PICKER_ROWS.length - 1)
        return
      }
      if (key.downArrow) {
        onLeave()
        return
      }
      if (key.leftArrow) {
        if (cursor === 0) {
          onLeave()
          return
        }
        setCursor((c) => Math.max(0, c - 1))
        return
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(text.length, c + 1))
        return
      }
      if (key.backspace || key.delete) {
        if (cursor > 0) {
          setText((t) => t.slice(0, cursor - 1) + t.slice(cursor))
          setCursor((c) => c - 1)
        }
        return
      }
      if (key.ctrl || key.meta || key.tab) return
      if (ch) {
        setText((t) => t.slice(0, cursor) + ch + t.slice(cursor))
        setCursor((c) => c + ch.length)
      }
    },
    { isActive: focused && rawMode },
  )

  // The summary shown on a row: the single pick's label, or the checked repo
  // set joined (the detected repo while the list is untouched, "none" once you
  // have explicitly unchecked everything — a sandbox with no checkout).
  const rowValue = (key: PickerRow['key']): string => {
    if (key === 'repo') {
      if (repos === null) return 'loading…'
      if (repoSel === null) return detectedRepo ?? 'Default'
      if (repoSel.size === 0) return 'none'
      return [...repoSel].join(', ')
    }
    if (key === 'config' && configs === null) return 'loading…'
    const options = optionsFor(key)
    const idx = key === 'config' ? configIdx : modelIdx
    return options[Math.min(idx, options.length - 1)]?.label ?? 'Default'
  }

  // The muted tail after a collapsed row's value: the picked model's price, so
  // the row still says what a run costs once the list is folded away. Only the
  // model rows carry one.
  const rowNote = (key: PickerRow['key']): string | null => {
    if (key !== 'model') return null
    const options = optionsFor(key)
    return options[Math.min(modelIdx, options.length - 1)]?.rate ?? null
  }

  // How many option rows an open picker shows inside the panel: the pane
  // minus the heading, notices, and the panel's other rows (~12); the panel
  // grows upward into the spacer above, so the prompt never moves.
  const dropdownCapacity = Math.max(3, height - 12)
  // Whether the input has room for its 1-row perimeter: the three picker rows,
  // the blank one above the prompt, the prompt's own two, and a pad row top AND
  // bottom. All or nothing, deliberately — a pad on top with none underneath
  // reads as a box that forgot to close, which is worse than no pad at all.
  const inputPad = height - (PICKER_ROWS.length + 1 + 2) >= 2 ? 1 : 0
  // The wrap width inside the input box: the pane minus the box's own left
  // and right padding (the "▶ " prompt is part of the wrapped text).
  const inputWidth = Math.max(8, width - COMPOSER_PAD_X * 2)
  const caretVisible = focused && row === 'prompt' && !starting && openPicker === null
  const open = openPicker
  const openOptions = open ? optionsFor(open.key) : []
  const openHover = open ? Math.min(open.hover, openOptions.length - 1) : 0
  // What actually gets printed: the options plus their group headings (the
  // model list has them; the other two pickers produce a row per option and
  // nothing else). The window slides over THESE rows, not over the options, so
  // a heading takes a row from the capacity like anything else.
  const openRows = open ? composerPickerRows(openOptions) : []
  const hoverRow = Math.max(
    0,
    openRows.findIndex((r) => r.kind === 'option' && r.at === openHover),
  )
  const win = open
    ? sidebarSlice(openRows.length, dropdownCapacity, hoverRow)
    : { start: 0, end: 0 }
  // A heading whose options all fell past the bottom edge labels nothing, so
  // the window gives its last row back rather than print it; it returns with
  // its group on the next scroll.
  const visibleRows = (() => {
    const rows = openRows.slice(win.start, win.end)
    return rows.at(-1)?.kind === 'group' ? rows.slice(0, -1) : rows
  })()
  // The "… N more" counts name OPTIONS, never rows: a heading is not a model,
  // and counting it would overstate what is hidden above and below.
  const hiddenAbove = openRows.slice(0, win.start).filter((r) => r.kind === 'option').length
  const hiddenBelow = openRows.slice(win.end).filter((r) => r.kind === 'option').length
  // Where the price column starts: the widest label in the list, so the rates
  // read down a column instead of ragged. Dropped (0 = one space after the
  // label) when the panel is too narrow to hold label and price both, since a
  // padded row would push the price off the right edge into the truncation.
  const rateColumn = (() => {
    if (!openOptions.some((o) => o.rate)) return 0
    const label = Math.max(...openOptions.map((o) => o.label.length))
    const rate = Math.max(...openOptions.map((o) => (o.rate ?? '').length))
    return OPTION_GUTTER + label + 2 + rate <= inputWidth ? label : 0
  })()

  return (
    // Bottom-docked, mirroring the chat layout: the heading floats centered
    // in the empty space (equal spacers above and below it) while the input
    // + option rows pin to the bottom edge (just above the session nav),
    // where they NEVER move — an open dropdown expands upward instead of
    // pushing the input around.
    // No pane padding: the input's rules span the full terminal width like
    // the header's and the nav's (the rows inside carry their own indents).
    // The heading and the fact are DECORATION, and they are what yields when the
    // terminal is short: both sit in an overflow-hidden box that shrinks to
    // nothing, so the input below keeps every row it asked for — including the
    // blank one under the prompt. Squeezing the input instead would eat that row
    // and leave the box looking open at the bottom.
    <Box width={width} height={height} flexDirection="column">
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        <Box flexGrow={1} />
        <Box justifyContent="center" flexShrink={0}>
          <Text bold color={theme.foreground}>
            What are we shipping today?
          </Text>
        </Box>
        {/* The fact box is sized to the text (capped so long facts wrap at a
            readable measure) so short facts sit centered, not left-aligned
            inside a fixed column. */}
        <Box justifyContent="center" paddingTop={1} flexShrink={0}>
          <Box width={Math.min(fact.length, Math.max(8, width - 4), 72)}>
            <Text color={theme.muted} wrap="wrap">
              {fact}
            </Text>
          </Box>
        </Box>
        <Box flexGrow={1} />
      </Box>
      {error && <Text color={theme.error}> ✗ {error}</Text>}
      {starting && <Text color={theme.muted}> ✻ Starting session…</Text>}
      {/* The input, laid out like the chat composer: the run controls one row
          each ABOVE the prompt (the dashboard card's controls-inside-the-
          composer shape) — Repository, Agent, Model, a blank row, then the
          prompt line. The ❯ selection glyph marks whichever row is selected.
          →/enter opens a picker row IN PLACE: its value collapses to a bare
          label and the option list unfolds indented beneath it, growing upward
          into the space above so the prompt never moves. Repositories
          multi-select ([x] toggles), the others pick one. */}
      <Box
        flexDirection="column"
        backgroundColor={inputSurface}
        alignItems="flex-start"
        paddingY={inputPad}
        paddingX={COMPOSER_PAD_X}
        // Never squeezed. The pane clips its overflow, and the input is the LAST
        // child, so without this a pane too short for the content above it takes
        // the difference out of the input's bottom edge — which reads as a box
        // with a top pad and no bottom one, its tint stopping flush against the
        // prompt. The squeeze belongs on the spacers and the fact above instead.
        flexShrink={0}
      >
        {PICKER_ROWS.map((r, i) => {
          const active = focused && openPicker === null && row === i
          const isOpen = open?.key === r.key
          if (isOpen) {
            return (
              <Box key={r.key} flexDirection="column" width={inputWidth}>
                <Text color={theme.muted}>{'  '}{r.label}:</Text>
                {hiddenAbove > 0 && (
                  <Text color={theme.muted}>{'    '}… {hiddenAbove} more</Text>
                )}
                {visibleRows.map((pickerRow) => {
                  // A group heading: the vendor that built the models under it,
                  // upper-cased into an eyebrow the way the dashboard's
                  // rate-card table sets its own, and muted so it reads as
                  // structure rather than as another pickable row.
                  if (pickerRow.kind === 'group') {
                    return (
                      <Box key={`group:${pickerRow.label}`} width={inputWidth}>
                        <Text wrap="truncate" color={theme.muted}>
                          {'    '}
                          {pickerRow.label.toUpperCase()}
                        </Text>
                      </Box>
                    )
                  }
                  const at = pickerRow.at
                  const opt = openOptions[at]
                  if (!opt) return null
                  const hovered = at === openHover
                  const picked = isPicked(r.key, at)
                  return (
                    <Box key={opt.id ?? 'default'} width={inputWidth}>
                      <Text wrap="truncate">
                        {'  '}
                        <Text color={theme.cursor}>
                          {hovered ? SELECTION_GLYPH : ' '}
                        </Text>{' '}
                        <Text color={hovered || picked ? theme.foreground : theme.muted}>
                          {`[${picked ? 'x' : ' '}] ${rateColumn ? opt.label.padEnd(rateColumn) : opt.label}`}
                        </Text>
                        {/* The price, always muted — subtext next to the id
                            whether or not the row is the highlighted one, so
                            walking the list never moves the eye off the name. */}
                        {opt.rate && (
                          <Text color={theme.muted}>
                            {'  '}
                            {opt.rate}
                          </Text>
                        )}
                      </Text>
                    </Box>
                  )
                })}
                {hiddenBelow > 0 && (
                  <Text color={theme.muted}>
                    {'    '}… {hiddenBelow} more
                  </Text>
                )}
              </Box>
            )
          }
          const note = rowNote(r.key)
          return (
            <Box key={r.key} width={inputWidth}>
              <Text wrap="truncate">
                <Text color={active ? theme.cursor : theme.muted}>
                  {active ? SELECTION_GLYPH : ' '}
                </Text>{' '}
                <Text color={theme.muted}>{r.label}: </Text>
                <Text color={active ? theme.foreground : theme.muted}>
                  {rowValue(r.key)}
                </Text>
                {note && (
                  <Text color={theme.muted}>
                    {'  '}
                    {note}
                  </Text>
                )}
              </Text>
            </Box>
          )
        })}
        {/* One blank row between the run controls and the prompt. */}
        <Box height={1} flexShrink={0} />
        {/* The prompt, under the option rows. ONE ❯ on the whole panel: the
            prompt's gutter carries it only while the prompt is the selected
            row — a blank cell otherwise, exactly like the picker rows above
            (whichever row is selected shows the glyph). Wraps instead of
            truncating: a long prompt flows onto the next row (the box grows
            downward into the spacer above) rather than running off the right
            edge. The explicit width is what ink wraps against; the key
            remounts the node so a stale measurement can't wrap the caret
            onto the border row. */}
        <Box width={inputWidth} minHeight={2} alignItems="flex-start">
          {/* The colour on the parent is what the bare text children below
              inherit (ink would leave typed text on the terminal's default
              foreground, which a light theme paints near-black on our panel),
              and it gives the inverse caret a known pair to swap. */}
          <Text
            wrap="wrap"
            key={`${text}:${cursor}:${focused && row === 'prompt'}`}
            color={theme.foreground}
          >
            <Text color={theme.cursor}>
              {focused && row === 'prompt' && openPicker === null ? SELECTION_GLYPH : ' '}{' '}
            </Text>
            {text.slice(0, cursor)}
            {caretVisible && text !== '' && (
              <Text inverse>{cursor < text.length ? text[cursor] : ' '}</Text>
            )}
            {cursor < text.length ? text.slice(cursor + (caretVisible ? 1 : 0)) : ''}
            {/* Empty input: the placeholder sits where typed text will land,
                its first character carrying the caret (inverse) instead of a
                caret cell of its own pushing it a column right. */}
            {text === '' && caretVisible && (
              <Text>
                <Text inverse>S</Text>
                <Text color={theme.muted}>tart a cloud session…</Text>
              </Text>
            )}
            {text === '' && !caretVisible && (
              <Text color={theme.muted}>Start a cloud session…</Text>
            )}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
