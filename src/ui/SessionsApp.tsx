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
  navSlice,
  sessionBarQuery,
  SELECTION_GLYPH,
  sidebarSlice,
  mergeSidebarSessions,
} from '../lib/sessions'
import type { ResolvedSessionBar } from '../lib/config'
import { theme } from '../lib/theme'
import { ConnectApp } from './ConnectApp'

// The multi-session UI — what a bare `agent`, `agent "prompt"`, and `agent
// session connect <id>` all open. Two screens, both on the primary buffer:
//
//   * the LAUNCHER: a compact inline block (~10 rows) — a "connected to"
//     line, the Repository / Agent / Model rows, the prompt, and the latest
//     sessions underneath. Enter on the prompt starts a session; enter on a
//     session row opens its chat. It is short by design, so ink repaints it
//     in place like any live frame; no alternate screen, no full-height frame.
//   * the CHAT (ConnectApp) — owns the terminal outright. Its settled
//     transcript is printed into the terminal's real scrollback, so the
//     wheel, the trackpad and select/copy are the terminal's own.
//
// esc in the chat returns to the launcher (the launcher paints below the
// settled transcript); enter on a session replaces the launcher with its chat.
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
const OPTION_GUTTER = '  '.length + 2 + '[x] '.length

// The unit the price columns are quoted in, printed once on their column head.
const RATE_UNIT = '  per 1M'

export interface SessionsAppProps {
  api: Ellipsis
  openSocket: OpenSocket
  // app.ellipsis.dev base + the customer login, for per-session dashboard links.
  appBase: string
  customerLogin: string
  // My GitHub login for the launcher's "connected to … as @me in account"
  // line; null on an API-key credential, which has no GitHub user behind it.
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
          notice: [notice, c.reason].filter(Boolean).join(' · ') || null,
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

  const toLauncher = useCallback((): void => {
    setMainPane({ type: 'launcher' })
  }, [])
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

  const whoLine = props.ghLogin
    ? `connected to ellipsis.dev as @${props.ghLogin} in ${customerLogin}`
    : `connected to ellipsis.dev as ${customerLogin}`

