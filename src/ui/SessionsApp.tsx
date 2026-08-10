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
import type { AgentSessionWire } from '@ellipsis-dev/sdk'
import type { ApiClient } from '../lib/api'
import { ApiError } from '../lib/api'
import type {
  AgentSession,
  SavedAgentConfig,
  StartAgentSessionRequest,
  SupportedModel,
} from '../lib/types'
import { applyEditShortcut } from '../lib/editing'
import { hyperlink, sessionUrl } from '../lib/urls'
import { usdNumberFromMillicents } from '../lib/output'
import {
  attentionFlip,
  compactTokens,
  composerModelOptions,
  configDisplayName,
  connectability,
  repoOverrideEntry,
  rowDescription,
  rowGlyph,
  rowMeta,
  rowStatusWord,
  navSlice,
  sessionSource,
  SELECTION_GLYPH,
  sidebarSlice,
  mergeSidebarSessions,
} from '../lib/sessions'
import { randomFact } from '../lib/facts'
import { SURFACE_ACTIVE, SURFACE_ELEVATED, theme } from '../lib/theme'
import { ConnectApp } from './ConnectApp'

// The multi-session UI, a vertical stack of four bands:
//   1. the header — " ellipsis.dev" top-left; top-right the focused
//      session's meta (id · model · cost · tokens), or the who-tag when
//      no session is focused
//   2. the chat window (the hosted ConnectApp, full width)
//   3. the text input (the ConnectApp's composer)
//   4. the session nav — a vertical list: "+ New session" then your sessions,
//      banded by status (live conversations first) and newest-born first
//      inside a band
// This is what a bare `agent`, `agent "prompt"`, and `agent session
// connect <id>` all open.
//
// Focus is modal and esc steps outward: inside the chat esc closes panels,
// then transcript navigation, then lands on the nav list. ↓ at the composer's
// last line reaches the nav too; enter (or esc, or ↑ off the top row) hands it
// back. Exactly one useInput handler is active at a time.
//
// Liveness: ONE WebSocket — the focused session's, owned by its ConnectApp —
// plus a 5s REST poll of the session list for the nav. Transcript stores are
// cached per visited session for the process lifetime, so hopping back
// repaints instantly and the stream resumes past the cached cursor.

const SIDEBAR_POLL_MS = 5_000
const SIDEBAR_LIMIT = 50
// The nav clock driving the "12s" age tags.
const AGE_TICK_MS = 5_000
const NAV_NEW_LABEL = '+ New session'
// The header title pinned to the left edge, and its width — the meta line on
// the right budgets itself against what's left of the row.
const HEADER_TITLE = 'ellipsis.dev'
const TITLE_WIDTH = HEADER_TITLE.length
// The nav shows six rows: the pinned new-session row plus the five most
// recent sessions, which scroll under the highlight.
const NAV_SESSION_ROWS = 5

// Blank canvas cells between the frame and the terminal edge, on all four
// sides. Everything inside lays out against the inset width/height.
const APP_INSET = 1

// Extra indent for the session-nav rows, on top of the app inset — the list
// reads as a distinct column rather than type hanging off the frame edge.
const NAV_GUTTER = 1

// Horizontal breathing room inside the composer panel — wider than the 1-cell
// vertical pad so the caret and text start well clear of the panel edge.
const COMPOSER_PAD_X = 2

export interface SessionsAppProps {
  api: ApiClient
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
  // Drop the session nav (band 4) entirely, giving its rows to the chat.
  // Focus never leaves the chat: esc and ↓ at the bottom edge do nothing.
  // Set via "hideSessionBar": true in the config file.
  hideSessionBar?: boolean
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
  const { api, openSocket, appBase, customerLogin, authorId } = props
  const hideNav = props.hideSessionBar === true
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
  // The app inset: one blank cell of canvas on all four sides of the whole
  // frame, so nothing sits flush against the terminal edge. The bands lay out
  // inside it, so every width/height below is the INNER box, not the terminal.
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

  const poll = useCallback(async (): Promise<void> => {
    try {
      const listed = await api.listAgentSessions({
        author_id: authorId ?? undefined,
        limit: SIDEBAR_LIMIT,
      })
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
    } catch {
      // Transient poll failure — keep the previous list; the next tick retries.
    }
  }, [api, authorId])

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
  // dead row taking a slot from the five cloud sessions worth showing.
  const rows = useMemo(
    () => mergeSidebarSessions(sessions, localSessions).filter((s) => sessionSource(s) !== 'laptop'),
    [localSessions, sessions],
  )

