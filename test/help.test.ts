import { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { resolveCommandPath } from '../src/commands/help'
import { alsoKnownAs } from '../src/lib/help'

function tree(): Command {
  const program = new Command().name('agent')
  const session = alsoKnownAs(program.command('session'), 'sessions')
  alsoKnownAs(session.command('list'), 'ls')
  return program
}

// Registering our own `help` command replaces commander's built-in one, so the
// `agent help <command>` passthrough is ours to keep working.
describe('resolveCommandPath', () => {
  it('resolves the program itself for a bare `agent help`', () => {
    expect(resolveCommandPath(tree(), [])?.name()).toBe('agent')
  })

  it('walks nested paths, which the built-in help never did', () => {
    expect(resolveCommandPath(tree(), ['session', 'list'])?.name()).toBe('list')
  })

  it('resolves hidden aliases so `help sessions` matches `help session`', () => {
    expect(resolveCommandPath(tree(), ['sessions'])?.name()).toBe('session')
    expect(resolveCommandPath(tree(), ['session', 'ls'])?.name()).toBe('list')
  })

  it('returns undefined for an unknown command instead of falling back', () => {
    expect(resolveCommandPath(tree(), ['bogus'])).toBeUndefined()
    expect(resolveCommandPath(tree(), ['session', 'bogus'])).toBeUndefined()
  })
})
