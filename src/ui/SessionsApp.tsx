import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput, useStdin, useStdout } from 'ink'
import type { OpenSocket } from '@ellipsis-dev/sdk/stream'
import { SessionTranscriptStore, seedTranscriptStore } from '@ellipsis-dev/sdk/store'
import type { Ellipsis } from '@ellipsis-dev/sdk'
import { errorDetail } from '../lib/api'
import type {
  AgentSession,
  EnvironmentDefaults,
  RepositorySummary,
  SavedEnvironment,
  StartAgentSessionRequest,
  SupportedModel,
} from '../lib/types'
import { applyEditShortcut } from '../lib/editing'
import { CTRL_C_QUIT_HINT, useCtrlCQuit } from './ctrlC'
import { sessionUrl } from '../lib/urls'
import {
  ADD_MCP_SERVER_LABEL,
  ADD_VARIABLE_LABEL,
  applyComposerChoices,
  builtInMcpServers,
  attentionFlip,
  composerModelOptions,
  composerPickerRows,
  connectability,
  EMPTY_ENVIRONMENT_ID,
  environmentOptions,
  environmentPickerAt,
  environmentPickerCount,
  environmentPickerRows,
  environmentRowSummary,
  environmentSourceLabel,
  parseVariableEntry,
  repositoryRefLabel,
  variableRowLabel,
  EMPTY_COMPUTE,
  EMPTY_HOOKS,
  EMPTY_IMAGE,
  type ComposerChoices,
  type ComposerModel,
  type ComputeField,
  type CustomCompute,
  type CustomHooks,
  type CustomImage,
  type CustomMcpServer,
  type CustomRepository,
  type CustomVariable,
  validateMcpServer,
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
//   * the LAUNCHER: a compact inline block — one prompt box holding the
//     configuration rows and the input, the latest sessions under it. Enter in
//     the box starts a session; enter on a session row opens its chat. It is
//     short by design, so ink repaints it in place like any live frame; no
//     alternate screen, no full-height frame.
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

  // Seed a transcript store exactly like the solo connect, so the first
  // paint is instant and the stream resumes past the seeded cursor.
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
        // Same cast as runConnect: REST marks nullable fields optional, the
        // frame types require them. Identical JSON either way.
        seedTranscriptStore(store, {
          session,
          records: page.records,
          messages: page.messages,
          earliestFeedSeq: page.earliest_feed_seq,
        } as Parameters<typeof seedTranscriptStore>[1])
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

  // The launcher's picker options, fetched once when it first shows: the saved
  // environments (with the defaults ladder, so the untouched row can name the
  // one the server would resolve) and the selectable models. A models failure
  // (an older server without GET /models) leaves the list empty and the
  // launcher falls back to its built-in set.
  const [environments, setEnvironments] = useState<SavedEnvironment[] | null>(null)
  const [environmentDefaults, setEnvironmentDefaults] = useState<EnvironmentDefaults | null>(null)
  const [secretNames, setSecretNames] = useState<string[] | null>(null)
  const [repos, setRepos] = useState<RepositorySummary[] | null>(null)
  const [models, setModels] = useState<SupportedModel[] | null>(null)
  // The built-in MCP server names available on this account (from the
  // connected integrations); [] until the fetch lands or when none are.
  const [builtInServers, setBuiltInServers] = useState<string[]>([])
  const pickersLoading = useRef(false)
  useEffect(() => {
    if (mainPane.type !== 'launcher' || pickersLoading.current) return
    pickersLoading.current = true
    void api.environments
      .list()
      .then((rows) => setEnvironments(rows.environments))
      .catch((err) => {
        setEnvironments([])
        reportApiError('environments', err)
      })
    void api.environments.defaults
      .list()
      .then(setEnvironmentDefaults)
      .catch((err) => {
        reportApiError('default environments', err)
      })
    void api.secrets
      .list()
      .then((r) => setSecretNames(r.secrets.map((s) => s.name)))
      .catch((err) => {
        setSecretNames([])
        reportApiError('variables', err)
      })
    void api.integrations.github
      .repos()
      .then((r) => setRepos(r.repositories))
      .catch((err) => {
        setRepos([])
        reportApiError('repositories', err)
      })
    void api.integrations
      .list()
      .then((r) => setBuiltInServers(builtInMcpServers(r)))
      .catch((err) => {
        reportApiError('integrations', err)
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
      environments={environments}
      environmentDefaults={environmentDefaults}
      secretNames={secretNames}
      repos={repos}
      builtInServers={builtInServers}
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

// One row of the launcher's configuration block: a label + the picked value,
// opened into its option list with →/enter (the dashboard composer's selects,
// terminal-shaped). Both pick one.
type PickerRow = { key: 'environment' | 'model'; label: string }
const PICKER_ROWS: readonly PickerRow[] = [
  { key: 'environment', label: 'Environment' },
  { key: 'model', label: 'Model' },
]

// What the prompt box says before you type: the whole key map for the block, so
// nothing about the launcher has to be remembered.
const PROMPT_HINT = 'Enter to start a session, up to configure it, down to explore old sessions...'

// The variable form's placeholders, each stating what leaving that field empty
// means, in the field it applies to.
const NAME_PLACEHOLDER = 'MY_TOKEN'
const VALUE_PLACEHOLDER = 'leave empty to pull from secrets'

// The prompt box's interior padding, matching the chat composer's.
const PROMPT_PAD_X = 2

// Where the launcher's cursor is: the prompt box, one of the configuration rows
// (by PICKER_ROWS index), or a session row (by id, so the poll re-sorting under
// the cursor doesn't move the highlight).
type LauncherCursor =
  | { kind: 'prompt' }
  | { kind: 'option'; at: number }
  | { kind: 'list'; id: string }

// Adding a variable in the custom section: a two-field form, name over value,
// walked with ↑/↓ — `field` is where the caret sits. Enter on either field
// commits, so a variable whose value comes from stored secrets is name + enter.
type VariableEditor = {
  field: 'name' | 'value'
  name: string
  value: string
  error: string | null
}

// Adding an MCP server: three fields walked with ↑/↓. A bare name opts into a
// built-in; command makes it a stdio server, url a remote one (one or the
// other — validateMcpServer). Enter commits from any field, esc backs out.
type ServerEditor = {
  field: 'name' | 'command' | 'url'
  name: string
  command: string
  url: string
  error: string | null
}

const SERVER_EDITOR_FIELDS = ['name', 'command', 'url'] as const


// The launcher: one painted box holding everything about the next session —
// the configuration rows on top, the prompt under them — with history below —
//
//    | ▶ Environment: backend-sandbox (account default)
//    |   Model: claude-opus-5
//    |
//    |   Enter to start a session, up to configure it, down to explore old…
//
//    Recent sessions:                                    @me in account
//    ● latest session                               $0.20, 2m ago
//    ● …                                   (LIST_ROWS rows; scrolls)
//
// ONE input, two readings: what you type is the next session's prompt AND a
// live filter over the list below, so finding old work and starting new work
// are the same gesture. Enter starts a session with the text (empty text
// starts it idle). ↑ walks up into the configuration rows, where enter (or →)
// opens that row's dropdown in place — inside the box, growing it downward, so
// nothing swaps out and the session list stays. ↓ walks down into the list,
// where enter opens a session.
//
// All three rows share one glyph gutter, so the ▶ moves down a single left
// edge; the box's accent bar stays lit throughout, marking the block rather
// than any one row. Typing anywhere returns the cursor to the prompt. Agent
// configs stay a CLI choice (`agent session start -c`), since a config decides
// its own environment and the server refuses both at once.
//
// The open Environment list has two halves —
//
//      [x] backend-sandbox (default for acme/api)
//      [ ] web-e2e (account default)
//      [ ] [empty]
//      ─── custom environment ───
//      VARIABLES
//        [x] API_TOKEN
//        [ ] NPM_TOKEN
//        [x] PORT=3000
//        + new variable
//            name: SENTRY_DSN
//          ▶ value: leave empty to pull from secrets
//
// — every saved environment plus the built-in [empty] above the divider, and
// below it what you can set for this run alone. Each environment names the
// default rungs it holds, and the one the ladder resolves for the cwd's repo
// starts out checked, so an untouched row SENDS the environment it shows.
//
// The two halves compose: a variable added down there layers ON TOP of whichever
// environment is checked above (see applyComposerChoices, which has to re-send
// that environment's own variables because an override array replaces the list).
function Launcher({
  width,
  whoLine,
  focused,
  starting,
  error,
  armed,
  environments,
  environmentDefaults,
  secretNames,
  repos,
  builtInServers,
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
  environments: SavedEnvironment[] | null
  models: SupportedModel[] | null
  // The account's stored variable names, checkable in the custom section.
  secretNames: string[] | null
  // The account's connected repositories, checkable in the custom section.
  repos: RepositorySummary[] | null
  // The built-in MCP server names available on this account.
  builtInServers: string[]
  // The defaults ladder; null until it lands (or its fetch failed), which just
  // leaves the untouched Environment row reading "Default".
  environmentDefaults: EnvironmentDefaults | null
  // The cwd's repo ("owner/name") — picks the repo rung of the ladder above,
  // so it decides which environment starts out checked.
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
  // null = the environment row is untouched, so it tracks whichever option the
  // defaults ladder resolves (see environmentIdx). The list arrives async, so
  // there is no index to seed this with at mount.
  const [environmentPick, setEnvironmentPick] = useState<number | null>(null)
  // null = the model row is untouched, so it tracks whichever row carries the
  // server-resolved pick (see modelIdx). The list arrives async, so there is no
  // index to seed this with at mount.
  const [modelPick, setModelPick] = useState<number | null>(null)
  // The open row's dropdown state: which picker is open and where its
  // highlight sits. null = no subtree open.
  const [openPicker, setOpenPicker] = useState<{ key: PickerRow['key']; hover: number } | null>(
    null,
  )
  // What the custom section below the divider adds on top of the picked
  // environment. Survives closing and reopening the list, so a variable typed
  // before choosing an environment is not lost.
  const [customVariables, setCustomVariables] = useState<readonly CustomVariable[]>([])
  const [customRepositories, setCustomRepositories] = useState<readonly CustomRepository[]>([])
  const [customCompute, setCustomCompute] = useState<CustomCompute>(EMPTY_COMPUTE)
  const [customImage, setCustomImage] = useState<CustomImage>(EMPTY_IMAGE)
  const [customHooks, setCustomHooks] = useState<CustomHooks>(EMPTY_HOOKS)
  const [customMcpServers, setCustomMcpServers] = useState<readonly CustomMcpServer[]>([])
  // The "+ new server" form's state, or null while closed.
  const [serverEditor, setServerEditor] = useState<ServerEditor | null>(null)
  // The open custom key's editor, or null. `field` is which of the two steps is
  // being typed; `name`/`value` hold what has been typed so far.
  const [editor, setEditor] = useState<VariableEditor | null>(null)

  // Both pickers deal in the same option shape (ComposerModel), so the
  // renderer can ask either of them for a group heading or a subtext; only the
  // model list fills those in.
  //
  // Every saved environment is listed, each tagged with the default rungs it
  // holds ("(account default)", "(default for acme/api)"), and the one the
  // ladder resolves for the cwd's repo starts out checked — so an untouched row
  // SENDS the environment it shows rather than leaving the server to resolve
  // something the row never named.
  // Each synced environment's option row names the file it came from — only
  // when the API already gave us the pieces (source_details + the repo list).
  const environmentSources = useMemo(() => {
    const byId = new Map((repos ?? []).map((r) => [r.id, r.full_name]))
    const labels = new Map<string, string>()
    for (const e of environments ?? []) {
      const label = environmentSourceLabel(e, byId)
      if (label) labels.set(e.id, label)
    }
    return labels
  }, [environments, repos])
  const { options: environmentOptionList, picked: resolvedIdx } = useMemo(
    () =>
      environmentOptions(environments ?? [], environmentDefaults, detectedRepo, environmentSources),
    [environments, environmentDefaults, detectedRepo, environmentSources],
  )
  const environmentOptionRows = useMemo<ComposerModel[]>(
    () => environmentOptionList.map((o) => ({ id: o.id, label: o.label })),
    [environmentOptionList],
  )
  const environmentIdx =
    environmentPick !== null
      ? Math.min(environmentPick, environmentOptionRows.length - 1)
      : resolvedIdx
  // The picked environment's own variables. They have to ride the override
  // alongside the custom ones, since an override array replaces the resolved
  // list rather than appending to it.
  const pickedEnvironment = environmentOptionRows[environmentIdx]
  const baseVariables = useMemo<CustomVariable[]>(() => {
    const id = pickedEnvironment?.id
    if (!id || id === EMPTY_ENVIRONMENT_ID) return []
    const found = (environments ?? []).find((e) => e.id === id)
    return (found?.environment.variables ?? []).map((v) => ({
      name: v.name,
      value: v.value ?? null,
    }))
  }, [environments, pickedEnvironment])
  // The picked environment's own compute and image, as the resting
  // placeholders of their input rows. Display only: object overrides merge key
  // by key, so unlike the lists these never need re-sending.
  const baseCompute = useMemo<CustomCompute>(() => {
    const id = pickedEnvironment?.id
    if (!id || id === EMPTY_ENVIRONMENT_ID) return EMPTY_COMPUTE
    const found = (environments ?? []).find((e) => e.id === id)
    const c = found?.environment.compute
    return {
      cpu: c?.cpu != null ? String(c.cpu) : '',
      memory: typeof c?.memory === 'string' ? c.memory : '',
      timeout: typeof c?.timeout === 'string' ? c.timeout : '',
    }
  }, [environments, pickedEnvironment])
  // A multi-line script flattens to one line for the placeholder — the row is
  // one line, and it only has to say "something is set here".
  const oneLine = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()
  const baseImage = useMemo<CustomImage>(() => {
    const id = pickedEnvironment?.id
    if (!id || id === EMPTY_ENVIRONMENT_ID) return EMPTY_IMAGE
    const found = (environments ?? []).find((e) => e.id === id)
    const img = found?.environment.image
    return { dockerfile_append: oneLine(img?.dockerfile_append), setup: oneLine(img?.setup) }
  }, [environments, pickedEnvironment])
  const baseHooks = useMemo<CustomHooks>(() => {
    const id = pickedEnvironment?.id
    if (!id || id === EMPTY_ENVIRONMENT_ID) return EMPTY_HOOKS
    const found = (environments ?? []).find((e) => e.id === id)
    const hooks = found?.environment.hooks
    return { post_start: oneLine(hooks?.post_start), post_clone: oneLine(hooks?.post_clone) }
  }, [environments, pickedEnvironment])
  // The picked environment's own MCP servers, verbatim (they can be full
  // stdio/remote definitions) — the override list replaces, so they ride along.
  const baseMcpServers = useMemo<readonly unknown[]>(() => {
    const id = pickedEnvironment?.id
    if (!id || id === EMPTY_ENVIRONMENT_ID) return []
    const found = (environments ?? []).find((e) => e.id === id)
    return found?.environment.mcp_servers ?? []
  }, [environments, pickedEnvironment])
  const baseMcpServerNames = useMemo<string[]>(
    () =>
      baseMcpServers
        .map((s) => (typeof s === 'string' ? s : ((s as { name?: string }).name ?? '')))
        .filter(Boolean),
    [baseMcpServers],
  )
  // The picked environment's own repositories — same reason as baseVariables:
  // an override array replaces the resolved list, so they have to ride along.
  const baseRepositories = useMemo<CustomRepository[]>(() => {
    const id = pickedEnvironment?.id
    if (!id || id === EMPTY_ENVIRONMENT_ID) return []
    const found = (environments ?? []).find((e) => e.id === id)
    return (found?.environment.repositories ?? []).map((r) => ({
      fullName: r.owner ? `${r.owner}/${r.name}` : r.name,
      ref: r.ref ?? null,
    }))
  }, [environments, pickedEnvironment])
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
  const optionsFor = (key: PickerRow['key']) =>
    key === 'environment' ? environmentOptionRows : modelOptions
  const pickedIdx = (key: PickerRow['key']): number =>
    key === 'environment' ? environmentIdx : modelIdx
  const isPicked = (key: PickerRow['key'], at: number): boolean =>
    at === Math.min(pickedIdx(key), optionsFor(key).length - 1)
  const emptyPicked = pickedEnvironment?.id === EMPTY_ENVIRONMENT_ID
  // Both rows single-pick, so activating an OPTION closes the dropdown. The
  // Environment list's custom rows below the divider are not options: they
  // toggle or type in place and keep the list up.
  const activate = (key: PickerRow['key'], at: number): void => {
    if (key === 'environment') setEnvironmentPick(at)
    else setModelPick(at)
    setOpenPicker(null)
  }
  // The open Environment list's shape, shared by its navigation and its
  // renderer: the options, then the custom section's secrets, typed variables
  // and add button.
  // Whether a repository is in the run: checked in the custom section, or
  // brought in by the picked environment itself.
  const repositoryFor = (fullName: string): CustomRepository | undefined =>
    customRepositories.find((r) => r.fullName === fullName) ??
    baseRepositories.find((r) => r.fullName === fullName)
  const environmentPicker = useMemo(
    () => ({
      optionCount: environmentOptionRows.length,
      repoNames: (repos ?? []).map((r) => r.full_name),
      // A checked repo grows its branch input row, so ↓ can land on it.
      checkedRepoNames: (repos ?? [])
        .map((r) => r.full_name)
        .filter(
          (name) =>
            customRepositories.some((r) => r.fullName === name) ||
            baseRepositories.some((r) => r.fullName === name),
        ),
      secretNames: secretNames ?? [],
      customVariables,
      builtInMcpServers: builtInServers,
      customMcpServers,
    }),
    [
      environmentOptionRows.length,
      repos,
      secretNames,
      customVariables,
      customRepositories,
      baseRepositories,
      builtInServers,
      customMcpServers,
    ],
  )
  const environmentHoverCount = environmentPickerCount(environmentPicker)
  // Whether a variable of this name is in the run: a checked secret and a typed
  // entry are the same thing once committed.
  const variableFor = (name: string): CustomVariable | undefined =>
    customVariables.find((v) => v.name === name)
  // Enter (or →) on a row of the open Environment list: an option picks and
  // closes; a repo or secret toggles; a typed variable re-opens for editing;
  // the add button opens an empty editor.
  const activateEnvironmentRow = (hover: number): void => {
    const row = environmentPickerAt(environmentPicker, hover)
    if (row.kind === 'option') {
      activate('environment', row.at)
      return
    }
    if (row.kind === 'repo') {
      // Unchecking drops the custom entry; a base repo (the picked
      // environment's own) stays, since an additive list can't remove it.
      setCustomRepositories((prev) =>
        prev.some((r) => r.fullName === row.fullName)
          ? prev.filter((r) => r.fullName !== row.fullName)
          : [...prev, { fullName: row.fullName, ref: null }],
      )
      return
    }
    // The branch, compute, image and hook rows are text inputs, not toggles:
    // enter there is a no-op, typing is what edits them (see the handler).
    if (
      row.kind === 'repoRef' ||
      row.kind === 'compute' ||
      row.kind === 'image' ||
      row.kind === 'hook'
    )
      return
    if (row.kind === 'mcpServer') {
      // Toggling off a base server can't be expressed additively, so only
      // servers added here uncheck (mirrors the repo rows).
      setCustomMcpServers((prev) =>
        prev.some((s) => s.name === row.name)
          ? prev.filter((s) => s.name !== row.name)
          : [...prev, { name: row.name, command: null, url: null }],
      )
      return
    }
    if (row.kind === 'addMcpServer') {
      setServerEditor({ field: 'name', name: '', command: '', url: '', error: null })
      return
    }
    if (row.kind === 'secret') {
      // Values are write-only, so a checked secret is a variable with no value:
      // the sandbox resolves the name from stored secrets at start.
      setCustomVariables((prev) =>
        prev.some((v) => v.name === row.name)
          ? prev.filter((v) => v.name !== row.name)
          : [...prev, { name: row.name, value: null }],
      )
      return
    }
    if (row.kind === 'variable') {
      setEditor({
        field: 'value',
        name: row.name,
        value: variableFor(row.name)?.value ?? '',
        error: null,
      })
      return
    }
    setEditor({ field: 'name', name: '', value: '', error: null })
  }
  // Enter commits from either field. A name that isn't a legal shell identifier
  // keeps the form open with the reason. An empty value means the sandbox
  // resolves the name from stored variables.
  const commitEditor = (): void => {
    if (!editor) return
    const parsed = parseVariableEntry(editor.name)
    if ('error' in parsed) {
      setEditor({ ...editor, error: parsed.error })
      return
    }
    // "NAME=value" typed into the name field carries its own value, so it wins
    // over the (necessarily untouched) value field.
    const value = parsed.value !== null ? parsed.value : editor.value === '' ? null : editor.value
    setCustomVariables((prev) => {
      const next = [...prev]
      const entry = { name: parsed.name, value }
      // A repeat of a name already in the list replaces it in place, so the
      // second typing of a name reads as an edit and not a duplicate row.
      const existing = next.findIndex((v) => v.name === parsed.name)
      if (existing !== -1) next[existing] = entry
      else next.push(entry)
      return next
    })
    setEditor(null)
  }
  // Typing on a checked repo's branch row edits its ref in place: backspace
  // erases, an emptied ref returns to the default branch (null). A base repo
  // whose ref was edited becomes a custom entry, which wins the merge.
  const editRepositoryRef = (fullName: string, edit: (ref: string) => string): void => {
    const current = repositoryFor(fullName)?.ref ?? ''
    const next = edit(current)
    const entry = { fullName, ref: next === '' ? null : next }
    setCustomRepositories((prev) => {
      const existing = prev.findIndex((r) => r.fullName === fullName)
      if (existing === -1) return [...prev, entry]
      const out = [...prev]
      out[existing] = entry
      return out
    })
  }

  // Enter with an empty prompt is a real start: the session comes up idle and
  // waits for the first message, so you can open a sandbox before you know
  // what to ask it.
  const submit = (): void => {
    onSubmit(text.trim(), {
      environment: emptyPicked ? null : (pickedEnvironment?.id ?? null),
      model: modelOptions[modelIdx]?.id ?? null,
      emptyEnvironment: emptyPicked,
      baseVariables,
      customVariables,
      baseRepositories,
      customRepositories,
      customCompute,
      customImage,
      customHooks,
      baseMcpServers,
      customMcpServers,
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
      // The "+ new server" form: like the variable form, it owns every key
      // while up. ↑/↓ walk the three fields, enter commits, esc backs out.
      if (serverEditor !== null) {
        if (key.escape) {
          setServerEditor(null)
          return
        }
        if (key.return) {
          const entry: CustomMcpServer = {
            name: serverEditor.name.trim(),
            command: serverEditor.command.trim() || null,
            url: serverEditor.url.trim() || null,
          }
          const error = validateMcpServer(entry)
          if (error) {
            setServerEditor({ ...serverEditor, error })
            return
          }
          setCustomMcpServers((prev) => [
            // A repeat of a name is an edit of it, not a duplicate row.
            ...prev.filter((s) => s.name !== entry.name),
            entry,
          ])
          setServerEditor(null)
          return
        }
        const fields = SERVER_EDITOR_FIELDS
        const at = fields.indexOf(serverEditor.field)
        if (key.upArrow) {
          setServerEditor({ ...serverEditor, field: fields[Math.max(0, at - 1)] })
          return
        }
        if (key.downArrow) {
          setServerEditor({
            ...serverEditor,
            field: fields[Math.min(fields.length - 1, at + 1)],
          })
          return
        }
        const typed = serverEditor[serverEditor.field]
        if (key.backspace || key.delete) {
          setServerEditor({ ...serverEditor, [serverEditor.field]: typed.slice(0, -1), error: null })
          return
        }
        if (ch && !key.ctrl && !key.meta) {
          setServerEditor({ ...serverEditor, [serverEditor.field]: typed + ch, error: null })
        }
        return
      }
      // The variable form is the innermost modal: while it is up it owns every
      // key, so space is typed text rather than list navigation. ↑/↓ move the
      // caret between the two fields, enter commits, esc backs out.
      if (editor !== null) {
        if (key.escape) {
          setEditor(null)
          return
        }
        if (key.return) {
          commitEditor()
          return
        }
        if (key.upArrow) {
          setEditor({ ...editor, field: 'name' })
          return
        }
        if (key.downArrow) {
          setEditor({ ...editor, field: 'value' })
          return
        }
        const field = editor.field
        const typed = field === 'name' ? editor.name : editor.value
        if (key.backspace || key.delete) {
          setEditor({ ...editor, [field]: typed.slice(0, -1), error: null })
          return
        }
        if (ch && !key.ctrl && !key.meta) {
          setEditor({ ...editor, [field]: typed + ch, error: null })
        }
        return
      }
      // An open dropdown is a modal subtree: ↑/↓ walk the rows,
      // → (or enter/space) activates the highlighted one — an option picks and
      // closes, a custom key opens its editor — ← (or esc) backs out.
      if (openPicker !== null) {
        const isEnv = openPicker.key === 'environment'
        const rowCount = isEnv ? environmentHoverCount : optionsFor(openPicker.key).length
        if (key.escape || key.leftArrow) {
          setOpenPicker(null)
          return
        }
        if (key.upArrow) {
          setOpenPicker((p) => p && { ...p, hover: Math.max(0, p.hover - 1) })
          return
        }
        if (key.downArrow) {
          setOpenPicker((p) => p && { ...p, hover: Math.min(rowCount - 1, p.hover + 1) })
          return
        }
        // The branch and compute rows are text inputs under the cursor: typing
        // and backspace edit them in place, blank = whatever the server
        // resolves. Space stays list navigation (no ref or size holds one).
        if (isEnv) {
          const hover = Math.min(openPicker.hover, rowCount - 1)
          const target = environmentPickerAt(environmentPicker, hover)
          const typing =
            ch && ch !== ' ' && !key.ctrl && !key.meta && !key.return && !key.rightArrow
          if (target.kind === 'repoRef') {
            if (key.backspace || key.delete) {
              editRepositoryRef(target.fullName, (ref) => ref.slice(0, -1))
              return
            }
            if (typing) {
              editRepositoryRef(target.fullName, (ref) => ref + ch)
              return
            }
          }
          if (target.kind === 'compute') {
            if (key.backspace || key.delete) {
              setCustomCompute((c) => ({ ...c, [target.field]: c[target.field].slice(0, -1) }))
              return
            }
            // cpu is a number on the wire, so its field only admits digits.
            if (typing && (target.field !== 'cpu' || /^[0-9.]$/.test(ch))) {
              setCustomCompute((c) => ({ ...c, [target.field]: c[target.field] + ch }))
              return
            }
          }
          // Image and hook fields are shell/Dockerfile lines, so space is
          // typed text — but only once something has been typed, so space on
          // the untouched row still activates like everywhere else.
          if (target.kind === 'image' || target.kind === 'hook') {
            const typed =
              target.kind === 'image'
                ? customImage[target.field]
                : customHooks[target.field]
            const set =
              target.kind === 'image'
                ? (edit: (s: string) => string) =>
                    setCustomImage((c) => ({ ...c, [target.field]: edit(c[target.field]) }))
                : (edit: (s: string) => string) =>
                    setCustomHooks((c) => ({ ...c, [target.field]: edit(c[target.field]) }))
            const spaceTyping = ch === ' ' && typed !== '' && !key.ctrl && !key.meta
            if (key.backspace || key.delete) {
              set((s) => s.slice(0, -1))
              return
            }
            if (typing || spaceTyping) {
              set((s) => s + ch)
              return
            }
          }
        }
        if (key.rightArrow || key.return || ch === ' ') {
          const hover = Math.min(openPicker.hover, rowCount - 1)
          if (isEnv) activateEnvironmentRow(hover)
          else activate(openPicker.key, hover)
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

  // The summary shown on a row: the pick's label, plus what the custom section
  // adds on top of it. Never "loading…": every resting value is known locally,
  // so a pending fetch has nothing to do with what this run would use.
  const rowValue = (key: PickerRow['key']): string => {
    const options = optionsFor(key)
    const label = options[Math.min(pickedIdx(key), options.length - 1)]?.label ?? 'Default'
    return key === 'environment'
      ? environmentRowSummary(
          label,
          customVariables,
          customRepositories,
          customCompute,
          customImage,
          customHooks,
          customMcpServers,
        )
      : label
  }

  // Columns available inside the prompt box: the terminal minus its left accent
  // bar and the interior padding on both sides. The configuration rows and the
  // open dropdown live in there now, so it — not `width` — is what their layout
  // has to fit.
  const contentWidth = Math.max(1, width - 1 - PROMPT_PAD_X * 2)
  const open = openPicker
  const openOptions = open ? optionsFor(open.key) : []
  const openIsEnv = open?.key === 'environment'
  const openRowCount = openIsEnv ? environmentHoverCount : openOptions.length
  const openHover = open ? Math.min(open.hover, openRowCount - 1) : 0
  // Every option plus its group heading — an open dropdown prints the whole
  // list, so a long model list grows the block and the terminal scrolls rather
  // than hiding rows behind a window. The Environment list adds the divider and
  // its custom key rows below the options.
  const visibleRows = open && !openIsEnv ? composerPickerRows(openOptions) : []
  const environmentRows = openIsEnv ? environmentPickerRows(environmentPicker) : []
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
    return total <= contentWidth ? { label, input, output } : null
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
      {/* The prompt box: the chat composer's painted slab, with an accent bar
          down its left edge and a blank row of padding above and below its
          contents — the configuration rows first, then the input.

          The bar stays the cursor color throughout: the box holds three rows
          now, so it marks the whole block rather than any one of them, and the
          ▶ in the shared gutter is what says which row you are on. */}
      <Box
        width={width}
        flexDirection="column"
        backgroundColor={inputSurface}
        borderStyle="bold"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderLeftColor={theme.cursor}
        paddingY={1}
        paddingX={PROMPT_PAD_X}
      >
        {/* What the next run will use, on top: two rows you walk with ↑ from
            the input below, each opening its own list in place. */}
        {PICKER_ROWS.map((r, i) => {
          const active = focused && cursor.kind === 'option' && cursor.at === i
          const isOpen = open?.key === r.key
          return (
            <Box key={r.key} flexDirection="column" width={contentWidth}>
              <Box width={contentWidth}>
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
                <Box width={contentWidth}>
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
                      <Box key={`group:${pickerRow.label}`} width={contentWidth}>
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
                    <Box key={opt.id ?? 'default'} width={contentWidth}>
                      <Text wrap="truncate">
                        {'   '}
                        <Text color={theme.cursor}>{hovered ? SELECTION_GLYPH : ' '}</Text>{' '}
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
              {/* The Environment list: its options, the divider, then the custom
                  section — a checkbox per stored variable, whatever was typed
                  here, and the add button. */}
              {isOpen &&
                environmentRows.map((envRow) => {
                  if (envRow.kind === 'divider') {
                    return (
                      <Box key="divider" width={contentWidth}>
                        <Text wrap="truncate" color={theme.muted}>
                          {'    '}
                          {`─── ${envRow.label} ───`}
                        </Text>
                      </Box>
                    )
                  }
                  if (envRow.kind === 'heading') {
                    return (
                      <Box key={`heading:${envRow.label}`} width={contentWidth}>
                        <Text wrap="truncate" color={theme.muted}>
                          {'    '}
                          {envRow.label.toUpperCase()}
                        </Text>
                      </Box>
                    )
                  }
                  // A form owns the caret while it is open, so the list's own
                  // highlight goes dark rather than showing a second one.
                  const hovered =
                    envRow.hover === openHover && editor === null && serverEditor === null
                  if (envRow.kind === 'option') {
                    const opt = openOptions[envRow.at]
                    if (!opt) return null
                    const picked = isPicked('environment', envRow.at)
                    return (
                      <Box key={opt.id ?? 'default'} width={contentWidth}>
                        <Text wrap="truncate">
                          {'   '}
                          <Text color={theme.cursor}>{hovered ? SELECTION_GLYPH : ' '}</Text>{' '}
                          <Text color={hovered || picked ? theme.foreground : theme.muted}>
                            {`[${picked ? 'x' : ' '}] ${opt.label}`}
                          </Text>
                        </Text>
                      </Box>
                    )
                  }
                  // A connected repository: enter/space toggles it into the
                  // run. The ref stays off the row until it is checked — the
                  // branch input under it is where that lives.
                  if (envRow.kind === 'repo') {
                    const checked = repositoryFor(envRow.fullName) !== undefined
                    return (
                      <Box key={`repo:${envRow.fullName}`} width={contentWidth}>
                        <Text wrap="truncate">
                          {'   '}
                          <Text color={theme.cursor}>{hovered ? SELECTION_GLYPH : ' '}</Text>{' '}
                          <Text color={hovered || checked ? theme.foreground : theme.muted}>
                            {`    [${checked ? 'x' : ' '}] ${envRow.fullName}`}
                          </Text>
                        </Text>
                      </Box>
                    )
                  }
                  // A checked repo's branch input: typing edits the ref in
                  // place; empty rests on the repo's default branch.
                  if (envRow.kind === 'repoRef') {
                    const ref = repositoryFor(envRow.fullName)?.ref ?? null
                    const resting = repositoryRefLabel(
                      ref,
                      (repos ?? []).find((r) => r.full_name === envRow.fullName)
                        ?.default_branch ?? null,
                    )
                    return (
                      <Box key={`repoRef:${envRow.fullName}`} width={contentWidth}>
                        <Text wrap="truncate">
                          {'   '}
                          <Text color={theme.cursor}>{hovered ? SELECTION_GLYPH : ' '}</Text>{' '}
                          {/* Aligned under the repo name, past its checkbox. */}
                          <Text color={theme.muted}>{'        branch: '}</Text>
                          {ref !== null ? (
                            <Text color={theme.foreground}>
                              {ref}
                              {hovered && <Text inverse> </Text>}
                            </Text>
                          ) : (
                            // The default branch as a placeholder: it is what
                            // an untouched row clones, and typing replaces it.
                            <Text color={theme.muted}>
                              {hovered && resting ? (
                                <Text>
                                  <Text inverse>{resting[0]}</Text>
                                  {resting.slice(1)}
                                </Text>
                              ) : (
                                (resting ?? '')
                              )}
                            </Text>
                          )}
                        </Text>
                      </Box>
                    )
                  }
                  // A compute, image or hook field: an inline input like a
                  // branch row. Blank rests on the picked environment's own
                  // value (muted), which is what an untouched field keeps —
                  // object overrides merge key by key.
                  if (
                    envRow.kind === 'compute' ||
                    envRow.kind === 'image' ||
                    envRow.kind === 'hook'
                  ) {
                    const typed =
                      envRow.kind === 'compute'
                        ? customCompute[envRow.field]
                        : envRow.kind === 'image'
                          ? customImage[envRow.field]
                          : customHooks[envRow.field]
                    const resting =
                      envRow.kind === 'compute'
                        ? baseCompute[envRow.field]
                        : envRow.kind === 'image'
                          ? baseImage[envRow.field]
                          : baseHooks[envRow.field]
                    return (
                      <Box key={`${envRow.kind}:${envRow.field}`} width={contentWidth}>
                        <Text wrap="truncate">
                          {'   '}
                          <Text color={theme.cursor}>{hovered ? SELECTION_GLYPH : ' '}</Text>{' '}
                          <Text color={theme.muted}>{`    ${envRow.field}: `}</Text>
                          {typed !== '' ? (
                            <Text color={theme.foreground}>
                              {typed}
                              {hovered && <Text inverse> </Text>}
                            </Text>
                          ) : (
                            <Text color={theme.muted}>
                              {hovered && resting !== '' ? (
                                <Text>
                                  <Text inverse>{resting[0]}</Text>
                                  {resting.slice(1)}
                                </Text>
                              ) : (
                                resting
                              )}
                              {hovered && resting === '' && <Text inverse> </Text>}
                            </Text>
                          )}
                        </Text>
                      </Box>
                    )
                  }
                  // An MCP server: a built-in (or typed) name, checked when the
                  // picked environment carries it or it was checked here.
                  if (envRow.kind === 'mcpServer') {
                    const checked =
                      customMcpServers.some((s) => s.name === envRow.name) ||
                      baseMcpServerNames.includes(envRow.name)
                    return (
                      <Box key={`mcp:${envRow.name}`} width={contentWidth}>
                        <Text wrap="truncate">
                          {'   '}
                          <Text color={theme.cursor}>{hovered ? SELECTION_GLYPH : ' '}</Text>{' '}
                          <Text color={hovered || checked ? theme.foreground : theme.muted}>
                            {`    [${checked ? 'x' : ' '}] ${envRow.name}`}
                          </Text>
                        </Text>
                      </Box>
                    )
                  }
                  if (envRow.kind === 'addMcpServer') {
                    return (
                      <Box key="addMcpServer" flexDirection="column" width={contentWidth}>
                        <Box width={contentWidth}>
                          <Text wrap="truncate">
                            {'   '}
                            <Text color={theme.cursor}>{hovered ? SELECTION_GLYPH : ' '}</Text>{' '}
                            <Text color={hovered ? theme.foreground : theme.muted}>
                              {'    '}
                              {ADD_MCP_SERVER_LABEL}
                            </Text>
                          </Text>
                        </Box>
                        {serverEditor !== null && (
                          <Box flexDirection="column" width={contentWidth}>
                            {SERVER_EDITOR_FIELDS.map((field) => {
                              const here = serverEditor.field === field
                              const typed = serverEditor[field]
                              // name is required; command/url pick the type,
                              // so their placeholders say the either/or.
                              const ghost =
                                typed !== ''
                                  ? null
                                  : field === 'name'
                                    ? 'my-tools'
                                    : field === 'command'
                                      ? 'stdio: npx -y my-tools-mcp'
                                      : 'remote: https://mcp.example.com'
                              return (
                                <Box key={field} width={contentWidth}>
                                  <Text wrap="truncate">
                                    {'   '}
                                    <Text color={theme.cursor}>
                                      {here ? SELECTION_GLYPH : ' '}
                                    </Text>{' '}
                                    {/* Aligned under the button text, past
                                        its "+ ". */}
                                    <Text color={theme.muted}>{`      ${field}: `}</Text>
                                    <Text color={theme.foreground}>{typed}</Text>
                                    {ghost ? (
                                      <Text>
                                        {here ? (
                                          <Text inverse>{ghost[0]}</Text>
                                        ) : (
                                          <Text color={theme.muted}>{ghost[0]}</Text>
                                        )}
                                        <Text color={theme.muted}>{ghost.slice(1)}</Text>
                                      </Text>
                                    ) : (
                                      here && <Text inverse> </Text>
                                    )}
                                  </Text>
                                </Box>
                              )
                            })}
                            {serverEditor.error !== null && (
                              <Box width={contentWidth}>
                                <Text wrap="truncate" color={theme.muted}>
                                  {'           '}
                                  {serverEditor.error}
                                </Text>
                              </Box>
                            )}
                          </Box>
                        )}
                      </Box>
                    )
                  }
                  if (envRow.kind === 'addVariable') {
                    return (
                      <Box key="addVariable" flexDirection="column" width={contentWidth}>
                        <Box width={contentWidth}>
                          <Text wrap="truncate">
                            {'   '}
                            <Text color={theme.cursor}>{hovered ? SELECTION_GLYPH : ' '}</Text>{' '}
                            <Text color={hovered ? theme.foreground : theme.muted}>
                              {'    '}
                              {ADD_VARIABLE_LABEL}
                            </Text>
                          </Text>
                        </Box>
                        {/* The form, one level in from the button that opened
                            it: both fields at once, the ▶ on whichever ↑/↓ put
                            the caret on. */}
                        {editor !== null && (
                          <Box flexDirection="column" width={contentWidth}>
                            {(['name', 'value'] as const).map((field) => {
                              const here = editor.field === field
                              const typed = field === 'name' ? editor.name : editor.value
                              // The value's placeholder says what an empty one
                              // means, in the field it applies to.
                              const ghost =
                                field === 'value' && typed === ''
                                  ? VALUE_PLACEHOLDER
                                  : field === 'name' && typed === ''
                                    ? NAME_PLACEHOLDER
                                    : null
                              return (
                                <Box key={field} width={contentWidth}>
                                  <Text wrap="truncate">
                                    {'   '}
                                    <Text color={theme.cursor}>
                                      {here ? SELECTION_GLYPH : ' '}
                                    </Text>{' '}
                                    {/* Aligned under the button text, past
                                        its "+ ". */}
                                    <Text color={theme.muted}>{`      ${field}: `}</Text>
                                    <Text color={theme.foreground}>{typed}</Text>
                                    {/* The caret sits on the placeholder's first
                                        character rather than pushing it right. */}
                                    {ghost ? (
                                      <Text>
                                        {here ? (
                                          <Text inverse>{ghost[0]}</Text>
                                        ) : (
                                          <Text color={theme.muted}>{ghost[0]}</Text>
                                        )}
                                        <Text color={theme.muted}>{ghost.slice(1)}</Text>
                                      </Text>
                                    ) : (
                                      here && <Text inverse> </Text>
                                    )}
                                  </Text>
                                </Box>
                              )
                            })}
                            {editor.error !== null && (
                              <Box width={contentWidth}>
                                <Text wrap="truncate" color={theme.muted}>
                                  {'           '}
                                  {editor.error}
                                </Text>
                              </Box>
                            )}
                          </Box>
                        )}
                      </Box>
                    )
                  }
                  // A stored variable (checkbox) or one typed here. Both read as
                  // one row per name: checking a stored one and typing a value
                  // for it are the same entry.
                  const entry = variableFor(envRow.name)
                  const checked = entry !== undefined
                  const label =
                    envRow.kind === 'secret'
                      ? variableRowLabel(envRow.name, entry ? entry.value : undefined)
                      : variableRowLabel(envRow.name, entry?.value ?? null)
                  return (
                    <Box key={`var:${envRow.name}`} width={contentWidth}>
                      <Text wrap="truncate">
                        {'   '}
                        <Text color={theme.cursor}>{hovered ? SELECTION_GLYPH : ' '}</Text>{' '}
                        <Text color={hovered || checked ? theme.foreground : theme.muted}>
                          {`    [${checked ? 'x' : ' '}] ${label}`}
                        </Text>
                      </Text>
                    </Box>
                  )
                })}
            </Box>
          )
        })}
        {/* One blank row between the configuration rows and what you type. */}
        <Text> </Text>
        {/* The input, in the same glyph gutter as the rows above it, so all
            three read down one left edge and the ▶ moves between them. */}
        <Box width={contentWidth}>
          <Box width={2} flexShrink={0}>
            <Text color={theme.cursor}>
              {focused && cursor.kind === 'prompt' ? SELECTION_GLYPH : ' '}
            </Text>
          </Box>
          {/* Takes the columns the gutter left, so a long prompt wraps inside
              the box instead of running past its right edge. The key remounts
              the node so a stale measurement can't misplace the caret. */}
          <Box flexGrow={1} flexShrink={1}>
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
              {/* Empty input: the hint sits where typed text will land, its
                  first character carrying the caret (inverse) instead of a
                  caret cell of its own pushing it a column right. */}
              {text === '' && caretVisible && (
                <Text>
                  <Text inverse>{PROMPT_HINT[0]}</Text>
                  <Text color={theme.muted}>{PROMPT_HINT.slice(1)}</Text>
                </Text>
              )}
              {text === '' && !caretVisible && <Text color={theme.muted}>{PROMPT_HINT}</Text>}
            </Text>
          </Box>
        </Box>
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