  // ------------------------------ focus + panes -----------------------------

  // Both openings start with the main pane focused: a connect lands you in
  // the conversation, a bare `agent` lands you in the new-session composer.
  // 'nav' = the session bar at the bottom owns the keyboard.
  const [focus, setFocus] = useState<'nav' | 'chat'>('chat')
  const [mainPane, setMainPane] = useState<MainPane>(
    props.initialSessionId ? { type: 'chat', sessionId: props.initialSessionId } : { type: 'new' },
  )
  // The nav highlight: 'new' or a session id. Tracks ids, not indices, so
  // the poll re-sorting under the cursor doesn't move the highlight.
  const [selected, setSelected] = useState<string>(props.initialSessionId ?? 'new')

  // ------------------------------ chat entries ------------------------------

  const [entries, setEntries] = useState<ReadonlyMap<string, ChatEntry>>(new Map())
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
        const [session, page] = await Promise.all([
          api.getAgentSession(sessionId),
          api.getAgentSessionRecordsPage(sessionId),
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
          model: typeof session.tokens_model === 'string' ? session.tokens_model : null,
          configName:
            configName ?? session.resolved_config_name ?? session.agent_config_id ?? null,
          url: sessionUrl(appBase, customerLogin, sessionId),
        }
        setEntries((prev) => new Map(prev).set(sessionId, entry))
      } catch (err) {
        setLoadError(err instanceof ApiError ? err.detail : (err as Error).message)
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
    void api
      .listAgentConfigs()
      .then((rows) => setConfigs(rows.filter((c) => !c.deleted)))
      .catch(() => setConfigs([]))
    void api
      .listGithubRepositories()
      .then((r) => setRepos(r.repositories.map((repo) => repo.full_name)))
      .catch(() => setRepos([]))
    void api
      .listSupportedModels()
      .then(setModels)
      .catch(() => setModels([]))
  }, [mainPane.type, api])

  const startSession = useCallback(
    async (
      prompt: string,
      choices: { configId: string | null; model: string | null; repos: string[] },
    ): Promise<void> => {
      setStarting(true)
      setStartError(null)
      try {
        // The entry point's base request (prompt + detected repository),
        // with the composer's picks layered on: a saved config as the
        // source, the model + repositories as a per-run override (the
        // dashboard composer's shape — lists replace wholesale, so the
        // checked repos become the run's whole checkout set).
        const req = props.buildStartRequest(prompt)
        if (choices.configId) req.config_id = choices.configId
        const override: Record<string, unknown> = {}
        if (choices.model) override.claude = { model: choices.model }
        const repoEntries = choices.repos
          .map(repoOverrideEntry)
          .filter((e): e is { owner: string; name: string } => e !== null)
        if (repoEntries.length > 0) override.sandbox = { repositories: repoEntries }
        if (Object.keys(override).length > 0) req.config_override = override
        const session = await api.startAgentSession(req)
        lastWords.current.set(session.id, rowStatusWord(session))
        setLocalSessions((prev) => [session, ...prev])
        setSelected(session.id)
        setMainPane({ type: 'chat', sessionId: session.id })
        setFocus('chat')
        // Seed the entry from the start response's resolved config identity.
        void loadEntry(
          session.id,
          session.resolved_config_name ?? session.agent_config_id ?? undefined,
        )
      } catch (err) {
        setStartError(err instanceof ApiError ? err.detail : (err as Error).message)
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
      // The nav is a vertical list: ↑/↓ move the highlight, enter opens the
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

  // With the session bar hidden there is nothing to hand focus to: esc and ↓
  // at the chat's bottom edge land where they started.
  const focusNav = useCallback((): void => {
    if (!hideNav) setFocus('nav')
  }, [hideNav])
  const refreshOnDone = useCallback((): void => {
    void poll()
  }, [poll])

  // ------------------------------- rendering --------------------------------

  // Band heights: header = blank + title line + rule (3); nav = rule + the
  // new-session row + five session rows + hint (8), or nothing when hidden.
  // The chat band gets the rest, and a terminal too short for both drops
  // session rows rather than growing the frame past the screen.
  const headerRows = 3
  const navSessionRows = Math.max(1, Math.min(NAV_SESSION_ROWS, contentRows - 10))
  const navRows = hideNav ? 0 : 3 + navSessionRows
  const chatRows = Math.max(4, contentRows - headerRows - navRows)

  // ---- band 1: the header ----
  // "ellipsis.dev" pins the left edge as always; the right edge carries the
  // focused session's live meta (id · model · cost · tokens), derived from
  // its transcript store so it ticks like the old footer did. With no
  // session focused the right edge falls back to the who-tag.
  const focusedEntry = mainPane.type === 'chat' ? entries.get(mainPane.sessionId) : undefined
  const metaText = useHeaderMeta(focusedEntry, mainPane, appBase, customerLogin, contentCols - 4)
  const whoText = props.ghLogin
    ? `@${props.ghLogin} in ${customerLogin}`
    : customerLogin
  const header = (
    // The top bar is a lifted surface, like the composer: the panel tint (not
    // a rule) is what separates it from the transcript below. Its own 2-cell
    // pad sits inside the tint, so the bar reads as a band with the title
    // floating in it rather than type pinned to an edge.
    <Box
      flexDirection="column"
      width={contentCols}
      height={headerRows}
      flexShrink={0}
      backgroundColor={theme.panel}
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
            {metaText ?? whoText}
          </Text>
        </Box>
      </Box>
    </Box>
  )

  // ---- bands 2+3: the chat window + its composer (one hosted component) ----
  let main: React.ReactElement
  if (mainPane.type === 'new') {
    main = (
      // Full width, no side padding: the prompt input's rules span the
      // terminal exactly like the header's and the nav's do.
      <Box width={contentCols} height={chatRows} flexDirection="column" overflow="hidden">
        <NewSessionPane
          width={contentCols}
          height={chatRows}
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
          height={chatRows}
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
      main = (
        // The chat window + composer, full width (bands 2 and 3 live inside
        // the hosted ConnectApp: transcript above, input box at the bottom).
        // overflow=hidden clips a mis-estimated transcript slice instead of
        // letting the frame outgrow the terminal (which scrolls Ink's render
        // region and smears stale rows on every hop). The meta line is
        // hidden here — the header renders it.
        <Box
          width={contentCols}
          height={chatRows}
          flexDirection="column"
          overflow="hidden"
        >
          <ConnectApp
            key={mainPane.sessionId}
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
            paneWidth={contentCols}
            paneHeight={chatRows}
            focused={focus === 'chat'}
            onFocusNav={focusNav}
            onDone={refreshOnDone}
            hideMetaLine
          />
        </Box>
      )
    }
  }

  // ---- band 4: the session nav ----
  // A vertical list of six rows: the pinned new-session row, then five session
  // rows (status dot + description + a dim age tag) in sortSidebarSessions
  // order — status band, newest-born first — windowed so the highlight parks
  // on the second-to-last row and the list scrolls under it. The band's height
  // is fixed, so a short list leaves blank rows rather than moving the chat
  // above it.
  const selectedRowIdx = Math.max(0, rows.findIndex((s) => s.id === selected))
  const win = navSlice(rows.length, navSessionRows, selectedRowIdx)
  const navFocused = focus === 'nav'
  const nav = (
    // The session list gets a gutter of its own on top of the app inset, so the
    // column of dots sits inboard of the frame edge instead of hugging it. The
    // pad is on the band, so every row (and the hint) shares one left edge.
    <Box
      flexDirection="column"
      height={navRows}
      flexShrink={0}
      paddingLeft={NAV_GUTTER}
      paddingRight={NAV_GUTTER}
    >
      <Box height={1} flexShrink={0} />
      {/* The highlighted row — this one and the session rows below — takes
          the active surface across its full width (the same lighter panel
          the focused composer sits on), never the inverse bar. */}
      <Box backgroundColor={selected === 'new' && navFocused ? SURFACE_ACTIVE : undefined}>
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
          // The highlighted row's background spans the whole width — the
          // meta tag included — on the same active surface as everywhere
          // else, replacing the old inverse (bone-white) description bar.
          <Box key={s.id} backgroundColor={cursorHere ? SURFACE_ACTIVE : undefined}>
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
      <Text wrap="truncate" color={theme.muted}>
        {navFocused
          ? `↑↓ move · enter open · n new · esc chat · q quit${
              win.end < rows.length ? ` · ${rows.length - win.end} more below` : ''
            }`
          : '↓/esc: sessions'}
      </Text>
    </Box>
  )

  return (
    // The brand canvas, painted edge to edge: every band sits on it, and the
    // composer's panel is the one surface lifted above it. Painting the root
    // (rather than letting the terminal's own background show through) is what
    // makes the charcoal→panel step read as intentional depth on ANY terminal
    // theme instead of only on a dark one.
    <Box
      flexDirection="column"
      minHeight={height}
      backgroundColor={theme.canvas}
      padding={APP_INSET}
    >
      {header}
      {main}
      {!hideNav && nav}
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
  const session = snapshot?.session as AgentSessionWire | undefined | null
  const costUsd = session
    ? usdNumberFromMillicents(
        session.cost_tokens +
          session.cost_sandbox_cpu +
          session.cost_sandbox_memory +
          session.cost_fee,
      )
    : 0
  const tokens = session?.tokens_total ?? 0
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
// bottom — the Repository / Agent / Model rows inside the tinted box with
// the ❯ prompt line beneath them (the dashboard card's controls-inside-the-
// composer shape). The ❯ glyph marks whichever row is selected; the whole
// panel steps to the lighter active surface while any row has focus. ↑ from
// the prompt climbs into the option rows, ↑/↓ walk them (↓ off the last
// returns to the prompt), →/enter unfolds a row's option list in place,
// inside the panel ([x] marks the pick). Inside an open list ↑/↓ walk, → (or
// enter/space) activates the
// highlighted option, ← (or esc) backs out unchanged. "Default" everywhere
// means the server resolves it (defaults ladder, DEFAULT_AGENT_MODEL, the
// detected repo). Esc — or ↓ / ← at the prompt's left edge — hands focus to
// the session nav.
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
  onSubmit: (
    text: string,
    choices: { configId: string | null; model: string | null; repos: string[] },
  ) => void
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
  // The multi-select repository set ("owner/name" full names). Empty =
  // Default (the detected repo, server-resolved).
  const [repoSel, setRepoSel] = useState<ReadonlySet<string>>(new Set())
  // The open row's dropdown state: which picker is open and where its
  // highlight sits. null = no subtree open.
  const [openPicker, setOpenPicker] = useState<{ key: PickerRow['key']; hover: number } | null>(
    null,
  )

  const configOptions = useMemo(
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
  // selection is empty (the server checks it out by default) and can be
  // checked alongside any others (repositories multi-select). Only with no
  // detection does the null Default row appear (the server still resolves
  // one, but there's no name to show).
  const repoOptions = useMemo(() => {
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
  // Whether an option is currently picked. Repo is a multi-select: an empty
  // selection means the server's default checkout, so the detected repo (or
  // the null Default row) reads [x] while nothing is explicitly checked; the
  // single-pickers match their index.
  const isPicked = (key: PickerRow['key'], at: number): boolean => {
    if (key === 'repo') {
      const id = repoOptions[at]?.id
      if (repoSel.size === 0) return id === null || id === detectedRepo
      return id !== null && repoSel.has(id)
    }
    const idx = key === 'config' ? configIdx : modelIdx
    return at === Math.min(idx, optionsFor(key).length - 1)
  }
  // Activating an option: single-pickers pick and close; the repo list
  // TOGGLES the entry ([x]↔[ ]) and stays open so several can be checked
  // (the null Default row, shown only with no detected repo, clears the set).
  const activate = (key: PickerRow['key'], at: number): void => {
    if (key === 'config') {
      setConfigIdx(at)
      setOpenPicker(null)
    } else if (key === 'model') {
      setModelIdx(at)
      setOpenPicker(null)
    } else {
      const id = repoOptions[at]?.id
      if (id == null) setRepoSel(new Set())
      else {
        setRepoSel((prev) => {
          const next = new Set(prev)
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
      repos: [...repoSel],
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

  // The summary shown on a row: the single pick's label, or the checked
  // repo set joined (the detected repo when nothing is checked).
  const rowValue = (key: PickerRow['key']): string => {
    if (key === 'repo') {
      if (repos === null) return 'loading…'
      return repoSel.size === 0 ? (detectedRepo ?? 'Default') : [...repoSel].join(', ')
    }
    if (key === 'config' && configs === null) return 'loading…'
    const options = optionsFor(key)
    const idx = key === 'config' ? configIdx : modelIdx
    return options[Math.min(idx, options.length - 1)]?.label ?? 'Default'
  }

  // How many option rows an open picker shows inside the panel: the pane
  // minus the heading, notices, and the panel's other rows (~12); the panel
  // grows upward into the spacer above, so the prompt never moves.
  const dropdownCapacity = Math.max(3, height - 12)
  // The wrap width inside the input box: the pane minus the box's own left
  // and right padding (the "▶ " prompt is part of the wrapped text).
  const inputWidth = Math.max(8, width - COMPOSER_PAD_X * 2)
  const caretVisible = focused && row === 'prompt' && !starting && openPicker === null
  const open = openPicker
  const openOptions = open ? optionsFor(open.key) : []
  const openHover = open ? Math.min(open.hover, openOptions.length - 1) : 0
  const win = open
    ? sidebarSlice(openOptions.length, dropdownCapacity, openHover)
    : { start: 0, end: 0 }

  return (
    // Bottom-docked, mirroring the chat layout: the heading floats centered
    // in the empty space (equal spacers above and below it) while the input
    // + option rows pin to the bottom edge (just above the session nav),
    // where they NEVER move — an open dropdown expands upward instead of
    // pushing the input around.
    // No pane padding: the input's rules span the full terminal width like
    // the header's and the nav's (the rows inside carry their own indents).
    <Box width={width} height={height} flexDirection="column">
      <Box flexGrow={1} />
      <Box justifyContent="center">
        <Text bold color={theme.foreground}>
          What are we shipping today?
        </Text>
      </Box>
      {/* The fact box is sized to the text (capped so long facts wrap at a
          readable measure) so short facts sit centered, not left-aligned
          inside a fixed column. */}
      <Box justifyContent="center" paddingTop={1}>
        <Box width={Math.min(fact.length, Math.max(8, width - 4), 72)}>
          <Text color={theme.muted} wrap="wrap">
            {fact}
          </Text>
        </Box>
      </Box>
      <Box flexGrow={1} />
      {error && <Text color={theme.error}> ✗ {error}</Text>}
      {starting && <Text color={theme.muted}> ✻ Starting session…</Text>}
      {/* The input panel — the SAME surface as the chat composer, stepping
          onto the lighter active surface while ANY of its four rows is where
          you are (a picker row, its open option list, or the prompt), no
          rules, with a uniform 1-cell pad inside the tint. The run controls
          live INSIDE it, one row each ABOVE the prompt (the dashboard card's
          controls-inside-the-composer shape): Repository, Agent, Model, a
          blank spacer row, then the prompt line. The ❯ selection glyph marks
          whichever row is selected. →/enter opens a picker row IN PLACE —
          its value collapses to a bare label and the option list unfolds
          indented beneath it, inside the panel (the panel grows upward into
          the spacer above; the prompt never moves). Repositories
          multi-select ([x] toggles), the others pick one. */}
      <Box
        flexDirection="column"
        backgroundColor={focused && !starting ? SURFACE_ACTIVE : SURFACE_ELEVATED}
        alignItems="flex-start"
        paddingY={1}
        paddingX={COMPOSER_PAD_X}
      >
        {PICKER_ROWS.map((r, i) => {
          const active = focused && openPicker === null && row === i
          const isOpen = open?.key === r.key
          if (isOpen) {
            return (
              <Box key={r.key} flexDirection="column" width={inputWidth}>
                <Text color={theme.muted}>{'  '}{r.label}:</Text>
                {win.start > 0 && (
                  <Text color={theme.muted}>{'    '}… {win.start} more</Text>
                )}
                {openOptions.slice(win.start, win.end).map((opt, j) => {
                  const at = win.start + j
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
                          {`[${picked ? 'x' : ' '}] ${opt.label}`}
                        </Text>
                      </Text>
                    </Box>
                  )
                })}
                {win.end < openOptions.length && (
                  <Text color={theme.muted}>
                    {'    '}… {openOptions.length - win.end} more
                  </Text>
                )}
              </Box>
            )
          }
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
