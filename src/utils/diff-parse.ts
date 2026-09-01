// Pure parser for unified-diff text. Turns a `git diff` string into typed
// rows with per-row old/new line numbers so the client can render a
// line-number gutter without a server round-trip. The hunk header
// (`@@ -a,b +c,d @@`) is the only source of line-number state — every
// `+`/` ` line advances the new-file counter, every `-`/` ` line advances
// the old-file counter, exactly as unified diff defines.

export type DiffLineType = 'meta' | 'hunk' | 'add' | 'del' | 'ctx' | 'nonewline'

export interface DiffLine {
  type: DiffLineType
  /** Line content with the leading `+`/`-`/` ` marker stripped for
   *  add/del/ctx rows; full text for meta/hunk/nonewline rows. */
  content: string
  /** 1-based line number in the new file, or null when not applicable. */
  newLine: number | null
  /** 1-based line number in the old file, or null when not applicable. */
  oldLine: number | null
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseUnifiedDiff(text: string): DiffLine[] {
  const raw = text.split('\n')
  // The final `\n` produces a trailing '' that isn't a diff line.
  const lines = raw.length > 0 && raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw

  let oldLine = 0
  let newLine = 0
  const rows: DiffLine[] = []

  for (const line of lines) {
    let type: DiffLineType
    let oldLineForRow: number | null = null
    let newLineForRow: number | null = null
    let content = line

    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line)
      if (m) {
        oldLine = Number(m[1])
        newLine = Number(m[3])
      }
      type = 'hunk'
    } else if (line.startsWith('+++') || line.startsWith('---')) {
      type = 'meta'
    } else if (line.startsWith('+')) {
      type = 'add'
      newLineForRow = newLine++
      content = line.slice(1)
    } else if (line.startsWith('-')) {
      type = 'del'
      oldLineForRow = oldLine++
      content = line.slice(1)
    } else if (line.startsWith('\\')) {
      type = 'nonewline'
    } else if (line.startsWith(' ')) {
      type = 'ctx'
      oldLineForRow = oldLine++
      newLineForRow = newLine++
      content = line.slice(1)
    } else {
      // diff --git / index / mode / rename / similarity / binary, etc.
      type = 'meta'
    }

    rows.push({ type, content, oldLine: oldLineForRow, newLine: newLineForRow })
  }

  return rows
}
