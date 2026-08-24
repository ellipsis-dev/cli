import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput, useStdin, useStdout } from 'ink'
import type { OpenSocket } from '@ellipsis-dev/sdk/stream'
import { SESSION_STREAM_PROTOCOL_VERSION } from '@ellipsis-dev/sdk/stream'
import { SessionTranscriptStore } from '@ellipsis-dev/sdk/store'
import type { Ellipsis } from '@ellipsis-dev/sdk'
import { errorDetail } from '../lib/api'
import type {
  AgentSession,
  SavedAgentConfig,
  StartAgentSessionRequest,
  SupportedModel,
} from '../lib/types'
import { applyEditShortcut } from '../lib/editing'
import { CTRL_C_QUIT_HINT, useCtrlCQuit } from './ctrlC'
import { sessionUrl } from '../lib/urls'
import {
  applyComposerChoices,
  attentionFlip,
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
  sessionConfigName,
  filterSessions,
  navSlice,
  sessionBarQuery,
  SELECTION_GLYPH,
  mergeSidebarSessions,
} from '../lib/sessions'
import type { ResolvedSessionBar } from '../lib/config'
import { inputSurface, theme } from '../lib/theme'
import { ConnectApp } from './ConnectApp'

// The multi-session UI — what a bare `agent`, `agent "prompt"`, and `agent
// session connect <id>` all open. Two screens, both on the primary buffer:
//
//   * the LAUNCHER: a compact inline block — the configuration rows on top, the
//     prompt box under them, the latest sessions last. Enter in the box starts a
//     session; enter on a session row opens its chat. It is short by design, so
//     ink repaints it in place like any live frame; no alternate screen, no
//     full-height frame.
//   * the CHAT (ConnectApp) — owns the terminal outright. Its settled
//     transcript is printed into the terminal's real scrollback, so the
//     wheel, the trackpad and select/copy are the terminal's own.
//
// esc in the chat clears the screen and returns to the launcher; enter on a
// session replaces the launcher with its chat.
// Exactly one useInput handler is active at a time.
//
// Liveness: ONE WebSocket — the focused session's, owned by its ConnectApp —
// plus a 5s REST poll of the session list for the launcher. Transcript stores
// are cached per visited session for the process lifetime, so hopping back
// repaints instantly and the stream resumes past the cached cursor.

const SESSIONS_POLL_MS = 5_000
// The launcher clock driving the "12s ago" age tags.
const AGE_TICK_MS = 5_000
// How many session rows the launcher shows; the highlight parks two rows from
// the bottom and the list scrolls under it (navSlice).
const LIST_ROWS = 5

// Everything an open picker's option row prints before its label: the row
// indent, the selection cell and its space, then the "[x] " checkbox. What the
// price column has to clear on the left.
const OPTION_GUTTER = '   '.length + 2 + '[x] '.length

// The unit the price columns are quoted in, printed once on their column head.
const RATE_UNIT = '  per 1M'

