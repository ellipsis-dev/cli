// Cursor and kill shortcuts shared by both text inputs (the chat composer and
// the new-session prompt): the readline bindings a terminal actually delivers
// — option/ctrl + ←/→ (and meta+b / meta+f, which is what iTerm sends for
// option+←/→) hop a word, ctrl+a / ctrl+e reach the line edges,
// option+backspace and ctrl+w kill a word, ctrl+u / ctrl+k kill to the line
// edges. cmd+←/→ never reaches the process (macOS terminals keep the command
// modifier for themselves), so ctrl+a / ctrl+e stand in for it.

export type TextState = { text: string; cursor: number }

// The subset of ink's key object these shortcuts read.
export interface EditKey {
  ctrl: boolean
  meta: boolean
  leftArrow: boolean
  rightArrow: boolean
  backspace: boolean
  delete: boolean
}

const WORD_CHAR = /\S/

// The start of the word at or before the cursor: skip any whitespace to the
// left, then the run of word characters (newlines count as whitespace, so a
// hop can cross a line, exactly like a text editor's).
export function wordLeft(text: string, cursor: number): number {
  let i = Math.max(0, Math.min(cursor, text.length))
  while (i > 0 && !WORD_CHAR.test(text[i - 1])) i--
  while (i > 0 && WORD_CHAR.test(text[i - 1])) i--
  return i
}

// The end of the word at or after the cursor (mirror of wordLeft).
export function wordRight(text: string, cursor: number): number {
  let i = Math.max(0, Math.min(cursor, text.length))
  while (i < text.length && !WORD_CHAR.test(text[i])) i++
  while (i < text.length && WORD_CHAR.test(text[i])) i++
  return i
}

export function lineStart(text: string, cursor: number): number {
  return cursor > 0 ? text.lastIndexOf('\n', cursor - 1) + 1 : 0
}

export function lineEnd(text: string, cursor: number): number {
  const next = text.indexOf('\n', cursor)
  return next < 0 ? text.length : next
}

// The input state after an editing shortcut, or null when the keypress isn't
// one — the signal for the caller to keep walking its own key handling.
export function applyEditShortcut(
  state: TextState,
  ch: string,
  key: EditKey,
): TextState | null {
  if (!key.ctrl && !key.meta) return null
  const { text, cursor } = state
  if (key.leftArrow || (key.meta && (ch === 'b' || ch === 'B'))) {
    return { text, cursor: wordLeft(text, cursor) }
  }
  if (key.rightArrow || (key.meta && (ch === 'f' || ch === 'F'))) {
    return { text, cursor: wordRight(text, cursor) }
  }
  if (key.ctrl && ch === 'a') return { text, cursor: lineStart(text, cursor) }
  if (key.ctrl && ch === 'e') return { text, cursor: lineEnd(text, cursor) }
  if ((key.meta && (key.backspace || key.delete)) || (key.ctrl && ch === 'w')) {
    const at = wordLeft(text, cursor)
    return { text: text.slice(0, at) + text.slice(cursor), cursor: at }
  }
  if (key.ctrl && ch === 'u') {
    const at = lineStart(text, cursor)
    return { text: text.slice(0, at) + text.slice(cursor), cursor: at }
  }
  if (key.ctrl && ch === 'k') {
    const at = lineEnd(text, cursor)
    return { text: text.slice(0, cursor) + text.slice(at), cursor }
  }
  return null
}
