import { describe, expect, it } from 'vitest'
import {
  completedText,
  isCommandInput,
  matchCommands,
  resolveCommand,
  SLASH_COMMANDS,
} from '../src/ui/commands'

describe('isCommandInput', () => {
  it('claims a line only when the slash LEADS it', () => {
    expect(isCommandInput('/stop')).toBe(true)
    expect(isCommandInput('/')).toBe(true)
    // Ordinary prose that happens to contain a slash still reaches the agent.
    expect(isCommandInput('check /tmp for the log')).toBe(false)
    expect(isCommandInput('what does a/b mean')).toBe(false)
    expect(isCommandInput('')).toBe(false)
  })
})

describe('matchCommands', () => {
  const names = (text: string): string[] => matchCommands(text).map((c) => c.name)

  it('offers everything for a bare slash', () => {
    expect(names('/')).toEqual(SLASH_COMMANDS.map((c) => c.name))
  })

  it('narrows by prefix', () => {
    expect(names('/st')).toEqual(['stop'])
    expect(names('/s')).toEqual(['stop', 'sessions'])
    expect(names('/e')).toEqual(['exit'])
  })

  it('matches aliases but shows the canonical name', () => {
    expect(names('/qu')).toEqual(['exit'])
    expect(names('/quit')).toEqual(['exit'])
  })

  it('is case-insensitive', () => {
    expect(names('/ST')).toEqual(['stop'])
  })

  it('offers nothing once a space commits to a command', () => {
    // The first word is the command; past it there is nothing left to complete.
    expect(names('/stop ')).toEqual([])
    expect(names('/stop now')).toEqual([])
  })

  it('offers nothing for prose or an unknown prefix', () => {
    expect(names('hello')).toEqual([])
    expect(names('/zzz')).toEqual([])
  })
})

describe('resolveCommand', () => {
  it('needs the WHOLE name, so a prefix never runs the wrong command', () => {
    expect(resolveCommand('/stop')?.id).toBe('stop')
    // '/s' matches two commands in the menu; running either would be a guess.
    expect(resolveCommand('/s')).toBeNull()
    expect(resolveCommand('/st')).toBeNull()
  })

  it('accepts aliases and surrounding whitespace', () => {
    expect(resolveCommand('/quit')?.id).toBe('exit')
    expect(resolveCommand('/exit')?.id).toBe('exit')
    expect(resolveCommand('/stop  ')?.id).toBe('stop')
    expect(resolveCommand('/STOP')?.id).toBe('stop')
  })

  it('returns null for prose and for an unknown command', () => {
    expect(resolveCommand('hello')).toBeNull()
    expect(resolveCommand('/stpo')).toBeNull()
  })
})

describe('completedText', () => {
  it('completes to the canonical name with a trailing space', () => {
    expect(completedText(SLASH_COMMANDS[0])).toBe('/stop ')
    // An alias completes to the name it stands for, not to the alias.
    const exit = SLASH_COMMANDS.find((c) => c.id === 'exit')
    expect(completedText(exit!)).toBe('/exit ')
  })

  it('produces text that resolves back to the same command', () => {
    for (const command of SLASH_COMMANDS) {
      expect(resolveCommand(completedText(command))?.id).toBe(command.id)
    }
  })
})

describe('the command list itself', () => {
  it('has no duplicate names or aliases, so a spelling means one thing', () => {
    const spellings = SLASH_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])])
    expect(new Set(spellings).size).toBe(spellings.length)
  })

  it('describes every command, since the menu shows the detail', () => {
    for (const command of SLASH_COMMANDS) {
      expect(command.detail, command.name).toMatch(/^[a-z]/)
      expect(command.detail.length, command.name).toBeGreaterThan(8)
    }
  })
})
