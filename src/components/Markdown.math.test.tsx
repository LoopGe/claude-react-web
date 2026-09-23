// Verifies math formula rendering on <Markdown>: `$…$` inline and `$$…$$`
// display LaTeX render through the compileMarkdown pipeline (remark-math +
// rehype-katex). Chat UIs like Claude.ai/ChatGPT render both; before this,
// LaTeX arrived as literal `$x^2$` text.
//
// Uses the REAL compileMarkdown pipeline (no module mock) — same approach as
// Markdown.breaks.test.tsx. Runs in jsdom (src/** .tsx).

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Markdown } from './Markdown'
import { clearMarkdownCache, markdownCacheSize } from '../utils/markdown-cache'

describe('Markdown math rendering', () => {
  it('renders inline $...$ as a katex span (dollars consumed)', () => {
    const { container } = render(<Markdown text={'inline $x^2$ math'} />)
    const katex = container.querySelector('.katex')
    expect(katex).not.toBeNull()
    // KaTeX renders the glyphs; the delimiters are gone.
    expect(container.textContent).toContain('x')
    expect(container.textContent).toContain('2')
    expect(container.textContent).not.toContain('$x^2$')
  })

  it('renders $$...$$ display math as a katex-display block', () => {
    const { container } = render(<Markdown text={'$$\nE=mc^2\n$$'} />)
    const display = container.querySelector('.katex-display')
    expect(display).not.toBeNull()
    expect(display!.querySelector('.katex')).not.toBeNull()
    expect(container.textContent).toContain('E=mc')
  })

  it('renders multi-line display math with breaks enabled (no <br> inside)', () => {
    // Regression tripwire: remark-breaks converts \n in every mdast text node
    // to a <br> — but math content lives in node.value (not text children),
    // so block math must survive the breaks variant untouched. If a future
    // change ever routes math content through text children, this catches it.
    const md = '$$\n\\int_0^1 f(x)\\,dx\n$$'
    const { container } = render(<Markdown text={md} breaks />)
    const display = container.querySelector('.katex-display')
    expect(display).not.toBeNull()
    expect(display!.querySelectorAll('br').length).toBe(0)
  })

  it('search path: query marks and katex render coexist', () => {
    // The search path builds a throwaway processor; math must render there
    // too. rehype-katex runs AFTER the search marker so marks land on raw
    // LaTeX and are then replaced wholesale — prose marks survive.
    const { container } = render(
      <Markdown text={'$$a+b$$ and more prose'} searchQuery="more" />,
    )
    expect(container.querySelector('.katex')).not.toBeNull()
    const marks = container.querySelectorAll('mark.search-hl')
    expect(marks.length).toBeGreaterThanOrEqual(1)
    expect(Array.from(marks).map((m) => m.textContent).join('')).toBe('more')
  })

  it('does not math-parse backticked code or a single unpaired $', () => {
    // False-positive guards: code spans are never math, and an unpaired $
    // (needs a closing $ in the same paragraph) stays literal.
    const { container } = render(
      <Markdown text={'use `$env:NAME` to set vars; costs $5 only'} />,
    )
    expect(container.querySelector('.katex')).toBeNull()
    const code = container.querySelector('code')
    expect(code?.textContent).toContain('env:NAME')
    expect(container.textContent).toContain('$5 only')
  })

  it('PAIRED bare $ in prose IS parsed as math — a documented, accepted false-positive', () => {
    // Known trade-off, deliberately accepted: singleDollarTextMath stays on
    // (matches Claude.ai/ChatGPT) so Claude's inline `$x^2$` renders, which
    // means two bare $ in one paragraph ("costs $5 and $10 total") parse as
    // a math span. The decision was to ship the default and add a boundary
    // heuristic later only if real transcripts show it bites (per the
    // repo's debug-with-logs rule — measure first, then fix). This test
    // pins the current behavior so the trade-off is visible in the suite;
    // if a heuristic ever lands, THIS is the test to update.
    const { container } = render(<Markdown text={'costs $5 and $10 total'} />)
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.textContent).toContain('costs')
    expect(container.textContent).toContain('10 total')
  })

  it('malformed LaTeX degrades gracefully (error span or fallback, never a crash)', () => {
    // rehype-katex must not throw out of compileMarkdown: either katex's
    // error rendering or the Markdown ErrorBoundary fallback shows — the
    // transcript never blanks.
    const { container } = render(<Markdown text={'bad $\\notacommand$ math'} />)
    const md = container.querySelector('.md')
    expect(md).not.toBeNull()
    expect(container.textContent!.length).toBeGreaterThan(0)
  })

  it('compiled math trees are cached (no growth on identical recompile)', () => {
    clearMarkdownCache()
    const before = markdownCacheSize()
    const md = '$$a^2+b^2=c^2$$'
    const first = render(<Markdown text={md} />)
    const afterFirst = markdownCacheSize()
    first.unmount()
    const second = render(<Markdown text={md} />)
    second.unmount()
    expect(afterFirst).toBe(before + 1)
    expect(markdownCacheSize()).toBe(afterFirst) // hit — no new entry
  })
})
