import { describe, expect, it } from 'vitest'
import {
  applyEditShortcut,
  lineEnd,
  lineStart,
  wordLeft,
  wordRight,
  type EditKey,
} from '../src/lib/editing'

function key(overrides: Partial<EditKey> = {}): EditKey {
  return {
    ctrl: false,
    meta: false,
    leftArrow: false,
    rightArrow: false,
    backspace: false,
    delete: false,
    ...overrides,
  }
}

describe('wordLeft / wordRight', () => {
  it('hops whole words, skipping the whitespace between them', () => {
    expect(wordLeft('fix the webhook tests', 21)).toBe(16)
    expect(wordLeft('fix the webhook tests', 16)).toBe(8)
    expect(wordRight('fix the webhook tests', 0)).toBe(3)
    expect(wordRight('fix the webhook tests', 3)).toBe(7)
  })

  it('stops at the text edges', () => {
    expect(wordLeft('abc', 0)).toBe(0)
    expect(wordRight('abc', 3)).toBe(3)
    expect(wordLeft('   ', 3)).toBe(0)
  })

  it('crosses newlines like an editor does', () => {
    expect(wordLeft('one\ntwo', 7)).toBe(4)
    expect(wordLeft('one\ntwo', 4)).toBe(0)
    expect(wordRight('one\ntwo', 3)).toBe(7)
  })
})

describe('lineStart / lineEnd', () => {
  it('finds the bounds of the caret line', () => {
    expect(lineStart('ab\ncd', 4)).toBe(3)
    expect(lineStart('ab\ncd', 1)).toBe(0)
    expect(lineEnd('ab\ncd', 0)).toBe(2)
    expect(lineEnd('ab\ncd', 4)).toBe(5)
  })
})

describe('applyEditShortcut', () => {
  const state = { text: 'fix the webhook tests', cursor: 21 }

  it('ignores unmodified keys', () => {
    expect(applyEditShortcut(state, 'a', key())).toBeNull()
    expect(applyEditShortcut(state, '', key({ leftArrow: true }))).toBeNull()
  })

  it('jumps a word with option/ctrl + arrows', () => {
    expect(applyEditShortcut(state, '', key({ meta: true, leftArrow: true }))?.cursor).toBe(16)
    expect(applyEditShortcut(state, '', key({ ctrl: true, leftArrow: true }))?.cursor).toBe(16)
    expect(
      applyEditShortcut({ text: state.text, cursor: 0 }, '', key({ meta: true, rightArrow: true }))
        ?.cursor,
    ).toBe(3)
  })

  it('jumps a word with meta+b / meta+f (what iTerm sends for option+arrows)', () => {
    expect(applyEditShortcut(state, 'b', key({ meta: true }))?.cursor).toBe(16)
    expect(applyEditShortcut({ ...state, cursor: 0 }, 'f', key({ meta: true }))?.cursor).toBe(3)
  })

  it('reaches the line edges with ctrl+a / ctrl+e', () => {
    expect(applyEditShortcut(state, 'a', key({ ctrl: true }))?.cursor).toBe(0)
    expect(
      applyEditShortcut({ text: 'ab\ncd', cursor: 4 }, 'a', key({ ctrl: true }))?.cursor,
    ).toBe(3)
    expect(applyEditShortcut({ text: 'ab\ncd', cursor: 0 }, 'e', key({ ctrl: true }))?.cursor).toBe(
      2,
    )
  })

  it('kills the word behind the caret with option+backspace / ctrl+w', () => {
    expect(applyEditShortcut(state, '', key({ meta: true, backspace: true }))).toEqual({
      text: 'fix the webhook ',
      cursor: 16,
    })
    expect(applyEditShortcut(state, 'w', key({ ctrl: true }))).toEqual({
      text: 'fix the webhook ',
      cursor: 16,
    })
  })

  it('kills to the line start with ctrl+u and to the line end with ctrl+k', () => {
    expect(applyEditShortcut({ text: 'ab cd', cursor: 3 }, 'u', key({ ctrl: true }))).toEqual({
      text: 'cd',
      cursor: 0,
    })
    expect(applyEditShortcut({ text: 'ab cd', cursor: 3 }, 'k', key({ ctrl: true }))).toEqual({
      text: 'ab ',
      cursor: 3,
    })
  })

  it('leaves other modified keys to the caller (ctrl+r, ctrl+s, ctrl+c)', () => {
    for (const ch of ['r', 's', 'c']) {
      expect(applyEditShortcut(state, ch, key({ ctrl: true }))).toBeNull()
    }
  })
})