  return (
    <Launcher
      width={width}
      height={termRows}
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

// One row of the launcher's option block: a label + the picked value(s),
// opened into its option list with →/enter (the dashboard composer's selects,
// terminal-shaped). Repositories multi-select; the others pick one.
type PickerRow = { key: 'config' | 'model' | 'repo'; label: string }
const PICKER_ROWS: readonly PickerRow[] = [
  { key: 'repo', label: 'Repository' },
  { key: 'config', label: 'Agent' },
  { key: 'model', label: 'Model' },
]

// Where the launcher's cursor is: the prompt, one of the option rows above it
// (by PICKER_ROWS index), or a session row below it (by id, so the poll
// re-sorting under the cursor doesn't move the highlight).
type LauncherCursor =
  | { kind: 'prompt' }
  | { kind: 'option'; at: number }
  | { kind: 'list'; id: string }

// The launcher: a compact inline block, ~10 rows tall —
//
//   connected to ellipsis.dev as @me in account
//     Repository: owner/name
//     Agent: Default
//     Model: Default
//   ❯ Start a cloud agent…
//   ● latest session          2m ago
//   ● …                       (LIST_ROWS rows; scrolls near the bottom)
//
// The ❯ glyph marks whichever row holds the cursor. From the prompt, ↑ climbs
// into the option rows (↑/↓ walk them, →/enter unfolds a row's option list in
// place, ← or esc backs out) and ↓ drops into the session list (↑ off its top
// returns to the prompt, enter opens the highlighted session). Typing anywhere
// returns the cursor to the prompt. Enter on the prompt starts a session; an
// empty prompt starts it idle. "Default" everywhere means the server resolves
// it. Repository is the one multi-select ([x] toggles; uncheck everything for
// a sandbox with no checkout).
function Launcher({
  width,
  height,
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
  height: number
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
      { id: null as string | null, label: 'Default' },
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

  // Where the list cursor sits in the current sort; the id survives the poll
  // re-sorting rows, and a session that left the list snaps to the top.
  const listIdx =
    cursor.kind === 'list' ? Math.max(0, sessions.findIndex((s) => s.id === cursor.id)) : 0

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
        // The option rows above the prompt, walked vertically: ↑/↓ move
        // between them (↑ stops at the first, ↓ off the last returns to the
        // prompt), →/enter opens the row's list, typing returns to the prompt.
        if (key.upArrow) {
          setCursor({ kind: 'option', at: Math.max(0, cursor.at - 1) })
          return
        }
        if (key.downArrow) {
          if (cursor.at >= PICKER_ROWS.length - 1) setCursor({ kind: 'prompt' })
          else setCursor({ kind: 'option', at: cursor.at + 1 })
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
        // The session rows below the prompt: ↑/↓ walk them (↑ off the top
        // returns to the prompt), enter opens the highlighted session.
        if (key.upArrow) {
          if (listIdx <= 0) setCursor({ kind: 'prompt' })
          else setCursor({ kind: 'list', id: sessions[listIdx - 1].id })
          return
        }
        if (key.downArrow) {
          if (listIdx < sessions.length - 1)
            setCursor({ kind: 'list', id: sessions[listIdx + 1].id })
          return
        }
        if (key.return) {
          const picked = sessions[listIdx]
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
      // At the prompt: ↑ climbs into the option rows above it (landing on the
      // nearest, Model), ↓ drops into the session list below.
      if (key.return) {
        submit()
        return
      }
      if (key.upArrow) {
        setCursor({ kind: 'option', at: PICKER_ROWS.length - 1 })
        return
      }
      if (key.downArrow) {
        if (!hideList && sessions.length > 0) setCursor({ kind: 'list', id: sessions[0].id })
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
      if (key.escape || key.ctrl || key.meta || key.tab) return
      if (ch) {
        setText((t) => t.slice(0, textCursor) + ch + t.slice(textCursor))
        setTextCursor((c) => c + ch.length)
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

  // How many option rows an open dropdown shows: enough to be useful, capped
  // so the whole launcher still fits a short terminal.
  const dropdownCapacity = Math.max(3, Math.min(10, height - (LIST_ROWS + 8)))
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
  const listWin = navSlice(sessions.length, LIST_ROWS, listIdx)
  // One status line under the list, only when there is something to say:
  // otherwise the launcher ends on the session rows.
  const statusLine = armed
    ? CTRL_C_QUIT_HINT
    : starting
      ? '✻ Starting session…'
      : null

  return (
    <Box flexDirection="column" width={width}>
      <Text wrap="truncate" color={theme.muted}>
        {whoLine}
      </Text>
      {PICKER_ROWS.map((r, i) => {
        const active =
          focused && openPicker === null && cursor.kind === 'option' && cursor.at === i
        const isOpen = open?.key === r.key
        if (isOpen) {
          return (
            <Box key={r.key} flexDirection="column" width={width}>
              <Text color={theme.muted}>{'  '}{r.label}:</Text>
              {/* The price table's column heads, over the numeric columns they
                  name, with the unit stated once here instead of on every row. */}
              {rateTable && (
                <Box width={width}>
                  <Text wrap="truncate" color={theme.muted}>
                    {' '.repeat(OPTION_GUTTER + rateTable.label)}
                    {rateCells({ input: 'IN', output: 'OUT' })}
                    {RATE_UNIT}
                  </Text>
                </Box>
              )}
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
                      {'  '}
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
              {hiddenBelow > 0 && (
                <Text color={theme.muted}>
                  {'    '}… {hiddenBelow} more
                </Text>
              )}
            </Box>
          )
        }
        return (
          <Box key={r.key} width={width}>
            <Text wrap="truncate">
              {'  '}
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
      {/* The prompt. ONE ❯ on the whole launcher: the prompt's gutter carries
          it only while the prompt holds the cursor — a blank cell otherwise,
          exactly like the rows above and below. Wraps instead of truncating: a
          long prompt flows onto the next row rather than running off the right
          edge. The explicit width is what ink wraps against; the key remounts
          the node so a stale measurement can't misplace the caret. */}
      <Box width={width} alignItems="flex-start">
        {/* The glyph lives in its own fixed gutter so wrapped prompt lines
            align under the first typed character, not under the glyph. */}
        <Box width={2} flexShrink={0}>
          <Text color={theme.cursor}>
            {focused && cursor.kind === 'prompt' && openPicker === null ? SELECTION_GLYPH : ' '}
          </Text>
        </Box>
        <Box width={width - 2}>
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
            {/* Empty input: the placeholder sits where typed text will land,
                its first character carrying the caret (inverse) instead of a
                caret cell of its own pushing it a column right. */}
            {text === '' && caretVisible && (
              <Text>
                <Text inverse>S</Text>
                <Text color={theme.muted}>tart a cloud agent…</Text>
              </Text>
            )}
            {text === '' && !caretVisible && (
              <Text color={theme.muted}>Start a cloud agent…</Text>
            )}
          </Text>
        </Box>
      </Box>
      {/* The latest sessions, under the prompt: status dot + description + a
          dim meta tag, in sortSidebarSessions order (status band, newest
          first), windowed so the highlight parks two rows from the bottom and
          the list scrolls under it. */}
      {!hideList &&
        sessions.slice(listWin.start, listWin.end).map((s) => {
          const word = rowStatusWord(s)
          const g = rowGlyph(word)
          const cursorHere = focused && cursor.kind === 'list' && sessions[listIdx]?.id === s.id
          const desc = rowDescription(s)
          // The meta tag rides the right edge; the description takes what's
          // left and truncates, so a long prompt can never push the tag off
          // the row.
          const meta = `${rowMeta(s)}${attention.has(s.id) ? ' · needs you' : ''}`
          const descW = Math.max(8, width - meta.length - 8)
          return (
            <Box key={s.id} width={width}>
              <Box width={2} flexShrink={0}>
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
      {!hideList && sessions.length === 0 && (
        <Text color={theme.muted}>
          {'  '}
          {polledOnce ? 'no sessions yet' : 'loading sessions…'}
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
