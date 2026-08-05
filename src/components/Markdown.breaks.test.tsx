// Verifies the `breaks` prop on <Markdown>: single newlines render as <br>
// only when `breaks` is set. This is what makes Shift+Enter newlines in the
// composer survive into the rendered user-message bubble — without it,
// CommonMark collapses a soft break to a space ("回车显示为空格").
//
// Uses the REAL react-markdown pipeline (no module mock), so it exercises
// remark-gfm + remark-breaks end-to-end. Runs in jsdom (src/** .tsx).

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { Markdown } from './Markdown'
import { rehypeHighlightQuery } from '../search'

afterEach(() => cleanup())

describe('Markdown breaks prop', () => {
  it('renders a single newline as <br> when breaks is set', () => {
    const { container } = render(<Markdown text={'line one\nline two'} breaks />)
    // remark-breaks converts the soft break to a <br>; the two lines stay in
    // one paragraph (no \n\n), so there's exactly one <br> between them.
    const brs = container.querySelectorAll('br')
    expect(brs.length).toBe(1)
    expect(container.textContent).toContain('line one')
    expect(container.textContent).toContain('line two')
  })

  it('collapses a single newline (no <br>) by default', () => {
    const { container } = render(<Markdown text={'line one\nline two'} />)
    // CommonMark soft-break default: the newline becomes whitespace, not a
    // <br>. Both lines land in the same <p>; zero <br> elements.
    const brs = container.querySelectorAll('br')
    expect(brs.length).toBe(0)
    expect(container.querySelectorAll('p').length).toBe(1)
  })

  it('still splits paragraphs on double newline with breaks', () => {
    const { container } = render(<Markdown text={'para one\n\npara two'} breaks />)
    // A blank line is a paragraph boundary regardless of remark-breaks —
    // two <p>s, no <br>.
    expect(container.querySelectorAll('p').length).toBe(2)
    expect(container.querySelectorAll('br').length).toBe(0)
  })

  it('renders multiple single newlines as multiple <br> with breaks', () => {
    const { container } = render(<Markdown text={'a\nb\nc'} breaks />)
    expect(container.querySelectorAll('br').length).toBe(2)
  })

  it('does not add <br> inside fenced code blocks even with breaks', () => {
    const { container } = render(
      <Markdown text={'```\nline one\nline two\n```'} breaks />,
    )
    // remark-breaks only affects prose soft breaks, not code-block content.
    // The code block renders inside <pre><code>; its newlines are preserved
    // as text, never as <br>.
    const code = container.querySelector('pre code')
    expect(code).not.toBeNull()
    expect(code?.querySelectorAll('br').length).toBe(0)
    expect(code?.textContent).toContain('line one\nline two')
  })

  // ── Search alignment under `breaks` ─────────────────────────────────
  // The canonical searchable text MUST be identical with/without breaks,
  // otherwise ingest-time indexing (no-breaks pipeline in extract.ts) and
  // render-time highlighting (breaks pipeline here) drift apart and the
  // search bar's "N/M" counter desyncs from the visible <mark>s.
  // remark-breaks removes the \n from the text node and emits a <br>; the
  // hast walker treats <br> as a block tag emitting one \n separator — so
  // the flattened text is byte-identical to the no-breaks case where the
  // \n stays in the text node. These tests pin that invariant.
  it('search: a phrase split by a soft newline still highlights with breaks', () => {
    // "foo\nbar" — with breaks the text node splits around a <br>, but the
    // walker rejoins them as "foo\nbar", so a query for the literal phrase
    // (with \n) hits the phrase. The match may be split across two adjacent
    // <mark>s (one per text node on either side of the <br>), so we assert
    // on concatenated characters, not on a single element — mirroring the
    // alignment test's markedCharCount approach.
    const { container } = render(
      <Markdown text={'foo\nbar'} breaks searchQuery={'foo\nbar'} />,
    )
    const marks = container.querySelectorAll('mark.search-hl')
    expect(marks.length).toBeGreaterThanOrEqual(1)
    const markedChars = Array.from(marks).map((m) => m.textContent).join('')
    expect(markedChars).toBe('foobar') // \n lives on the <br>, not under <mark>
  })

  it('search: highlight count is the same with and without breaks', () => {
    // The alignment invariant: a query that hits N times on the no-breaks
    // canonical text must hit the same N times on the breaks canonical text.
    // remark-breaks moves the soft-break \n out of the text node and onto a
    // <br>; the search walker treats <br> as a block tag emitting one \n, so
    // the flattened text is byte-identical either way. We count <mark>s on
    // both pipelines for the same source + query (the rehype-strip plugin
    // isn't needed here because it only deletes nodes the walker already
    // skips — it can't change the count).
    const md = 'foo bar\nfoo baz\nfoo'
    const q = 'foo'
    const attacher = () => rehypeHighlightQuery(q)

    const { container: noBreaks } = render(
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[attacher]}>
        {md}
      </ReactMarkdown>,
    )
    const { container: withBreaks } = render(
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[attacher]}>
        {md}
      </ReactMarkdown>,
    )
    const nNoBreaks = noBreaks.querySelectorAll('mark.search-hl').length
    const nWithBreaks = withBreaks.querySelectorAll('mark.search-hl').length
    expect(nWithBreaks).toBe(nNoBreaks)
    expect(nNoBreaks).toBe(3) // three "foo" occurrences
  })
})

