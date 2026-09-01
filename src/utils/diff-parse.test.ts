import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from './diff-parse'

/** Build a diff string from explicit line contents. Each entry is emitted
 *  verbatim, so leading `+`/`-`/` ` markers are written exactly as they
 *  appear in real `git diff` output. */
function diff(...lines: string[]): string {
  return lines.join('\n')
}

describe('parseUnifiedDiff', () => {
  it('classifies file headers and hunk headers as meta/hunk without line numbers', () => {
    const rows = parseUnifiedDiff(
      diff('--- a/foo.ts', '+++ b/foo.ts', '@@ -10,3 +10,4 @@ function foo() {'),
    )
    expect(rows.map((r) => r.type)).toEqual(['meta', 'meta', 'hunk'])
    expect(rows.map((r) => r.newLine)).toEqual([null, null, null])
    expect(rows.map((r) => r.oldLine)).toEqual([null, null, null])
  })

  it('assigns new-file line numbers to context and added lines', () => {
    const rows = parseUnifiedDiff(
      diff(
        '@@ -10,0 +10,3 @@',
        ' const a = 1;',
        '+const b = 2;',
        ' const c = 3;',
      ),
    )
    expect(rows[1]).toMatchObject({ type: 'ctx', newLine: 10, oldLine: 10, content: 'const a = 1;' })
    expect(rows[2]).toMatchObject({ type: 'add', newLine: 11, oldLine: null, content: 'const b = 2;' })
    expect(rows[3]).toMatchObject({ type: 'ctx', newLine: 12, oldLine: 11, content: 'const c = 3;' })
  })

  it('assigns old-file line numbers to deleted lines and advances both counters on context', () => {
    const rows = parseUnifiedDiff(
      diff(
        '@@ -20,3 +20,2 @@',
        ' const x = 1;',
        '-const gone = true;',
        ' const y = 2;',
      ),
    )
    expect(rows[1]).toMatchObject({ type: 'ctx', oldLine: 20, newLine: 20 })
    expect(rows[2]).toMatchObject({ type: 'del', oldLine: 21, newLine: null, content: 'const gone = true;' })
    expect(rows[3]).toMatchObject({ type: 'ctx', oldLine: 22, newLine: 21 })
  })

  it('strips the leading marker from add/del/context content but keeps it for meta/hunk', () => {
    const rows = parseUnifiedDiff(diff('+added', '-deleted', ' ctx'))
    expect(rows[0].content).toBe('added')
    expect(rows[1].content).toBe('deleted')
    expect(rows[2].content).toBe('ctx')
  })

  it('treats a trailing empty line from the final newline as noise', () => {
    const rows = parseUnifiedDiff('@@ -1 +1 @@\n ctx\n')
    expect(rows).toHaveLength(2)
    expect(rows[1].type).toBe('ctx')
  })

  it('marks "\\ No newline at end of file" as nonewline without advancing counters', () => {
    const rows = parseUnifiedDiff(
      diff('@@ -1 +1 @@', '+added', '\\ No newline at end of file', ' ctx'),
    )
    expect(rows[1]).toMatchObject({ type: 'add', newLine: 1 })
    expect(rows[2]).toMatchObject({ type: 'nonewline', newLine: null, oldLine: null })
    expect(rows[3]).toMatchObject({ type: 'ctx', newLine: 2, oldLine: 1 })
  })

  it('treats rename/mode/diff headers as meta', () => {
    const rows = parseUnifiedDiff(
      diff('diff --git a/x b/y', 'index 123..456 100644', 'rename from x', 'rename to y'),
    )
    expect(rows.every((r) => r.type === 'meta')).toBe(true)
  })
})
