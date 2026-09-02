import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput, useStdin, useStdout } from 'ink'
import type { OpenSocket } from '@ellipsis-dev/sdk/stream'
import { SessionTranscriptStore, seedTranscriptStore } from '@ellipsis-dev/sdk/store'
import type { Ellipsis } from '@ellipsis-dev/sdk'
import { errorDetail } from '../lib/api'
import type {
  AgentSession,
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
  paneWithRepository,
  composerModelOptions,
  composerPickerRows,
  connectability,
  CUSTOM_ENVIRONMENT_ID,
  CUSTOM_ENVIRONMENT_LABEL,
  EMPTY_ENVIRONMENT_ID,
  EMPTY_PANE,
  environmentPane,
  environmentPaneWalk,
  environmentPresets,
  environmentSectionAt,
  environmentSectionRows,
  environmentSourceLabel,
  PANE_SECTION_LABELS,
  paneEquals,
  restingPresetIndex,
  parseVariableEntry,
  repositoryRefLabel,
  scriptRowLines,
  variableRowLabel,
  type ComposerChoices,
  type ComposerEnvironment,
  type ComposerModel,
  type CustomMcpServer,
  type CustomVariable,
  type EnvironmentPaneState,
  type PaneSection,
  type PaneWalkStep,
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

  // The launcher's picker options, fetched once when it first shows: the
  // saved environments and the selectable models. A models failure (an older
  // server without GET /models) leaves the list empty and the launcher falls
  // back to its built-in set.
  const [environments, setEnvironments] = useState<SavedEnvironment[] | null>(null)
  // The organization's default environment: what an untouched start runs in,
  // so the launcher can show it checked. undefined until the settings land
  // (or if they never do), null when the organization has none.
  const [defaultEnvironment, setDefaultEnvironment] = useState<string | null | undefined>(
    undefined,
  )
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
    void api.settings.organization
      .get()
      .then((r) => setDefaultEnvironment(r.default_environment ?? null))
      .catch((err) => {
        reportApiError('settings', err)
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
      defaultEnvironment={defaultEnvironment}
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

// The prompt row's persistent label, upper-cased in render like every other
// row's, and what its empty input says: enter is a real start.
const PROMPT_LABEL = 'Prompt'
const PROMPT_HINT = 'Enter to start a cloud session...'

// The two configuration headers under the prompt box, and the column their
// values (the preset row, the model pick) start in.
const ENVIRONMENT_LABEL = 'Environment'
const MODEL_LABEL = 'Model'
const HEADER_LABEL_WIDTH = ENVIRONMENT_LABEL.length + 3

// The environment field rows sit two columns in from the headers, each with
// its section's label in a column of its own, so the values read down one
// edge whatever section they belong to.
const FIELD_INDENT = '  '
const FIELD_LABEL_WIDTH = Math.max(...Object.values(PANE_SECTION_LABELS).map((l) => l.length)) + 3

// The variable form's placeholders, each stating what leaving that field empty
// means, in the field it applies to.
const NAME_PLACEHOLDER = 'MY_TOKEN'
const VALUE_PLACEHOLDER = 'leave empty to pull from secrets'

// The prompt box's interior padding, matching the chat composer's.
const PROMPT_PAD_X = 2

// Where the launcher's cursor is, top to bottom: the prompt row, the
// environment preset row, one of the environment field rows (by its index in
// the flat walk), the model row, or a session row (by id, so the poll
// re-sorting under the cursor doesn't move the highlight).
type LauncherCursor =
  | { kind: 'prompt' }
  | { kind: 'presets' }
  | { kind: 'pane'; at: number }
  | { kind: 'model' }
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

// A script field opened for editing: a real multi-line caret, since a Dockerfile
// or a setup script is written in lines. Arrows move within the text, enter
// inserts a newline, esc commits and collapses the row back to its summary.
type ScriptEditor = {
  section: 'image' | 'hooks'
  field: string
  text: string
  cursor: number
}


// The launcher: the prompt box on top, the next session's configuration under
// it, history under that —
//
//    | ▶ PROMPT: Enter to start a cloud session...
//
//      ENVIRONMENT   ▸staging◂   ci   empty
//                    account default · acme/api/envs/staging.yaml @ abc1234
//        repositories   [x] acme/api
//                           branch: main
//                       [ ] acme/web
//        mcp servers    [x] linear
//                       [ ] slack
//                       + new
//        variables      [x] API_TOKEN
//                       + new
//        image          dockerfile_append:
//                       setup: |
//                         npm ci
//        hooks          post_start:
//                       post_clone:
//        compute        cpu: 4
//                       memory: 16GB
//                       timeout:
//      MODEL         claude-opus-5
//
//     RECENT SESSIONS:                                    @me in account
//     ● latest session                               $0.20, 2m ago
//     ● …                                   (LIST_ROWS rows; scrolls)
//
// ONE input, two readings: what you type into the prompt row is the next
// session's prompt AND a live filter over the list below, so finding old work
// and starting new work are the same gesture. Enter starts a session with the
// text (empty text starts it idle). ↓ walks down through the configuration —
// the preset row, every environment field, the model row — and on into the
// list, where enter opens a session. ↑ walks back up.
//
// The ENVIRONMENT row is the saved environments, laid out as presets: ←/→ on
// that row moves the pick, and the field rows under it are what the picked
// one resolves to — every section open, nothing behind a dropdown. Together
// the field rows are the whole truth about the sandbox. Editing any of them
// is what makes the run custom: no preset is checked, a `custom` preset
// appears at the end of the row and takes the check, and from then on the
// fields' own lists are what ship. Picking a preset again reseeds them and
// `custom` goes away. That is why unchecking a repository the preset brought
// in actually drops it: the fields replace the resolved lists rather than
// adding to them (see applyComposerChoices).
//
// The account default leads the presets and is what an untouched launcher
// stands on; `empty` (the bare sandbox) closes the row. The repository the
// CLI is standing in shows checked under every preset, since the request adds
// it to whichever environment resolves.
//
// A checkbox row toggles with enter (or →/space). The branch and compute rows
// are one-line inputs edited by typing on them; blank = whatever the server
// resolves. A script field (image, hooks) prints as a YAML block scalar over
// its own lines, capped at SCRIPT_ROW_LINES with a count of what is hidden.
// Enter opens it into a real multi-line editor — arrows move within the text,
// enter is a newline, esc commits — because a Dockerfile is written in lines,
// not on one.
//
// The MODEL row still opens a dropdown: a model is a name, not a thing to
// read out. Typing anywhere outside an input row returns the cursor to the
// prompt.
//
// A saved automation is not a launcher pick: an automation runs exactly as
// defined and takes no prompt (`agent automation run`), while the launcher is
// the prompt. The picks here are the raw session's own settings — the same
// flat body `agent session start -e --model ...` speaks.
function Launcher({
  width,
  whoLine,
  focused,
  starting,
  error,
  armed,
  environments,
  defaultEnvironment,
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
  // The organization's default environment (a name or id), null when it has
  // none, undefined while unknown (loading, or the settings fetch failed).
  defaultEnvironment: string | null | undefined
  models: SupportedModel[] | null
  // The account's stored variable names, checkable in the variables section.
  secretNames: string[] | null
  // The account's connected repositories, checkable in the repositories section.
  repos: RepositorySummary[] | null
  // The built-in MCP server names available on this account.
  builtInServers: string[]
  // The cwd's repo ("owner/name") — added to every start's checkout set, so it
  // shows checked under every preset.
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
  // null = the preset row is untouched: the account default (or `empty`) is
  // checked and the request names nothing. The list arrives async, so there
  // is no index to seed this with at mount.
  const [presetPick, setPresetPick] = useState<number | null>(null)
  // null = the model row is untouched, so it tracks whichever row carries the
  // server-resolved pick (see modelIdx). The list arrives async, so there is no
  // index to seed this with at mount.
  const [modelPick, setModelPick] = useState<number | null>(null)
  // The model dropdown's state: where its highlight sits (an option index).
  // null = closed.
  const [openModel, setOpenModel] = useState<{ hover: number } | null>(null)
  // The field rows' backing state: this run's sandbox, whole. null =
  // untouched, so the rows show (and send) whatever the picked preset
  // resolves to; the first edit seeds it and from then on it is the truth.
  const [pane, setPane] = useState<EnvironmentPaneState | null>(null)
  // The "+ new server" form's state, or null while closed.
  const [serverEditor, setServerEditor] = useState<ServerEditor | null>(null)
  // The open variable form, or null. `field` is which of the two steps is
  // being typed; `name`/`value` hold what has been typed so far.
  const [editor, setEditor] = useState<VariableEditor | null>(null)
  // The open script field's editor, or null while every script row is collapsed.
  const [scriptEditor, setScriptEditor] = useState<ScriptEditor | null>(null)

  // Each synced environment's note names the file it came from — only when
  // the API already gave us the pieces (source_details + the repo list).
  const environmentSources = useMemo(() => {
    const byId = new Map((repos ?? []).map((r) => [r.id, r.full_name]))
    const labels = new Map<string, string>()
    for (const e of environments ?? []) {
      const label = environmentSourceLabel(e, byId)
      if (label) labels.set(e.id, label)
    }
    return labels
  }, [environments, repos])
  const presets = useMemo(
    () => environmentPresets(environments ?? [], defaultEnvironment, environmentSources),
    [environments, defaultEnvironment, environmentSources],
  )
  // The checked preset: the explicit pick, else the resting one — undefined
  // while the default is unknown, so nothing is checked that the request
  // would not send.
  const presetIdx =
    presetPick !== null
      ? Math.min(presetPick, presets.length - 1)
      : restingPresetIndex(presets, defaultEnvironment)
  const pickedPreset = presetIdx === undefined ? undefined : presets[presetIdx]
  // What the picked preset resolves to, as field rows, with the detected
  // repository checked in (the request adds it to every environment). This is
  // what the rows show until edited, and what "custom" is measured against.
  const connectedRepoNames = useMemo(() => (repos ?? []).map((r) => r.full_name), [repos])
  const seededPane = useMemo<EnvironmentPaneState>(() => {
    const id = pickedPreset?.id
    const base =
      id === undefined || id === EMPTY_ENVIRONMENT_ID
        ? EMPTY_PANE
        : environmentPane(
            (environments ?? []).find((e) => e.id === id)?.environment,
            connectedRepoNames,
          )
    return paneWithRepository(base, detectedRepo)
  }, [environments, pickedPreset, connectedRepoNames, detectedRepo])
  // The rows as the run would use them: the edits if there are any, else the
  // picked preset's own values.
  const shownPane = pane ?? seededPane
  // Once the rows no longer say what the preset they were seeded from says,
  // no preset is checked and the rows are what ship.
  const isCustom = pane !== null && !paneEquals(pane, seededPane)
  // The preset row as printed: the presets, plus `custom` at the end once the
  // rows have diverged. `custom` is where the check sits then.
  const presetRow = useMemo<{ id: string; name: string }[]>(
    () =>
      isCustom
        ? [...presets, { id: CUSTOM_ENVIRONMENT_ID, name: CUSTOM_ENVIRONMENT_LABEL }]
        : presets,
    [presets, isCustom],
  )
  const checkedPresetIdx = isCustom ? presets.length : presetIdx
  // Picking a preset drops the rows' edits, since the rows are a reading of
  // whatever preset is checked.
  const pickPreset = (at: number): void => {
    if (presets.length === 0) return
    setPresetPick(Math.min(Math.max(0, at), presets.length - 1))
    setPane(null)
  }
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
  // Editing any row seeds the pane from what is on screen, so the first
  // keystroke doesn't silently drop the rest of the environment.
  const editPane = (edit: (p: EnvironmentPaneState) => EnvironmentPaneState): void => {
    setPane((prev) => edit(prev ?? seededPane))
  }
  // Whether a repository is in the run, and at which ref.
  const repositoryFor = (fullName: string) =>
    shownPane.repositories.find((r) => r.fullName === fullName)
  // The rows' shape, shared by their navigation and their renderer.
  const paneInput = useMemo(
    () => ({
      // The connected repositories, plus any the picked preset named that
      // aren't among them — the rows are the whole truth, so a repo that will
      // be cloned has to be visible (and uncheckable) even if it is no longer
      // connected.
      repoNames: [
        ...connectedRepoNames,
        ...shownPane.repositories
          .map((r) => r.fullName)
          .filter((name) => !connectedRepoNames.includes(name)),
      ],
      // A checked repo grows its branch input row, so ↓ can land on it.
      checkedRepoNames: shownPane.repositories.map((r) => r.fullName),
      secretNames: secretNames ?? [],
      variables: shownPane.variables,
      builtInMcpServers: builtInServers,
      mcpServers: shownPane.mcpServers,
    }),
    [connectedRepoNames, secretNames, shownPane, builtInServers],
  )
  // Every field row, top to bottom, as ↑/↓ walk them.
  const walk = useMemo(() => environmentPaneWalk(paneInput), [paneInput])
  // Whether a variable of this name is in the run, and at which value.
  const variableFor = (name: string): CustomVariable | undefined =>
    shownPane.variables.find((v) => v.name === name)
  // Enter (or →) on a field row: a repo, server or variable toggles; a
  // variable already in the run re-opens for editing; the add buttons open a
  // form; a script field opens its multi-line editor. The branch and compute
  // rows are one-line inputs — enter there is a no-op, typing is what edits
  // them.
  const activateRow = (section: PaneSection, hover: number): void => {
    const row = environmentSectionAt(paneInput, section, hover)
    if (row.kind === 'image' || row.kind === 'hook') {
      const scripts = row.kind === 'image' ? 'image' : 'hooks'
      const text = shownPane[scripts][row.field as never] as string
      setScriptEditor({ section: scripts, field: row.field, text, cursor: text.length })
      return
    }
    if (row.kind === 'repo') {
      editPane((p) => ({
        ...p,
        repositories: p.repositories.some((r) => r.fullName === row.fullName)
          ? p.repositories.filter((r) => r.fullName !== row.fullName)
          : [...p.repositories, { fullName: row.fullName, ref: null }],
      }))
      return
    }
    if (row.kind === 'mcpServer') {
      editPane((p) => ({
        ...p,
        mcpServers: p.mcpServers.some((s) => s.name === row.name)
          ? p.mcpServers.filter((s) => s.name !== row.name)
          : [...p.mcpServers, { name: row.name, command: null, url: null }],
      }))
      return
    }
    if (row.kind === 'addMcpServer') {
      setServerEditor({ field: 'name', name: '', command: '', url: '', error: null })
      return
    }
    if (row.kind === 'variable') {
      const held = variableFor(row.name)
      // A valueless name is a plain checkbox — it ships the name alone and the
      // sandbox resolves the value from stored secrets — so enter toggles it.
      // One carrying a value opens for editing instead, since a value typed here
      // is worth more than the keystroke it took and enter should not drop it.
      if (held === undefined) {
        editPane((p) => ({ ...p, variables: [...p.variables, { name: row.name, value: null }] }))
        return
      }
      if (held.value === null) {
        editPane((p) => ({ ...p, variables: p.variables.filter((v) => v.name !== row.name) }))
        return
      }
      setEditor({ field: 'value', name: row.name, value: held.value, error: null })
      return
    }
    if (row.kind === 'addVariable') {
      setEditor({ field: 'name', name: '', value: '', error: null })
    }
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
    editPane((p) => {
      const next = [...p.variables]
      const entry = { name: parsed.name, value }
      // A repeat of a name already in the list replaces it in place, so the
      // second typing of a name reads as an edit and not a duplicate row.
      const existing = next.findIndex((v) => v.name === parsed.name)
      if (existing !== -1) next[existing] = entry
      else next.push(entry)
      return { ...p, variables: next }
    })
    setEditor(null)
  }
  // Typing on a checked repo's branch row edits its ref in place: backspace
  // erases, an emptied ref returns to the default branch (null).
  const editRepositoryRef = (fullName: string, edit: (ref: string) => string): void => {
    editPane((p) => {
      const existing = p.repositories.findIndex((r) => r.fullName === fullName)
      const ref = edit(p.repositories[existing]?.ref ?? '')
      const entry = { fullName, ref: ref === '' ? null : ref }
      const next = [...p.repositories]
      if (existing === -1) next.push(entry)
      else next[existing] = entry
      return { ...p, repositories: next }
    })
  }

  // Enter with an empty prompt is a real start: the session comes up idle and
  // waits for the first message, so you can open a sandbox before you know
  // what to ask it.
  //
  // What ships is what the screen says: the checked preset by name (or `{}`
  // for `empty`), the rows whole once they have diverged, and nothing at all
  // while no preset is checked because the default is still unknown.
  const submit = (): void => {
    const environment: ComposerEnvironment = isCustom
      ? { kind: 'custom', pane: shownPane }
      : pickedPreset === undefined
        ? { kind: 'default' }
        : pickedPreset.id === EMPTY_ENVIRONMENT_ID
          ? { kind: 'empty' }
          : { kind: 'named', id: pickedPreset.id }
    onSubmit(text.trim(), { environment, model: modelOptions[modelIdx]?.id ?? null })
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
  // The row above the model row, and the row below the preset row: the field
  // walk when it has rows, else each other.
  const lastPaneCursor = (): LauncherCursor =>
    walk.length > 0 ? { kind: 'pane', at: walk.length - 1 } : { kind: 'presets' }
  const firstPaneCursor = (): LauncherCursor =>
    walk.length > 0 ? { kind: 'pane', at: 0 } : { kind: 'model' }

  useInput(
    (ch, key) => {
      // An open script field owns every key: a Dockerfile is written in lines, so
      // enter is a newline here rather than the commit it is everywhere else, and
      // esc is what commits and collapses the row.
      if (scriptEditor !== null) {
        const { text: script, cursor: at } = scriptEditor
        const set = (next: string, cursorAt: number): void =>
          setScriptEditor({ ...scriptEditor, text: next, cursor: cursorAt })
        // Every keystroke writes through to the pane, so the row under the editor
        // is never out of date with what is being typed.
        const write = (next: string, cursorAt: number): void => {
          set(next, cursorAt)
          editPane((p) => ({
            ...p,
            [scriptEditor.section]: {
              ...p[scriptEditor.section],
              [scriptEditor.field]: next,
            },
          }))
        }
        if (key.escape) {
          setScriptEditor(null)
          return
        }
        if (key.return) {
          write(script.slice(0, at) + '\n' + script.slice(at), at + 1)
          return
        }
        if (key.leftArrow) {
          set(script, Math.max(0, at - 1))
          return
        }
        if (key.rightArrow) {
          set(script, Math.min(script.length, at + 1))
          return
        }
        // ↑/↓ move a line at a time, keeping the column where it can.
        if (key.upArrow || key.downArrow) {
          const lineStart = script.lastIndexOf('\n', at - 1) + 1
          const column = at - lineStart
          if (key.upArrow) {
            if (lineStart === 0) return
            const prevStart = script.lastIndexOf('\n', lineStart - 2) + 1
            set(script, Math.min(prevStart + column, lineStart - 1))
            return
          }
          const lineEnd = script.indexOf('\n', at)
          if (lineEnd === -1) return
          const nextEnd = script.indexOf('\n', lineEnd + 1)
          set(script, Math.min(lineEnd + 1 + column, nextEnd === -1 ? script.length : nextEnd))
          return
        }
        if (key.backspace || key.delete) {
          if (at > 0) write(script.slice(0, at - 1) + script.slice(at), at - 1)
          return
        }
        if (ch && !key.ctrl && !key.meta) {
          write(script.slice(0, at) + ch + script.slice(at), at + ch.length)
        }
        return
      }
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
          editPane((p) => ({
            ...p,
            // A repeat of a name is an edit of it, not a duplicate row.
            mcpServers: [...p.mcpServers.filter((s) => s.name !== entry.name), entry],
          }))
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
      // The open model dropdown is a modal subtree: ↑/↓ walk its options,
      // → (or enter/space) activates the highlighted one, ← (or esc) backs out.
      if (openModel !== null) {
        const optionCount = modelOptions.length
        if (key.escape || key.leftArrow) {
          setOpenModel(null)
          return
        }
        if (key.upArrow) {
          setOpenModel((p) => p && { hover: Math.max(0, p.hover - 1) })
          return
        }
        if (key.downArrow) {
          setOpenModel((p) => p && { hover: Math.min(optionCount - 1, p.hover + 1) })
          return
        }
        if (key.rightArrow || key.return || ch === ' ') {
          setModelPick(Math.min(openModel.hover, optionCount - 1))
          setOpenModel(null)
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
      // The preset row: ←/→ move the pick, ↑ returns to the prompt, ↓ walks
      // into the field rows, esc returns to the prompt, typing does too.
      if (cursor.kind === 'presets') {
        if (key.leftArrow) {
          pickPreset((checkedPresetIdx ?? presets.length) - 1)
          return
        }
        if (key.rightArrow) {
          if (checkedPresetIdx === undefined) pickPreset(0)
          else if (!isCustom) pickPreset(checkedPresetIdx + 1)
          return
        }
        if (key.upArrow) {
          setCursor({ kind: 'prompt' })
          return
        }
        if (key.downArrow) {
          setCursor(firstPaneCursor())
          return
        }
        if (key.escape) {
          setCursor({ kind: 'prompt' })
          return
        }
        if (ch && ch !== ' ' && !key.ctrl && !key.meta && !key.return) toPromptWith(ch)
        return
      }
      // A field row: ↑ off the first climbs to the preset row, ↓ off the last
      // lands on the model row. The branch and compute rows are one-line
      // inputs edited by typing, blank = whatever the server resolves.
      if (cursor.kind === 'pane') {
        // The walk shrank under the cursor (the repo list refetched, a repo
        // unchecked): fall back onto the nearest row.
        if (walk.length === 0) {
          setCursor({ kind: 'presets' })
          return
        }
        const at = Math.min(cursor.at, walk.length - 1)
        const step = walk[at]
        if (key.upArrow) {
          if (at === 0) setCursor({ kind: 'presets' })
          else setCursor({ kind: 'pane', at: at - 1 })
          return
        }
        if (key.downArrow) {
          if (at >= walk.length - 1) setCursor({ kind: 'model' })
          else setCursor({ kind: 'pane', at: at + 1 })
          return
        }
        if (key.escape) {
          setCursor({ kind: 'prompt' })
          return
        }
        const target = environmentSectionAt(paneInput, step.section, step.hover)
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
            editPane((p) => ({
              ...p,
              compute: { ...p.compute, [target.field]: p.compute[target.field].slice(0, -1) },
            }))
            return
          }
          // cpu is a number on the wire, so its field only admits digits.
          if (typing && (target.field !== 'cpu' || /^[0-9.]$/.test(ch))) {
            editPane((p) => ({
              ...p,
              compute: { ...p.compute, [target.field]: p.compute[target.field] + ch },
            }))
            return
          }
        }
        if (key.return || key.rightArrow || ch === ' ') {
          activateRow(step.section, step.hover)
          return
        }
        if (typing) toPromptWith(ch)
        return
      }
      // The model row: →/enter opens its list on the checked row, so the walk
      // starts where the run currently stands rather than at the top.
      if (cursor.kind === 'model') {
        if (key.upArrow) {
          setCursor(lastPaneCursor())
          return
        }
        if (key.downArrow) {
          if (!hideList && shown.length > 0) setCursor({ kind: 'list', id: shown[0].id })
          return
        }
        if (key.return || key.rightArrow) {
          setOpenModel({ hover: modelIdx })
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
        // back to the model row), enter opens the highlighted session.
        if (key.upArrow) {
          if (listIdx <= 0) setCursor({ kind: 'model' })
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
      // At the prompt box: ↓ lands on the preset row just under it.
      if (key.return) {
        submit()
        return
      }
      if (key.downArrow) {
        setCursor({ kind: 'presets' })
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

  // Columns available inside the prompt box: the terminal minus its left accent
  // bar and the interior padding on both sides.
  const contentWidth = Math.max(1, width - 1 - PROMPT_PAD_X * 2)
  const modelHover = openModel ? Math.min(openModel.hover, modelOptions.length - 1) : -1
  // Every option plus its group heading — the open dropdown prints the whole
  // list, so a long model list grows the block and the terminal scrolls rather
  // than hiding rows behind a window.
  const modelRows = openModel ? composerPickerRows(modelOptions) : []
  // The price table's column widths: the label column, then one numeric column
  // per lane, each as wide as its widest cell (its heading included) so the
  // dollars read down a right-aligned column. null when there is no price to
  // quote, or when the terminal is too narrow to hold the whole table — a
  // padded row would push the last column off the right edge.
  const rateTable = (() => {
    if (!openModel || !modelOptions.some((o) => o.rate)) return null
    const label = Math.max(...modelOptions.map((o) => o.label.length))
    const input = Math.max(2, ...modelOptions.map((o) => (o.rate?.input ?? '').length))
    const output = Math.max(3, ...modelOptions.map((o) => (o.rate?.output ?? '').length))
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

  // The gutter every row under the prompt box shares: the ▶ moves down one
  // left edge, one column in from the terminal's.
  const gutter = (on: boolean): React.ReactNode => (
    <Text>
      {' '}
      <Text color={theme.cursor}>{on ? SELECTION_GLYPH : ' '}</Text>{' '}
    </Text>
  )
  // The blank a continuation line prints under a field row's label column.
  const fieldContinuation = ' '.repeat(3 + FIELD_INDENT.length + FIELD_LABEL_WIDTH)

  // A field row's content, after its label column. The label prints on the
  // section's first row only; the rest of the section's rows leave the column
  // blank so the values read as one list.
  const renderField = (step: PaneWalkStep, at: number): React.ReactNode => {
    const paneRow = environmentSectionRows(paneInput, step.section)[step.hover]
    if (!paneRow) return null
    // A form owns the caret while it is open, so the row's own highlight goes
    // dark rather than showing a second one.
    const hovered =
      focused &&
      cursor.kind === 'pane' &&
      Math.min(cursor.at, walk.length - 1) === at &&
      editor === null &&
      serverEditor === null &&
      scriptEditor === null
    const label = step.first ? PANE_SECTION_LABELS[step.section] : ''
    const prefix = (
      <Text>
        {gutter(hovered)}
        {FIELD_INDENT}
        <Text color={theme.muted}>{label.padEnd(FIELD_LABEL_WIDTH)}</Text>
      </Text>
    )
    const key = `${step.section}:${step.hover}`
    if (paneRow.kind === 'repo') {
      const checked = repositoryFor(paneRow.fullName) !== undefined
      return (
        <Box key={key} width={width}>
          <Text wrap="truncate">
            {prefix}
            <Text color={hovered || checked ? theme.foreground : theme.muted}>
              {`[${checked ? 'x' : ' '}] ${paneRow.fullName}`}
            </Text>
          </Text>
        </Box>
      )
    }
    // A checked repo's branch input: typing edits the ref in place; empty rests
    // on the repo's default branch.
    if (paneRow.kind === 'repoRef') {
      const ref = repositoryFor(paneRow.fullName)?.ref ?? null
      const resting = repositoryRefLabel(
        ref,
        (repos ?? []).find((r) => r.full_name === paneRow.fullName)?.default_branch ?? null,
      )
      return (
        <Box key={key} width={width}>
          <Text wrap="truncate">
            {prefix}
            {/* Aligned under the repo name, past its checkbox. */}
            <Text color={theme.muted}>{'    branch: '}</Text>
            {ref !== null ? (
              <Text color={theme.foreground}>
                {ref}
                {hovered && <Text inverse> </Text>}
              </Text>
            ) : (
              // The default branch as a placeholder: it is what an untouched
              // row clones, and typing replaces it.
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
    // A compute field: a one-line input like a branch row, blank meaning
    // whatever the server resolves.
    if (paneRow.kind === 'compute') {
      const held = shownPane.compute[paneRow.field]
      return (
        <Box key={key} width={width}>
          <Text wrap="truncate">
            {prefix}
            <Text color={theme.muted}>{`${paneRow.field}: `}</Text>
            <Text color={theme.foreground}>
              {held}
              {hovered && <Text inverse> </Text>}
            </Text>
          </Text>
        </Box>
      )
    }
    // An image or hook field: a script, so it prints as a YAML block scalar
    // over its own lines rather than crushed onto the label's line. Long ones
    // are capped and say how many lines they are hiding, since a hidden line
    // is a hidden instruction to the sandbox. Enter opens it (scriptEditor),
    // which prints every line and puts a real caret in the text.
    if (paneRow.kind === 'image' || paneRow.kind === 'hook') {
      const section = paneRow.kind === 'image' ? 'image' : 'hooks'
      const editing = scriptEditor?.section === section && scriptEditor.field === paneRow.field
      const held = editing
        ? scriptEditor.text
        : (shownPane[section][paneRow.field as never] as string)
      const { lines, hidden } = scriptRowLines(held, editing)
      return (
        <Box key={key} flexDirection="column" width={width}>
          <Box width={width}>
            <Text wrap="truncate">
              {prefix}
              <Text color={theme.muted}>{`${paneRow.field}:`}</Text>
              {/* The block-scalar marker, so a multi-line value reads the way
                  it would in the environment YAML. */}
              <Text color={theme.muted}>{held === '' ? '' : ' |'}</Text>
              {held === '' && (hovered || editing) && <Text inverse> </Text>}
            </Text>
          </Box>
          {held !== '' &&
            lines.map((line, i) => {
              // The caret sits in the open editor's text, at the line and
              // column it is actually on.
              const before = lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0)
              const column = editing ? scriptEditor.cursor - before : -1
              const here = editing && column >= 0 && column <= line.length
              return (
                <Box key={i} width={width}>
                  <Text wrap="truncate">
                    {fieldContinuation}
                    {'  '}
                    <Text color={theme.foreground}>
                      {here ? (
                        <Text>
                          {line.slice(0, column)}
                          <Text inverse>{line[column] ?? ' '}</Text>
                          {line.slice(column + 1)}
                        </Text>
                      ) : (
                        line
                      )}
                    </Text>
                  </Text>
                </Box>
              )
            })}
          {hidden > 0 && (
            <Box width={width}>
              <Text wrap="truncate" color={theme.muted}>
                {fieldContinuation}
                {`  … ${hidden} more line${hidden === 1 ? '' : 's'}`}
              </Text>
            </Box>
          )}
        </Box>
      )
    }
    if (paneRow.kind === 'mcpServer') {
      const checked = shownPane.mcpServers.some((s) => s.name === paneRow.name)
      return (
        <Box key={key} width={width}>
          <Text wrap="truncate">
            {prefix}
            <Text color={hovered || checked ? theme.foreground : theme.muted}>
              {`[${checked ? 'x' : ' '}] ${paneRow.name}`}
            </Text>
          </Text>
        </Box>
      )
    }
    if (paneRow.kind === 'variable') {
      const held = variableFor(paneRow.name)
      return (
        <Box key={key} width={width}>
          <Text wrap="truncate">
            {prefix}
            <Text color={hovered || held !== undefined ? theme.foreground : theme.muted}>
              {`[${held !== undefined ? 'x' : ' '}] ${variableRowLabel(paneRow.name, held?.value)}`}
            </Text>
          </Text>
        </Box>
      )
    }
    // The two "+ new" buttons, each growing its form under itself while open.
    // A form's fields sit indented under the button text, the caret on the
    // field being typed.
    const isServer = paneRow.kind === 'addMcpServer'
    const form = isServer ? serverEditor : editor
    const fields: readonly string[] = isServer ? SERVER_EDITOR_FIELDS : ['name', 'value']
    const ghostFor = (field: string): string => {
      if (!isServer) return field === 'name' ? NAME_PLACEHOLDER : VALUE_PLACEHOLDER
      // name is required; command/url pick the type, so their placeholders
      // say the either/or.
      return field === 'name'
        ? 'my-tools'
        : field === 'command'
          ? 'stdio: npx -y my-tools-mcp'
          : 'remote: https://mcp.example.com'
    }
    return (
      <Box key={key} flexDirection="column" width={width}>
        <Box width={width}>
          <Text wrap="truncate">
            {prefix}
            <Text color={hovered ? theme.foreground : theme.muted}>
              {isServer ? ADD_MCP_SERVER_LABEL : ADD_VARIABLE_LABEL}
            </Text>
          </Text>
        </Box>
        {form !== null && (
          <Box flexDirection="column" width={width}>
            {fields.map((field) => {
              const here = form.field === field
              const typed = (form as unknown as Record<string, string>)[field]
              const ghost = typed !== '' ? null : ghostFor(field)
              return (
                <Box key={field} width={width}>
                  <Text wrap="truncate">
                    {gutter(here)}
                    {FIELD_INDENT}
                    {' '.repeat(FIELD_LABEL_WIDTH)}
                    <Text color={theme.muted}>{`  ${field}: `}</Text>
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
            {form.error !== null && (
              <Box width={width}>
                <Text wrap="truncate" color={theme.muted}>
                  {fieldContinuation}
                  {'  '}
                  {form.error}
                </Text>
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
  }

  const caretVisible = focused && cursor.kind === 'prompt' && !starting && openModel === null
  const listWin = navSlice(shown.length, LIST_ROWS, listIdx)
  const showList = !hideList
  // The bottom line is for news only — the prompt box's hint already carries the
  // key map, so there is nothing routine to print here.
  const statusLine = armed ? CTRL_C_QUIT_HINT : starting ? '✻ Starting session…' : null
  const presetsActive = focused && cursor.kind === 'presets'
  const modelActive = focused && cursor.kind === 'model' && openModel === null
  // What the row under the presets says about the checked one: the account
  // default and/or where its file lives; for `custom`, which preset it was
  // edited from. Nothing while the default is still unknown.
  const presetNote = isCustom
    ? pickedPreset
      ? `edited from ${pickedPreset.name}`
      : null
    : (pickedPreset?.note ?? null)

  return (
    <Box flexDirection="column" width={width}>
      {/* The prompt box: the chat composer's painted slab, with an accent bar
          down its left edge and a blank row of padding above and below the
          prompt row. */}
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
              {/* The row's persistent label: typed text sits after it, the
                  hint only fills the empty input. */}
              <Text color={theme.muted}>{PROMPT_LABEL.toUpperCase()}: </Text>
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
      <Text> </Text>
      {/* The preset row: the saved environments laid out side by side, the
          checked one bracketed. Presets wrap onto further lines when the row
          runs out of width, so every one stays reachable. */}
      <Box width={width} flexDirection="row" flexWrap="wrap">
        <Box flexShrink={0}>
          <Text>
            {gutter(presetsActive)}
            <Text color={theme.muted}>
              {ENVIRONMENT_LABEL.toUpperCase().padEnd(HEADER_LABEL_WIDTH)}
            </Text>
          </Text>
        </Box>
        {presetRow.map((p, at) => {
          const checked = at === checkedPresetIdx
          return (
            <Box key={p.id} flexShrink={0} marginRight={2}>
              <Text color={checked ? theme.foreground : theme.muted} bold={checked}>
                {checked ? `▸${p.name}◂` : ` ${p.name} `}
              </Text>
            </Box>
          )
        })}
      </Box>
      {presetNote && (
        <Box width={width}>
          <Text wrap="truncate" color={theme.muted}>
            {' '.repeat(3 + HEADER_LABEL_WIDTH)}
            {presetNote}
          </Text>
        </Box>
      )}
      {/* The field rows: what the checked preset resolves to, every section
          open, edited in place. */}
      {walk.map((step, at) => renderField(step, at))}
      {/* The model row, opening its dropdown under itself. */}
      <Box width={width} flexDirection="column">
        <Box width={width}>
          <Text wrap="truncate">
            {gutter(modelActive)}
            <Text color={theme.muted}>{MODEL_LABEL.toUpperCase().padEnd(HEADER_LABEL_WIDTH)}</Text>
            <Text color={modelActive || openModel !== null ? theme.foreground : theme.muted}>
              {modelOptions[modelIdx]?.label ?? 'Default'}
            </Text>
          </Text>
        </Box>
        {/* The price table's column heads, over the numeric columns they
            name, with the unit stated once here instead of on every row. */}
        {openModel !== null && rateTable && (
          <Box width={width}>
            <Text wrap="truncate" color={theme.muted}>
              {' '.repeat(OPTION_GUTTER + rateTable.label)}
              {rateCells({ input: 'IN', output: 'OUT' })}
              {RATE_UNIT}
            </Text>
          </Box>
        )}
        {openModel !== null &&
          modelRows.map((pickerRow) => {
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
            const opt = modelOptions[at]
            if (!opt) return null
            const hovered = at === modelHover
            const picked = at === modelIdx
            return (
              <Box key={opt.id ?? 'default'} width={width}>
                <Text wrap="truncate">
                  {'   '}
                  <Text color={theme.cursor}>{hovered ? SELECTION_GLYPH : ' '}</Text>{' '}
                  <Text color={hovered || picked ? theme.foreground : theme.muted}>
                    {`[${picked ? 'x' : ' '}] ${rateTable ? opt.label.padEnd(rateTable.label) : opt.label}`}
                  </Text>
                  {/* The prices, always muted — the table's numbers next to
                      the id whether or not the row is the highlighted one, so
                      walking the list never moves the eye off the name. */}
                  <Text color={theme.muted}>{rateCells(opt.rate)}</Text>
                </Text>
              </Box>
            )
          })}
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
            {showList ? ' RECENT SESSIONS:' : ' '}
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