// ── No extra blank lines (rehype-strip-structural-whitespace) ───────
// `.md` prose uses `white-space: pre-wrap` (so tabs/indentation render).
// pre-wrap renders EVERY \n, so the structural-whitespace text nodes
// remark-rehype leaves between blocks — and the \n remark-breaks leaves
// after each <br> — would show as extra blank lines. A rehype plugin
// strips them. These tests pin that the stripped tree has no stray
// whitespace-only text nodes around <br> or between block siblings.
describe('Markdown no extra blank lines', () => {
  it('leaves no \\n text node after a <br> (breaks soft-break residue)', () => {
    // render() serializes to DOM; a stray "\n" between <br> and the next
    // text would appear as a text node containing exactly "\n". We assert
    // no child of the <p> is a bare-newline text node.
    const { container } = render(<Markdown text={'line one\nline two'} breaks />)
    const p = container.querySelector('p')!
    const stray = Array.from(p.childNodes).filter(
      (n) => n.nodeType === 3 /* TEXT */ && (n.textContent ?? '') === '\n',
    )
    expect(stray.length).toBe(0)
    // <br> still present (one soft break → one <br>).
    expect(p.querySelectorAll('br').length).toBe(1)
  })

  it('leaves no whitespace-only text node between paragraph siblings', () => {
    // Two paragraphs: remark-rehype inserts a "\n" text node between them.
    // Under pre-wrap that \n would render as a blank line. Strip removes it.
    const { container } = render(<Markdown text={'para one\n\npara two'} />)
    const md = container.querySelector('.md')!
    const stray = Array.from(md.childNodes).filter(
      (n) => n.nodeType === 3 /* TEXT */ && /^\s*$/.test(n.textContent ?? '') && (n.textContent ?? '').includes('\n'),
    )
    expect(stray.length).toBe(0)
    expect(md.querySelectorAll('p').length).toBe(2)
  })

  it('preserves newlines inside fenced code blocks', () => {
    // Strip skips <pre> subtrees — code-block newlines are content.
    const { container } = render(<Markdown text={'```\nline one\nline two\n```'} />)
    const code = container.querySelector('pre code')!
    expect(code.textContent).toContain('line one\nline two')
  })

  it('preserves a meaningful inline space between two links', () => {
    // A whitespace-only text node with NO newline is meaningful (the space
    // between "[a](u) [b](u)"). Strip must NOT remove it.
    const { container } = render(<Markdown text={'[a](https://x.com) [b](https://y.com)'} />)
    const links = container.querySelectorAll('a')
    expect(links.length).toBe(2)
    // The text between the two links is a single space, not collapsed away.
    expect(container.querySelector('.md')?.textContent).toContain('a b')
  })
})
