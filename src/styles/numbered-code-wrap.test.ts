// @vitest-environment node
// CSS half of the numbered-view wrap contract (the JS half — toggle state,
// aria-pressed, scroll re-centering — lives in NumberedCode.test.tsx). Wrap
// flips white-space on the pre WITHOUT touching the gutter: the line numbers
// are a CSS counter on the absolutely-positioned .code-line::before, so a
// wrapped line's number stays on its first visual row. These assertions make
// that coupling loud — a wrap rule that switched to per-line numbers, or a
// gutter refactor that dropped the counter, fails here instead of silently
// misaligning every wrapped line.
import { describe, expect, it } from 'vitest'
import { parseBlocks, readCss } from './contrast-test-utils'

describe('numbered-code wrap (CSS side)', () => {
  it('.numbered-code-wrap wraps long lines and breaks unbreakable tokens', () => {
    const block = parseBlocks(readCss('file-viewer.css')).find((b) => b.sel === '.numbered-code-wrap')
    expect(block, '.numbered-code-wrap missing from file-viewer.css').toBeTruthy()
    expect(block!.decls['white-space']).toBe('pre-wrap')
    expect(block!.decls['overflow-wrap']).toBe('anywhere')
  })

  it('keeps the gutter counter intact under wrap (numbers stay CSS-only)', () => {
    const blocks = parseBlocks(readCss('file-viewer.css'))
    // The counter-reset scope rides .numbered-code, which the pre keeps even
    // when .numbered-code-wrap is added — so wrap never resets/drops the count.
    const numbered = blocks.find((b) => b.sel === '.numbered-code')
    expect(numbered, '.numbered-code missing').toBeTruthy()
    expect(numbered!.decls['counter-reset']).toBe('code-line 0')
    // Each line increments the counter and renders it via ::before content —
    // never via DOM text (copy stays clean).
    const before = blocks.find((b) => b.sel === '.code-line::before')
    expect(before, '.code-line::before missing').toBeTruthy()
    expect(before!.decls['counter-increment']).toBe('code-line')
    expect(before!.decls.content).toBe('counter(code-line)')
    // The number is absolutely positioned, so a taller (wrapped) line keeps it
    // on the first visual row rather than re-flowing it with the text.
    expect(before!.decls.position).toBe('absolute')
  })
})