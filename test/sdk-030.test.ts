import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAutomation } from '../src/commands/automation'
import { registerEnvironment } from '../src/commands/environment'
import { registerSession, watchSession } from '../src/commands/session'
import { api } from '../src/lib/api'
import { session } from './fixtures/session'

let dir: string
let requests: { url: URL; body: Record<string, unknown> | undefined }[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sdk-030-'))
  requests = []
  vi.stubEnv('ELLIPSIS_CONFIG_DIR', dir)
  vi.stubEnv('ELLIPSIS_API_BASE_URL', 'https://example.test')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url: new URL(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify({ session: session(), agents: [], agent: { id: 'a_1' }, segments: [] }))
  }))
  process.exitCode = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
  process.exitCode = 0
})

async function command(args: string[]): Promise<void> {
  const program = new Command().exitOverride()
  registerSession(program)
  registerAutomation(program)
  registerEnvironment(program)
  await program.parseAsync(['node', 'ellipsis', ...args])
  expect(process.exitCode).toBe(0)
}

describe('SDK 0.30 request contracts', () => {
  it('sends one native harness block after a config override switches harnesses', async () => {
    const file = join(dir, 'agent.yaml')
    writeFileSync(file, 'session:\n  claude_code:\n    prompt: fix the tests\n    max_turns: 3\n')
    await command(['session', 'start', '--config-file', file, '--harness', 'codex', '--model', 'gpt-6-astra', '--json'])
    expect(requests[0].body).toMatchObject({ codex: { model: 'gpt-6-astra', prompt: 'fix the tests' } })
    expect(requests[0].body).not.toHaveProperty('claude_code')
    expect(requests[0].body).not.toHaveProperty('harness')
    expect(requests[0].body?.codex).not.toHaveProperty('max_turns')
  })

  it('applies --model to the harness from the config and --prompt to its native prompt', async () => {
    const file = join(dir, 'agent.yaml')
    writeFileSync(file, 'session:\n  codex:\n    model: gpt-6-astra\n    prompt: original\n    effort: high\n')
    await command(['session', 'start', '--config-file', file, '--model', 'gpt-5.6-terra', '--prompt', 'new prompt', '--json'])
    expect(requests[0].body?.codex).toEqual({ model: 'gpt-5.6-terra', prompt: 'new prompt', effort: 'high' })
    expect(requests[0].body).not.toHaveProperty('claude_code')
  })

  it('uses agents for automation commands and the session filter', async () => {
    await command(['automation', 'list', '--json'])
    expect(requests[0].url.pathname).toBe('/v1/agents')
    await command(['session', 'list', '--automation', 'a_1', '--json'])
    expect(requests[1].url.searchParams.get('agent')).toBe('a_1')
    expect(requests[1].url.searchParams.has('automation')).toBe(false)
  })

  it('scaffolds and creates a native agent definition', async () => {
    const file = join(dir, 'agent.yaml')
    await command(['automation', 'init', file])
    const config = parse(readFileSync(file, 'utf8'))
    expect(config.ellipsis.kind).toBe('agent')
    expect(config.session.claude_code.prompt).toContain('Describe the task')
    expect(config.session).not.toHaveProperty('harness')
    await command(['automation', 'create', '--file', file, '--json'])
    expect(requests[0].url.pathname).toBe('/v1/agents')
    expect(requests[0].body).toEqual({ agent: config })
  })

  it('downloads the archive through the renamed endpoint', async () => {
    await command(['session', 'export', 's_1', '--json'])
    expect(requests[0].url.pathname).toBe('/v1/sessions/s_1/download')
  })

  it('scaffolds supported environment hooks', async () => {
    const file = join(dir, 'environment.yaml')
    await command(['environment', 'init', file])
    const config = parse(readFileSync(file, 'utf8'))
    expect(config.hooks.build_base).toContain('install CLIs')
    expect(config).not.toHaveProperty('image')
  })

  it.each(['completed', 'budget_hit'] as const)('uses the execution outcome when a conversation closes: %s', async (reason) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ session: session({ lifecycle: { status: 'closed', last_execution_result: { completion_reason: reason, detail: null } } }) }))))
    await watchSession(api(), 's_1', 1, true)
    expect(process.exitCode).toBe(reason === 'completed' ? 0 : 1)
  })
})