export interface SessionsAppProps {
  api: Ellipsis
  openSocket: OpenSocket
  // app.ellipsis.dev base + the customer login, for per-session dashboard links.
  appBase: string
  customerLogin: string
  // My GitHub login for the launcher's closing "@me in account" line; null on
  // an API-key credential, which has no GitHub user behind it.
  ghLogin: string | null
  // My GitHub account id — the launcher lists sessions attributed to me. null
  // (e.g. an API-key credential) lists the whole account's sessions.
  authorId: number | null
  // The repo detected from the cwd's origin remote ("owner/name"), which is
  // what the server's default resolution checks out — shown as the launcher's
  // resting Repository value. null when the cwd isn't an enrolled repo.
  detectedRepo: string | null
  // Open focused on this session (connect / prompt shorthand); undefined
  // opens on the launcher (a bare `agent`).
  initialSessionId?: string
  // The start response's resolved config name for the initial session, and a
  // caveat to show in its chat (watch-only reasons ride connectability).
  initialConfigName?: string
  initialNotice?: string
  // Which sessions the launcher lists. `hidden` drops the list entirely.
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

type MainPane = { type: 'launcher' } | { type: 'chat'; sessionId: string }

export function SessionsApp(props: SessionsAppProps): React.ReactElement {
  const { api, openSocket, appBase, customerLogin, authorId, sessionBar } = props
  const hideList = sessionBar.hidden
  const { isRawModeSupported } = useStdin()
  const { stdout, write } = useStdout()

  const [termCols, setTermCols] = useState(stdout?.columns ?? 80)
  useEffect(() => {
    if (!stdout) return
    const onResize = (): void => {
      setTermCols(stdout.columns)
    }
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])
  const width = Math.max(20, termCols - 1)

  // ---------------------------- session list data ---------------------------

  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [polledOnce, setPolledOnce] = useState(false)
  // Sessions whose status flipped active → waiting since last viewed: the
  // "an agent is blocked on you" dot. Cleared when the row is opened.
  const [attention, setAttention] = useState<ReadonlySet<string>>(new Set())
  const lastWords = useRef(new Map<string, string>())
  // Composer-spawned sessions the poll may not return yet (created < poll
  // lag, or attributed differently); merged into the list until it does.
  const [localSessions, setLocalSessions] = useState<AgentSession[]>([])

  // The last API failure from any background call (the poll, the launcher's
  // pickers). Those calls have no output of their own, so without this a broken
  // route or a dead token just shows an empty list. Rendered on the launcher's
  // status line.
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

  // The poll only feeds the launcher's rows and attention dots; with the list
  // hidden there is nothing on screen it could update.
  useEffect(() => {
    if (hideList) return
    void poll()
    const t = setInterval(() => void poll(), SESSIONS_POLL_MS)
    return () => clearInterval(t)
  }, [poll, hideList])

  // The age tags tick on their own clock (nothing else re-renders idle rows).
  const [, setAgeTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setAgeTick((n) => n + 1), AGE_TICK_MS)
    return () => clearInterval(t)
  }, [])

  const rows = useMemo(
    () => mergeSidebarSessions(sessions, localSessions),
    [localSessions, sessions],
  )

  // --------------------------------- panes ----------------------------------

  const [mainPane, setMainPane] = useState<MainPane>(
    props.initialSessionId
      ? { type: 'chat', sessionId: props.initialSessionId }
      : { type: 'launcher' },
  )

  // ------------------------------ chat entries ------------------------------

  const [entries, setEntries] = useState<ReadonlyMap<string, ChatEntry>>(new Map())
  // Sessions whose chat has already printed into this terminal's scrollback.
  // A chat mounting after any other output prints a rule naming itself first,
  // so two conversations in one scrollback don't run together (see
  // ConnectApp's scrollbackBreak).
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
          notice: [notice, c.reason].filter(Boolean).join(', ') || null,
          model: session.tokens?.model || null,
          configName: configName ?? sessionConfigName(session),
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

  // The launcher's picker options, fetched once when it first shows: the
  // dashboard composer's three choices — saved agent configs, the account's
  // repositories, and the selectable models. A models failure (an older
  // server without GET /models) leaves the list empty and the launcher falls
  // back to its built-in set.
  const [configs, setConfigs] = useState<SavedAgentConfig[] | null>(null)
  const [repos, setRepos] = useState<string[] | null>(null)
  const [models, setModels] = useState<SupportedModel[] | null>(null)
  const pickersLoading = useRef(false)
  useEffect(() => {
    if (mainPane.type !== 'launcher' || pickersLoading.current) return
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
        const { session } = await api.sessions.start(req)
        lastWords.current.set(session.id, rowStatusWord(session))
        setLocalSessions((prev) => [session, ...prev])
        setMainPane({ type: 'chat', sessionId: session.id })
        // Seed the entry from the start response's resolved config identity.
        void loadEntry(session.id, sessionConfigName(session) ?? undefined)
      } catch (err) {
        setStartError(errorDetail(err))
      } finally {
        setStarting(false)
      }
    },
    [api, loadEntry, props],
  )

  const openSession = useCallback((sessionId: string): void => {
    setAttention((prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
    setMainPane({ type: 'chat', sessionId })
  }, [])

  // Leaving a chat wipes the screen and the scrollback. The chat's settled rows
  // were printed into the terminal's own scrollback (<Static>), so they cannot
  // be un-printed: without this the launcher would paint under half a
  // transcript. Clearing also empties shownChats, so the next chat opens on a
  // clean screen with no session-break rule above it.
  const toLauncher = useCallback((): void => {
    write('\x1b[2J\x1b[3J\x1b[H')
    shownChats.current.clear()
    setMainPane({ type: 'launcher' })
  }, [write])
  const refreshOnDone = useCallback((): void => {
    void poll()
  }, [poll])

  // ctrl+c quits from the launcher and from a chat still loading — a live
  // chat owns its own, where the first press also interrupts the running turn.
  const chatMounted = mainPane.type === 'chat' && entries.has(mainPane.sessionId)
  const armed = useCtrlCQuit(!chatMounted && isRawModeSupported)

  // ------------------------------- rendering --------------------------------

  if (mainPane.type === 'chat') {
    const entry = entries.get(mainPane.sessionId)
    if (!entry) {
      return (
        <Box flexDirection="column" paddingLeft={1}>
          <Text color={theme.muted}>
            {loadError ? `✗ ${loadError}` : `loading ${mainPane.sessionId}…`}
          </Text>
          <Text color={theme.muted}>{armed ? CTRL_C_QUIT_HINT : 'esc: back'}</Text>
          <EscOnlyInput active rawMode={isRawModeSupported} onEsc={toLauncher} />
        </Box>
      )
    }
    // Anything already printed above (an earlier chat, the launcher's rows)
    // means this transcript is arriving under other output, so it opens with a
    // rule naming itself. Recorded before the render so the flag is stable for
    // this mount: the ref is what makes the FIRST chat of the process print no
    // break.
    const needsBreak = shownChats.current.size > 0 && !shownChats.current.has(mainPane.sessionId)
    shownChats.current.add(mainPane.sessionId)
    return (
      // The chat, owning the terminal: no box around it, so its settled
      // transcript prints into the terminal's own scrollback and the wheel and
      // select/copy are the terminal's.
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
        focused
        onFocusNav={toLauncher}
        onDone={refreshOnDone}
      />
    )
  }

  // Short by design: it is the launcher's last row, so it states who you are
  // rather than re-announcing the connection the rest of the block implies.
  const whoLine = props.ghLogin
    ? `@${props.ghLogin} in ${customerLogin}`
    : `${customerLogin} (api key)`

  return (
    <Launcher
      width={width}
      whoLine={whoLine}
      focused={isRawModeSupported}
      starting={starting}
      error={startError ?? apiError}
      armed={armed}
      configs={configs}
      repos={repos}
      models={models}
      detectedRepo={props.detectedRepo}
      sessions={rows}
      polledOnce={polledOnce}
      attention={attention}
      hideList={hideList}
      onSubmit={(text, choices) => void startSession(text, choices)}
      onOpenSession={openSession}
      rawMode={isRawModeSupported}
    />
  )
}

// Swallows everything except esc and ← — the keyboard owner for the loading
// placeholder, either of which returns to the launcher.
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

// One row of the launcher's configuration block: a label + the picked value(s),
// opened into its option list with →/enter (the dashboard composer's selects,
// terminal-shaped). Repositories multi-select; the others pick one.
type PickerRow = { key: 'config' | 'model' | 'repo'; label: string }
const PICKER_ROWS: readonly PickerRow[] = [
  { key: 'config', label: 'Config preset' },
  { key: 'repo', label: 'Repositories' },
  { key: 'model', label: 'Model' },
]

// What the prompt box says before you type: the whole key map for the block, so
// nothing about the launcher has to be remembered.
const PROMPT_HINT = 'Enter to start a session, up to configure it, down to explore old sessions...'

// The prompt box's interior padding, matching the chat composer's.
const PROMPT_PAD_X = 2

// Where the launcher's cursor is: the prompt box, one of the configuration rows
// (by PICKER_ROWS index), or a session row (by id, so the poll re-sorting under
// the cursor doesn't move the highlight).
type LauncherCursor =
  | { kind: 'prompt' }
  | { kind: 'option'; at: number }
  | { kind: 'list'; id: string }

// The launcher: a compact inline block, configuration on top, prompt in the
// middle, history at the bottom —
//
//     Config preset: none
//     Repositories: acme/cli
//     Model: claude-opus-5
//
//    |
//    | Enter to start a session, up to configure it, down to explore old…
//    |
//
//    Recent sessions:                                    @me in account
//    ● latest session                               $0.20, 2m ago
//    ● …                                   (LIST_ROWS rows; scrolls)
//
// ONE input, two readings: what you type is the next session's prompt AND a
// live filter over the list below, so finding old work and starting new work
// are the same gesture. Enter starts a session with the text (empty text
// starts it idle). ↑ walks up into the configuration rows, where enter (or →)
// opens that row's dropdown in place — nothing swaps out, the session list
// stays. ↓ walks down into the list, where enter opens a session.
//
// The ▶ glyph marks whichever row holds the cursor. Typing anywhere returns
// the cursor to the prompt. "Default" everywhere means the server resolves it.
// Repositories is the one multi-select ([x] toggles; uncheck everything for a
// sandbox with no checkout).
function Launcher({
  width,
  whoLine,
  focused,
  starting,
  error,
  armed,
  configs,
  repos,
  models,
  detectedRepo,
  sessions,
  polledOnce,
  attention,
  hideList,
  onSubmit,
  onOpenSession,
  rawMode,
}: {
  width: number
  whoLine: string
  focused: boolean
  starting: boolean
  error: string | null
  armed: boolean
  // null while loading; [] when the account has none / the fetch failed.
  configs: SavedAgentConfig[] | null
  repos: string[] | null
  models: SupportedModel[] | null
  // The cwd's repo ("owner/name") — what the server's default resolution
  // checks out; named on the Repository row instead of a bare "Default".
  detectedRepo: string | null
  sessions: readonly AgentSession[]
  polledOnce: boolean
  attention: ReadonlySet<string>
  hideList: boolean
  onSubmit: (text: string, choices: ComposerChoices) => void
  onOpenSession: (id: string) => void
  rawMode: boolean
}): React.ReactElement {
  const [text, setText] = useState('')
  const [textCursor, setTextCursor] = useState(0)
  const [cursor, setCursor] = useState<LauncherCursor>({ kind: 'prompt' })
  // Single-pick indices; 0 is always "Default" (server-resolved).
  const [configIdx, setConfigIdx] = useState(0)
  // null = the model row is untouched, so it tracks whichever row carries the
  // server-resolved pick (see modelIdx). The list arrives async, so there is no
  // index to seed this with at mount.
  const [modelPick, setModelPick] = useState<number | null>(null)
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
      { id: null as string | null, label: 'none' },
      ...(configs ?? []).map((c) => ({ id: c.id as string | null, label: configDisplayName(c) })),
    ],
    [configs],
  )
  // The server's selectable set (GET /models); before it lands — and on an
  // older server that has no such route — the built-in fallback list.
  const modelOptions = useMemo(() => composerModelOptions(models ?? []), [models])
  // The checked model row: the explicit pick, else the account default's row
  // (the one carrying the null id), else the first.
  const modelIdx = useMemo(() => {
    if (modelPick !== null) return Math.min(modelPick, modelOptions.length - 1)
    const at = modelOptions.findIndex((o) => o.id === null)
    return at === -1 ? 0 : at
  }, [modelPick, modelOptions])
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
      setModelPick(at)
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
      model: modelOptions[modelIdx]?.id ?? null,
      repos: repoSel === null ? null : [...repoSel],
    })
  }

  // The rows below the prompt: the typed text filters the list live, so the
  // prompt doubles as a search box over your recent sessions.
  const shown = useMemo(() => filterSessions(sessions, text), [sessions, text])

  // Where the list cursor sits in the current sort; the id survives the poll
  // re-sorting rows, and a session that left the list snaps to the top.
  const listIdx =
    cursor.kind === 'list' ? Math.max(0, shown.findIndex((s) => s.id === cursor.id)) : 0

  const toPromptWith = (ch: string): void => {
    setCursor({ kind: 'prompt' })
    setText((t) => t.slice(0, textCursor) + ch + t.slice(textCursor))
    setTextCursor((c) => c + ch.length)
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
      if (starting) return
      // Word/line jumps and kills (option+←/→, ctrl+a/e/w/u/k, …) act on the
      // prompt from anywhere in the launcher, dropping the cursor back onto it.
      const edited = applyEditShortcut({ text, cursor: textCursor }, ch, key)
      if (edited) {
        setCursor({ kind: 'prompt' })
        setText(edited.text)
        setTextCursor(edited.cursor)
        return
      }
      if (cursor.kind === 'option') {
        // The configuration rows above the prompt: ↑ walks up them and stops at
        // the first, ↓ off the last returns to the prompt, →/enter opens the
        // row's list, esc returns to the prompt, typing does too.
        if (key.upArrow) {
          if (cursor.at > 0) setCursor({ kind: 'option', at: cursor.at - 1 })
          return
        }
        if (key.downArrow) {
          if (cursor.at < PICKER_ROWS.length - 1) setCursor({ kind: 'option', at: cursor.at + 1 })
          else setCursor({ kind: 'prompt' })
          return
        }
        if (key.return || key.rightArrow) {
          setOpenPicker({ key: PICKER_ROWS[cursor.at].key, hover: 0 })
          return
        }
        if (key.escape) {
          setCursor({ kind: 'prompt' })
          return
        }
        if (ch && !key.ctrl && !key.meta) toPromptWith(ch)
        return
      }
      if (cursor.kind === 'list') {
        // The session rows at the bottom: ↑/↓ walk them (↑ off the top climbs
        // back to the prompt), enter opens the highlighted session.
        if (key.upArrow) {
          if (listIdx <= 0) setCursor({ kind: 'prompt' })
          else setCursor({ kind: 'list', id: shown[listIdx - 1].id })
          return
        }
        if (key.downArrow) {
          if (listIdx < shown.length - 1)
            setCursor({ kind: 'list', id: shown[listIdx + 1].id })
          return
        }
        if (key.return) {
          const picked = shown[listIdx]
          if (picked) onOpenSession(picked.id)
          return
        }
        if (key.escape) {
          setCursor({ kind: 'prompt' })
          return
        }
        if (ch && !key.ctrl && !key.meta) toPromptWith(ch)
        return
      }
      // At the prompt box: ↑ lands on the LAST configuration row (the one just
      // above it), ↓ on the first session row.
      if (key.return) {
        submit()
        return
      }
      if (key.upArrow) {
        setCursor({ kind: 'option', at: PICKER_ROWS.length - 1 })
        return
      }
      if (key.downArrow) {
        if (!hideList && shown.length > 0) setCursor({ kind: 'list', id: shown[0].id })
        return
      }
      if (key.leftArrow) {
        setTextCursor((c) => Math.max(0, c - 1))
        return
      }
      if (key.rightArrow) {
        setTextCursor((c) => Math.min(text.length, c + 1))
        return
      }
      if (key.backspace || key.delete) {
        if (textCursor > 0) {
          setText((t) => t.slice(0, textCursor - 1) + t.slice(textCursor))
          setTextCursor((c) => c - 1)
        }
        return
      }
      // esc clears the typed text — the one-key way out of a filter that
      // matched nothing.
      if (key.escape) {
        setText('')
        setTextCursor(0)
        return
      }
      if (key.ctrl || key.meta) return
      if (ch) {
        setText((t) => t.slice(0, textCursor) + ch + t.slice(textCursor))
        setTextCursor((c) => c + ch.length)
      }
    },
    { isActive: focused && rawMode },
  )

  // The summary shown on a row: the single pick's label, or the checked repo
  // set joined (the detected repo while the list is untouched, "none" once you
  // have explicitly unchecked everything — a sandbox with no checkout). Never
  // "loading…": every resting value is known locally, so a pending fetch has
  // nothing to do with what this run would use.
  const rowValue = (key: PickerRow['key']): string => {
    if (key === 'repo') {
      if (repoSel === null) return detectedRepo ?? 'Default'
      if (repoSel.size === 0) return 'none'
      return [...repoSel].join(', ')
    }
    const options = optionsFor(key)
    const idx = key === 'config' ? configIdx : modelIdx
    return options[Math.min(idx, options.length - 1)]?.label ?? 'Default'
  }

  const open = openPicker
  const openOptions = open ? optionsFor(open.key) : []
  const openHover = open ? Math.min(open.hover, openOptions.length - 1) : 0
  // Every option plus its group heading — an open dropdown prints the whole
  // list, so a long model list grows the block and the terminal scrolls rather
  // than hiding rows behind a window.
  const visibleRows = open ? composerPickerRows(openOptions) : []
  // The price table's column widths: the label column, then one numeric column
  // per lane, each as wide as its widest cell (its heading included) so the
  // dollars read down a right-aligned column. null when there is no price to
  // quote, or when the terminal is too narrow to hold the whole table — a
  // padded row would push the last column off the right edge.
  const rateTable = (() => {
    if (!openOptions.some((o) => o.rate)) return null
    const label = Math.max(...openOptions.map((o) => o.label.length))
    const input = Math.max(2, ...openOptions.map((o) => (o.rate?.input ?? '').length))
    const output = Math.max(3, ...openOptions.map((o) => (o.rate?.output ?? '').length))
    const total = OPTION_GUTTER + label + 2 + input + 2 + output + RATE_UNIT.length
    return total <= width ? { label, input, output } : null
  })()
  // A row's price cells, right-aligned into the table's columns. A model the
  // server quoted no card for prints blank cells rather than shifting the ones
  // below it out of column.
  const rateCells = (rate: ComposerModel['rate']): string =>
    rateTable
      ? '  ' +
        (rate?.input ?? '').padStart(rateTable.input) +
        '  ' +
        (rate?.output ?? '').padStart(rateTable.output)
      : ''

  const caretVisible = focused && cursor.kind === 'prompt' && !starting && openPicker === null
  const listWin = navSlice(shown.length, LIST_ROWS, listIdx)
  const showList = !hideList
  // The bottom line is for news only — the prompt box's hint already carries the
  // key map, so there is nothing routine to print here.
  const statusLine = armed ? CTRL_C_QUIT_HINT : starting ? '✻ Starting session…' : null

  return (
    <Box flexDirection="column" width={width}>
      {/* What the next run will use, on top: three rows you walk with ↑ from the
          prompt box, each opening its own list in place. */}
      {PICKER_ROWS.map((r, i) => {
        const active = focused && cursor.kind === 'option' && cursor.at === i
        const isOpen = open?.key === r.key
        return (
          <Box key={r.key} flexDirection="column" width={width}>
            <Box width={width}>
              <Box width={2} flexShrink={0}>
                <Text color={theme.cursor}>{active ? SELECTION_GLYPH : ' '}</Text>
              </Box>
              <Text wrap="truncate">
                <Text color={theme.muted}>{r.label}: </Text>
                <Text color={active ? theme.foreground : theme.muted}>{rowValue(r.key)}</Text>
              </Text>
            </Box>
            {/* The price table's column heads, over the numeric columns they
                name, with the unit stated once here instead of on every row. */}
            {isOpen && rateTable && (
              <Box width={width}>
                <Text wrap="truncate" color={theme.muted}>
                  {' '.repeat(OPTION_GUTTER + rateTable.label)}
                  {rateCells({ input: 'IN', output: 'OUT' })}
                  {RATE_UNIT}
                </Text>
              </Box>
            )}
            {isOpen &&
              visibleRows.map((pickerRow) => {
                // A group heading: the vendor that built the models under it,
                // upper-cased into an eyebrow the way the dashboard's
                // rate-card table sets its own, and muted so it reads as
                // structure rather than as another pickable row.
                if (pickerRow.kind === 'group') {
                  return (
                    <Box key={`group:${pickerRow.label}`} width={width}>
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
                  <Box key={opt.id ?? 'default'} width={width}>
                    <Text wrap="truncate">
                      {'   '}
                      <Text color={theme.cursor}>
                        {hovered ? SELECTION_GLYPH : ' '}
                      </Text>{' '}
                      <Text color={hovered || picked ? theme.foreground : theme.muted}>
                        {`[${picked ? 'x' : ' '}] ${rateTable ? opt.label.padEnd(rateTable.label) : opt.label}`}
                      </Text>
                      {/* The prices, always muted — the table's numbers next
                          to the id whether or not the row is the highlighted
                          one, so walking the list never moves the eye off the
                          name. */}
                      <Text color={theme.muted}>{rateCells(opt.rate)}</Text>
                    </Text>
                  </Box>
                )
              })}
          </Box>
        )
      })}
      {/* The prompt box: the chat composer's painted slab, with an accent bar
          down its left edge and a blank row of padding above and below the
          input. Wraps instead of truncating, so a long prompt grows the box
          downward rather than running off the right edge. The key remounts the
          node so a stale measurement can't misplace the caret. */}
      <Text> </Text>
      <Box
        width={width}
        backgroundColor={inputSurface}
        borderStyle="bold"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderLeftColor={focused && cursor.kind === 'prompt' ? theme.cursor : theme.muted}
        paddingY={1}
        paddingX={PROMPT_PAD_X}
      >
        <Text
          wrap="wrap"
          key={`${text}:${textCursor}:${cursor.kind === 'prompt'}`}
          color={theme.foreground}
        >
          {text.slice(0, textCursor)}
          {caretVisible && text !== '' && (
            <Text inverse>{textCursor < text.length ? text[textCursor] : ' '}</Text>
          )}
          {textCursor < text.length ? text.slice(textCursor + (caretVisible ? 1 : 0)) : ''}
          {/* Empty input: the hint sits where typed text will land, its first
              character carrying the caret (inverse) instead of a caret cell of
              its own pushing it a column right. */}
          {text === '' && caretVisible && (
            <Text>
              <Text inverse>{PROMPT_HINT[0]}</Text>
              <Text color={theme.muted}>{PROMPT_HINT.slice(1)}</Text>
            </Text>
          )}
          {text === '' && !caretVisible && <Text color={theme.muted}>{PROMPT_HINT}</Text>}
        </Text>
      </Box>
      {/* Two blank rows splitting what you are about to start from what you have
          already run. */}
      <Text> </Text>
      <Text> </Text>
      {/* The list's own heading, with who you are on the same row's right edge:
          both are true of every row under them and neither is something you act
          on. */}
      <Box width={width}>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate" color={theme.muted}>
            {showList ? ' Recent sessions:' : ' '}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text color={theme.muted}>{whoLine}</Text>
        </Box>
      </Box>
      {/* The latest sessions: status dot + description + a dim meta tag, in
          sortSidebarSessions order (status band, newest first), windowed so the
          highlight parks two rows from the bottom and the list scrolls under
          it. */}
      {showList &&
        shown.slice(listWin.start, listWin.end).map((s) => {
          const word = rowStatusWord(s)
          const g = rowGlyph(word)
          const cursorHere = focused && cursor.kind === 'list' && shown[listIdx]?.id === s.id
          const desc = rowDescription(s)
          // The meta tag rides the right edge; the description takes what's
          // left and truncates, so a long prompt can never push the tag off
          // the row.
          const meta = `${rowMeta(s)}${attention.has(s.id) ? ', needs you' : ''}`
          const descW = Math.max(8, width - meta.length - 8)
          return (
            <Box key={s.id} width={width}>
              <Box width={3} paddingLeft={1} flexShrink={0}>
                <Text color={cursorHere ? theme.cursor : g.color} dimColor={!cursorHere && g.dim}>
                  {cursorHere ? SELECTION_GLYPH : g.glyph}
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate">
                  <Text
                    color={
                      cursorHere || attention.has(s.id) || !g.dim
                        ? theme.foreground
                        : theme.muted
                    }
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
      {showList && shown.length === 0 && (
        <Text color={theme.muted}>
          {'   '}
          {!polledOnce
            ? 'loading sessions…'
            : sessions.length === 0
              ? 'no sessions yet'
              : 'no matching sessions'}
        </Text>
      )}
      {/* An API failure gets its own line — a swallowed error is an empty
          list with no explanation. */}
      {error && (
        <Text wrap="truncate" color={theme.error}>
          {`✗ ${error}`}
        </Text>
      )}
      {statusLine && (
        <Text wrap="truncate" color={theme.muted}>
          {statusLine}
        </Text>
      )}
    </Box>
  )
}
