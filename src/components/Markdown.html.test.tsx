// Raw HTML in a message body must render as literal TEXT — not be silently
// dropped, and never be parsed into real DOM elements.
//
// Regression: the pipeline (utils/markdown-cache.ts) ran remark-rehype with
// default options, which discards mdast `html` nodes entirely. A user message
// whose body is a pasted DOM dump (a giant `<div …>` blob — e.g. copying a
// rendered panel out of devtools) parses as ONE html block, so the entire
// bubble rendered EMPTY. The handler that fixes this lives in
// shared/markdown-html-text.ts and is shared with the search-index pipeline
// (shared/search/extract.ts) so the index sees the same text the bubble shows;
// the extract side is pinned in src/search/__tests__/extract.test.ts.
//
// Uses the REAL pipeline through <Markdown> (no module mock), mirroring
// Markdown.breaks.test.tsx.

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Markdown } from './Markdown'

describe('Markdown raw HTML renders as text', () => {
  it('renders a block-level HTML blob as literal text instead of dropping it', () => {
    // No blank lines → CommonMark folds the whole thing into one html block.
    const html = [
      '<div class="tasks-overlay" data-state="open">',
      '<span class="tasks-panel-title">Tasks</span>',
      '</div>',
    ].join('\n')
    const { container } = render(<Markdown text={html} />)
    // The bubble is no longer empty: the source text is visible…
    const body = container.querySelector('.md')?.textContent ?? ''
    expect(body).toContain('<div class="tasks-overlay" data-state="open">')
    expect(body).toContain('Tasks</span>')
    expect(body).toContain('</div>')
    // …and nothing was parsed into real elements (the safety half).
    expect(container.querySelector('div.tasks-overlay')).toBeNull()
    expect(container.querySelector('span.tasks-panel-title')).toBeNull()
  })

  it('renders inline HTML tags as literal text instead of dropping them', () => {
    const { container } = render(<Markdown text={'call <b>bold</b> now'} />)
    const body = container.querySelector('.md')?.textContent ?? ''
    expect(body).toContain('call <b>bold</b> now')
    expect(container.querySelector('b')).toBeNull()
  })

  it('renders a pasted-DOM user message non-empty (regression)', () => {
    // The reported case: pasted panel DOM followed by typed text on the same
    // line — one html block, previously rendered as an entirely empty bubble.
    // `breaks` mirrors the user-bubble pipeline (MessageView passes it).
    const html = '<aside class="tasks-panel"><header>Tasks</header></aside> 为什么渲染不出来'
    const { container } = render(<Markdown text={html} breaks />)
    const body = container.querySelector('.md')?.textContent ?? ''
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain('<aside class="tasks-panel">')
    expect(body).toContain('为什么渲染不出来')
  })

  it('never creates live elements from hostile markup (script / event handlers)', () => {
    const html = '<script>window.__pwned = 1</script><img src=x onerror="window.__pwned=2">'
    const { container } = render(<Markdown text={html} />)
    // Inertness: no element of any kind escapes — only text nodes.
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    // The markup is readable as text.
    const body = container.querySelector('.md')?.textContent ?? ''
    expect(body).toContain('<img src=x onerror=')
  })

  it('keeps raw HTML text in the SEARCH pipeline (query marks land on it)', () => {
    // An active searchQuery routes through buildSearchProcessor — the third
    // remarkRehype call site (markdown-cache.ts). If that site ever reverts
    // to the plain idiom, the html text vanishes from the rendered tree while
    // item.plainText (extract.ts, which keeps it) still counts matches — the
    // N/M counter would desync from the visible <mark>s. This test fails on
    // exactly that revert.
    const html = '<div class="tasks-overlay">boxed text</div>'
    const { container } = render(<Markdown text={html} searchQuery="boxed text" />)
    const body = container.querySelector('.md')?.textContent ?? ''
    expect(body).toContain('<div class="tasks-overlay">')
    expect(body).toContain('boxed text')
    expect(container.querySelectorAll('mark.search-hl').length).toBeGreaterThanOrEqual(1)
  })
})
