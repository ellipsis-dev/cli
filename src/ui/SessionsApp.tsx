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
import { SESSION_STREAM_PROTOCOL_VERSION, sessionStatusWord } from '@ellipsis-dev/sdk/stream'
import { SessionTranscriptStore } from '@ellipsis-dev/sdk/store'
import type { AgentSessionWire } from '@ellipsis-dev/sdk'
import type { ApiClient } from '../lib/api'
import { ApiError } from '../lib/api'
import type {
  AgentSession,
  SavedAgentConfig,
  StartAgentSessionRequest,
} from '../lib/types'
import { hyperlink, sessionUrl } from '../lib/urls'
import { usdNumberFromMillicents } from '../lib/output'
import { VERSION } from '../lib/constants'
import {
  attentionFlip,
  COMPOSER_MODELS,
  configDisplayName,
  connectability,
  lastEventAt,
  repoOverrideEntry,
  rowDescription,
  rowGlyph,
  rowStatusWord,
  SELECTION_GLYPH,
  shortAge,
  sidebarSlice,
  sortSidebarSessions,
} from '../lib/sessions'
import { ConnectApp } from './ConnectApp'

// The multi-session UI, a vertical stack of four bands:
//   1. the header — " ellipsis.dev" plus the focused session's meta
//      (status · cost · model · id · version), closed by a rule
//   2. the chat window (the hosted ConnectApp, full width)
//   3. the text input (the ConnectApp's composer)
//   4. the session nav — your running sessions as a horizontal bar
// This is what a bare `agent`, `agent "prompt"`, and `agent session
// connect <id>` all open.
//
// Focus is modal and esc steps outward: inside the chat esc closes panels,
// then transcript navigation, then lands on the nav bar. ↓ at the composer's
// last line reaches the nav too; enter (or ↑/esc) hands it back. Exactly one
// useInput handler is active at a time.
//
// Liveness: ONE WebSocket — the focused session's, owned by its ConnectApp —
// plus a 5s REST poll of the session list for the nav. Transcript stores are
// cached per visited session for the process lifetime, so hopping back
// repaints instantly and the stream resumes past the cached cursor.

const SIDEBAR_POLL_MS = 5_000
const SIDEBAR_LIMIT = 50
// The nav clock driving the "12s" age tags.
const AGE_TICK_MS = 5_000
// One nav cell: dot + truncated description + age, fixed width so the bar
// windows predictably.
const NAV_ITEM_W = 30

export interface SessionsAppProps {
  api: ApiClient
  openSocket: OpenSocket
  // app.ellipsis.dev base + the customer login, for per-session dashboard links.
  appBase: string
  customerLogin: string
  // My GitHub account id — the sidebar lists sessions attributed to me. null
  // (e.g. an API-key credential) lists the whole account's sessions.
  authorId: number | null
  // Open focused on this session (connect / prompt shorthand); undefined
  // opens on the new-session composer (a bare `agent`).
  initialSessionId?: string
  // The start response's resolved config name for the initial session, and a
  // caveat to show in its chat (watch-only reasons ride connectability).
  initialConfigName?: string
  initialNotice?: string
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

  useEffect(() => {
    void poll()
    const t = setInterval(() => void poll(), SIDEBAR_POLL_MS)
    return () => clearInterval(t)
  }, [poll])

  // The age lines tick on their own clock (nothing else re-renders idle rows).
  const [, setAgeTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setAgeTick((n) => n + 1), AGE_TICK_MS)
    return () => clearInterval(t)
  }, [])

  const rows = useMemo(
    () => sortSidebarSessions([...localSessions, ...sessions]),
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
  // first opens: saved agent configs and the account's repositories (the
  // dashboard composer's choices; models are the static selectable set).
  const [configs, setConfigs] = useState<SavedAgentConfig[] | null>(null)
  const [repos, setRepos] = useState<string[] | null>(null)
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

  // The selectable id list, left to right: the pinned new cell, then sessions.
  const selectable = useMemo(() => ['new', ...rows.map((s) => s.id)], [rows])

  useInput(
    (ch, key) => {
      // The nav is a horizontal bar: ←/→ move the highlight, enter opens
      // the highlighted session, ↑/esc return to the chat.
      if (key.leftArrow || key.rightArrow) {
        const idx = selectable.indexOf(selected)
        const next = key.leftArrow
          ? Math.max(0, idx < 0 ? 0 : idx - 1)
          : Math.min(selectable.length - 1, idx < 0 ? 0 : idx + 1)
        setSelected(selectable[next])
        return
      }
      if (key.return) {
        openSelected()
        return
      }
      if (key.upArrow || key.escape) {
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

  const focusNav = useCallback((): void => setFocus('nav'), [])
  const refreshOnDone = useCallback((): void => {
    void poll()
  }, [poll])

  // ------------------------------- rendering --------------------------------

  // Band heights: header = blank + title line + rule (3); nav = rule +
  // 2-line cells + hint (4). The chat band gets the rest.
  const headerRows = 3
  const navRows = 4
  const chatRows = Math.max(4, height - headerRows - navRows)

  // ---- band 1: the header ----
  // The focused session's live meta (status · cost · model · id · version),
  // derived from its transcript store so it ticks like the old footer did.
  const focusedEntry = mainPane.type === 'chat' ? entries.get(mainPane.sessionId) : undefined
  const metaText = useHeaderMeta(focusedEntry, mainPane, appBase, customerLogin)
  const header = (
    <Box flexDirection="column" height={headerRows} flexShrink={0}>
      <Box height={1} flexShrink={0} />
      <Box paddingLeft={1}>
        <Text bold>ellipsis.dev</Text>
        {metaText && <Text dimColor>  ·  {metaText}</Text>}
      </Box>
      <Text dimColor>{'─'.repeat(Math.max(0, termCols))}</Text>
    </Box>
  )

  // ---- bands 2+3: the chat window + its composer (one hosted component) ----
  let main: React.ReactElement
  if (mainPane.type === 'new') {
    main = (
      <Box
        width={termCols}
        height={chatRows}
        flexDirection="column"
        overflow="hidden"
        paddingLeft={1}
        paddingRight={1}
      >
        <NewSessionPane
          width={termCols - 2}
          height={chatRows}
          focused={focus === 'chat'}
          starting={starting}
          error={startError}
          configs={configs}
          repos={repos}
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
          width={termCols}
          height={chatRows}
          flexDirection="column"
          paddingLeft={2}
          paddingRight={1}
          paddingTop={1}
        >
          <Text dimColor>
            {loadError ? `✗ ${loadError}` : `loading ${mainPane.sessionId}…`}
          </Text>
          {loadError && <Text dimColor>esc: back to the sessions</Text>}
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
          width={termCols}
          height={chatRows}
          flexDirection="column"
          overflow="hidden"
          paddingLeft={1}
          paddingRight={1}
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
            paneWidth={termCols - 2}
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
  // A horizontal bar of fixed-width cells (status dot + description over a
  // dim age line), windowed around the highlight. The pinned "+ New" cell
  // leads.
  const cellCapacity = Math.max(1, Math.floor((termCols - 10) / NAV_ITEM_W))
  const selectedRowIdx = Math.max(0, rows.findIndex((s) => s.id === selected))
  const win = sidebarSlice(rows.length, cellCapacity, selectedRowIdx)
  const navFocused = focus === 'nav'
  const nav = (
    <Box flexDirection="column" height={navRows} flexShrink={0}>
      <Text dimColor>{'─'.repeat(Math.max(0, termCols))}</Text>
      <Box>
        {/* The pinned new-session cell. */}
        <Box width={8} flexShrink={0} flexDirection="column">
          <Text wrap="truncate">
            {' '}
            {selected === 'new' && navFocused ? (
              <Text bold color="cyan" inverse>
                {` ${SELECTION_GLYPH} New `}
              </Text>
            ) : (
              <Text bold color="cyan">
                + New
              </Text>
            )}
          </Text>
          <Text> </Text>
        </Box>
        {win.start > 0 && (
          <Box width={2} flexShrink={0}>
            <Text dimColor>‹</Text>
          </Box>
        )}
        {rows.slice(win.start, win.end).map((s) => {
          const word = rowStatusWord(s)
          const g = rowGlyph(word)
          const cursorHere = selected === s.id && navFocused
          const isOpen = mainPane.type === 'chat' && mainPane.sessionId === s.id
          const desc = rowDescription(s)
          const descW = NAV_ITEM_W - 4
          return (
            <Box key={s.id} width={NAV_ITEM_W} flexShrink={0} flexDirection="column">
              <Text wrap="truncate">
                {' '}
                <Text color={cursorHere ? 'cyan' : g.color} dimColor={!cursorHere && g.dim}>
                  {cursorHere ? SELECTION_GLYPH : g.glyph}
                </Text>{' '}
                <Text
                  color={cursorHere ? 'cyan' : attention.has(s.id) ? 'cyan' : undefined}
                  inverse={cursorHere}
                  bold={isOpen}
                  dimColor={!cursorHere && !attention.has(s.id) && g.dim}
                >
                  {cursorHere
                    ? ` ${desc.slice(0, Math.max(4, descW - 2))} `
                    : desc.slice(0, Math.max(4, descW))}
                </Text>
              </Text>
              <Text wrap="truncate">
                {'   '}
                <Text dimColor>
                  {shortAge(lastEventAt(s))} · {s.source === 'laptop' ? 'laptop' : 'cloud'}
                  {attention.has(s.id) ? ' · needs you' : ''}
                </Text>
              </Text>
            </Box>
          )
        })}
        {win.end < rows.length && (
          <Box flexShrink={0}>
            <Text dimColor>› {rows.length - win.end} more</Text>
          </Box>
        )}
        {rows.length === 0 && (
          <Text dimColor>{polledOnce ? ' no sessions yet' : ' loading sessions…'}</Text>
        )}
      </Box>
      <Text wrap="truncate" dimColor>
        {navFocused
          ? ' ←→ move · enter open · n new · ↑ chat · q quit'
          : ' ↓/esc: sessions'}
      </Text>
    </Box>
  )

  return (
    <Box flexDirection="column" minHeight={height}>
      {header}
      {main}
      {nav}
    </Box>
  )
}

// The header's live meta for the focused session: status · cost · model ·
// id (hyperlinked) · version, derived from the session's transcript store
// so it ticks with the stream exactly like the old in-chat footer.
function useHeaderMeta(
  entry: ChatEntry | undefined,
  mainPane: MainPane,
  appBase: string,
  customerLogin: string,
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
  const statusWord = session ? sessionStatusWord(session) : 'starting'
  const costUsd = session
    ? usdNumberFromMillicents(
        session.cost_tokens +
          session.cost_sandbox_cpu +
          session.cost_sandbox_memory +
          session.cost_fee,
      )
    : 0
  return [
    `${statusWord} · $${costUsd.toFixed(2)}`,
    ...(entry.model ? [entry.model] : []),
    hyperlink(
      sessionUrl(appBase, customerLogin, mainPane.sessionId),
      `${mainPane.sessionId.slice(0, 20)}…`,
    ),
    ...(entry.configName ? [entry.configName] : []),
    `v${VERSION}`,
  ].join(' · ')
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
// (app.ellipsis.dev/[login]): a centered "What would you like to do?"
// heading a third of the way down, then ONE box — a single-line prompt
// input with the Agent / Model / Repository selects as compact chips along
// the box's bottom edge. ↓ from the prompt reaches the chip row, ←/→ move
// between chips, enter/↓ opens a chip's option list ([x] marks the pick).
// Inside an open list ↑/↓ walk, → (or enter/space) activates the
// highlighted option, ← (or esc) backs out of the subtree unchanged.
// "Default" everywhere means the server resolves it (defaults ladder,
// DEFAULT_AGENT_MODEL, the detected repo). Esc — or ← at the prompt's left
// edge / the leftmost chip — hands focus to the sidebar.
function NewSessionPane({
  width,
  height,
  focused,
  starting,
  error,
  configs,
  repos,
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
  onSubmit: (
    text: string,
    choices: { configId: string | null; model: string | null; repos: string[] },
  ) => void
  onLeave: () => void
  rawMode: boolean
}): React.ReactElement {
  const [text, setText] = useState('')
  const [cursor, setCursor] = useState(0)
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
  const modelOptions = COMPOSER_MODELS
  const repoOptions = useMemo(
    () => [
      { id: null as string | null, label: 'Default (detected)' },
      ...(repos ?? []).map((r) => ({ id: r as string | null, label: r })),
    ],
    [repos],
  )
  const optionsFor = (key: PickerRow['key']) =>
    key === 'config' ? configOptions : key === 'model' ? modelOptions : repoOptions
  // Whether an option is currently picked. Repo is a multi-select (id null
  // = the Default entry, picked while the set is empty); the others match
  // their single index.
  const isPicked = (key: PickerRow['key'], at: number): boolean => {
    if (key === 'repo') {
      const id = repoOptions[at]?.id
      return id === null ? repoSel.size === 0 : repoSel.has(id ?? '')
    }
    const idx = key === 'config' ? configIdx : modelIdx
    return at === Math.min(idx, optionsFor(key).length - 1)
  }
  // Activating an option: single-pickers pick and close; the repo list
  // TOGGLES the entry ([x]↔[ ]) and stays open so several can be checked
  // (Default clears the set).
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

  const submit = (): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSubmit(trimmed, {
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
      if (row !== 'prompt') {
        // The option rows under the prompt box, walked vertically: ↑/↓ move
        // between them (↑ off the first returns to the prompt, ↓ off the
        // last continues to the session nav), →/enter opens the row's list,
        // ← leaves for the nav, typing returns to the prompt.
        if (key.upArrow) {
          if (row === 0) setRow('prompt')
          else setRow(row - 1)
          return
        }
        if (key.downArrow) {
          if (row >= PICKER_ROWS.length - 1) onLeave()
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
      if (key.downArrow) {
        setRow(0)
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
      if (key.ctrl || key.meta || key.tab || key.upArrow) return
      if (ch) {
        setText((t) => t.slice(0, cursor) + ch + t.slice(cursor))
        setCursor((c) => c + ch.length)
      }
    },
    { isActive: focused && rawMode },
  )

  // The summary shown on a row: the single pick's label, or the checked
  // repo set joined (Default when empty).
  const rowValue = (key: PickerRow['key']): string => {
    if (key === 'repo') {
      if (repos === null) return 'loading…'
      return repoSel.size === 0 ? 'Default (detected)' : [...repoSel].join(', ')
    }
    if (key === 'config' && configs === null) return 'loading…'
    const options = optionsFor(key)
    const idx = key === 'config' ? configIdx : modelIdx
    return options[Math.min(idx, options.length - 1)]?.label ?? 'Default'
  }

  // How many dropdown options fit in the space above the input: the pane
  // minus the heading, notices, input box, rows, and hints (~13 rows).
  const dropdownCapacity = Math.max(3, height - 13)
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
    <Box width={width} height={height} flexDirection="column" paddingLeft={1}>
      <Box flexGrow={1} />
      <Box justifyContent="center">
        <Text bold>What would you like to do?</Text>
      </Box>
      <Box flexGrow={1} />
      {error && <Text color="red">✗ {error}</Text>}
      {starting && <Text dimColor>✻ Starting session…</Text>}
      {/* The open row's option list, a popup ABOVE the input (the input is
          docked; menus open upward like any bottom bar's): ↑/↓ walk,
          → activates, ← backs out. [x] marks the pick. */}
      {open && (
        <Box flexDirection="column" paddingLeft={4}>
          <Text dimColor>{PICKER_ROWS.find((r) => r.key === open.key)?.label}:</Text>
          {win.start > 0 && <Text dimColor>… {win.start} more</Text>}
          {openOptions.slice(win.start, win.end).map((opt, j) => {
            const at = win.start + j
            const hovered = at === openHover
            const picked = isPicked(open.key, at)
            return (
              <Text key={opt.id ?? 'default'} wrap="truncate">
                <Text color="cyan">{hovered ? SELECTION_GLYPH : ' '}</Text>{' '}
                <Text
                  color={hovered ? 'cyan' : undefined}
                  inverse={hovered}
                  dimColor={!hovered && !picked}
                >
                  {hovered
                    ? ` [${picked ? 'x' : ' '}] ${opt.label} `
                    : `[${picked ? 'x' : ' '}] ${opt.label}`}
                </Text>
              </Text>
            )
          })}
          {win.end < openOptions.length && (
            <Text dimColor>… {openOptions.length - win.end} more</Text>
          )}
          <Text dimColor>
            {open.key === 'repo' ? '→ toggle · ← done' : '→ select · ← back'}
          </Text>
        </Box>
      )}
      {/* The prompt input — the SAME box shape as the chat composer: a
          3-row area framed by full-width top and bottom rules, no side
          borders. */}
      <Box
        flexDirection="column"
        borderStyle="single"
        borderLeft={false}
        borderRight={false}
        borderDimColor
        minHeight={5}
        alignItems="flex-start"
        paddingLeft={1}
      >
        <Text wrap="truncate" key={`${text}:${cursor}:${focused && row === 'prompt'}`}>
          <Text color="cyan" dimColor={!focused || row !== 'prompt'}>
            {SELECTION_GLYPH}{' '}
          </Text>
          {text.slice(0, cursor)}
          {focused && row === 'prompt' && !starting && openPicker === null && (
            <Text inverse>{cursor < text.length ? text[cursor] : ' '}</Text>
          )}
          {cursor < text.length
            ? text.slice(
                cursor +
                  (focused && row === 'prompt' && !starting && openPicker === null ? 1 : 0),
              )
            : ''}
          {text === '' && (focused && row === 'prompt' ? '' : ' ')}
          {text === '' && <Text dimColor>Describe the task…</Text>}
        </Text>
      </Box>
      {/* The run controls, one row each below the input: Repository, Agent,
          Model. →/enter opens a row's option list ABOVE the input (the
          input never moves); repositories multi-select ([x] toggles), the
          others pick one. */}
      {PICKER_ROWS.map((r, i) => {
        const active = focused && openPicker === null && row === i
        const isOpen = openPicker?.key === r.key
        return (
          <Text key={r.key} wrap="truncate">
            {'  '}
            <Text color="cyan" dimColor={!active && !isOpen}>
              {active || isOpen ? SELECTION_GLYPH : ' '}
            </Text>{' '}
            <Text dimColor>{r.label}: </Text>
            <Text
              color={active || isOpen ? 'cyan' : undefined}
              inverse={active}
              dimColor={!active && !isOpen}
            >
              {active ? ` ${rowValue(r.key)} ` : rowValue(r.key)}
            </Text>
            {active ? <Text dimColor> (→: choose)</Text> : null}
          </Text>
        )
      })}
      {/* Always rendered (blank while a dropdown is open) so the docked
          input never shifts by the hint row's height. */}
      <Text dimColor>
        {open ? ' ' : '  enter: start · ↓ options · esc: sessions'}
      </Text>
    </Box>
  )
}
