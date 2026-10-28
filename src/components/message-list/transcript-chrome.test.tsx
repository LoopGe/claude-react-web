import { describe, it, expect, vi } from 'vitest'
import { memo, type ComponentType } from 'react'
import { render, fireEvent } from '@testing-library/react'
import { StreamingFooter, OlderHistoryFloat } from './transcript-chrome'

// Render counter on the REAL Markdown (same memo compare), for the
// incremental-render pin below. The mock only wraps — behavior stays real.
const mdRenders = vi.hoisted(() => ({ n: 0 }))
vi.mock('../Markdown', async (orig) => {
  const mod = await orig<typeof import('../Markdown')>()
  type MemoLike = { type: (p: unknown) => unknown; compare?: ((a: unknown, b: unknown) => boolean) | null }
  const m = mod.Markdown as unknown as MemoLike
  const inner = m.type
  const Wrapped = function CountedMarkdown(props: unknown) {
    mdRenders.n++
    return inner(props) as never
  }
  return {
    ...mod,
    Markdown: memo(Wrapped as ComponentType<object>, m.compare ?? undefined),
  }
})

describe('StreamingFooter', () => {
  it('attaches the project overlay scrollbar to the capped streaming bubble (hides the native one)', () => {
    // Content well past the 3lh cap so the bubble's .streaming-plain scrolls.
    const longContent = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')
    const { container } = render(<StreamingFooter content={longContent} />)

    const scroller = container.querySelector('.streaming-plain') as HTMLElement | null
    expect(scroller).toBeTruthy()
    // The overlay scrollbar hides the native scrollbar on the scroller it
    // attaches to (data-os-native-hidden) — this is the contract that replaces
    // the native scrollbar with the project's self-built overlay thumb.
    expect(scroller!.hasAttribute('data-os-native-hidden')).toBe(true)
    // And it appends an overlay track as a sibling of the scroller inside the
    // bubble (.streaming-msg), which floats the thumb over the bubble.
    const bubble = container.querySelector('.streaming-msg')
    expect(bubble?.querySelector('.os-track')).toBeTruthy()
  })

  it('renders the live turn as markdown: blank-line runs become paragraph blocks', () => {
    // The card-era preview: structural whitespace is markdown's, not literal
    // empty rows (the old plain-text newline fold is gone with the plain-text
    // rendering). Blank-line runs split prose into blocks, so the preview
    // converges on the settled message's look.
    const { container } = render(
      <StreamingFooter content={'para one\n\n\npara two\n\npara three'} />,
    )
    const paras = [...container.querySelectorAll('.md p')].map((p) => p.textContent)
    expect(paras).toEqual(['para one', 'para two', 'para three'])
  })

  it('renders headings, emphasis and loose lists live — one list, no numbering restart', () => {
    const { container } = render(
      <StreamingFooter content={'# Title\n\nSome **bold** text\n\n- item one\n\n- item two'} />,
    )
    // `#` maps to <h3> — the a11y heading remap in markdown-components (the
    // shell reserves h1/h2), same as every settled card. Parity is the point.
    expect(container.querySelector('.md h3')?.textContent).toBe('Title')
    expect(container.querySelector('.md strong')?.textContent).toBe('bold')
    // The blank line between the items must NOT split the list into two —
    // per-block rendering would restart it. One <ul>, two <li>.
    expect(container.querySelectorAll('.md ul')).toHaveLength(1)
    expect(container.querySelectorAll('.md ul li')).toHaveLength(2)
  })

  it('shows a half-written formula as literal source until the closing delimiter arrives', () => {
    const open = render(<StreamingFooter content={'value $\\frac{1}{2'} />)
    expect(open.container.querySelector('.katex')).toBeNull()
    expect(open.container.querySelector('.streaming-plain')?.textContent).toContain('$\\frac{1}{2')

    const closed = render(<StreamingFooter content={'value $\\frac{1}{2}$'} />)
    expect(closed.container.querySelector('.katex')).toBeTruthy()
  })

  it('inline variant: markdown blocks + cursor, no glass, no scrollbar chrome, no cap class', () => {
    const { container } = render(
      <StreamingFooter content={'para one\n\n\npara two'} variant="inline" />,
    )
    const wrapper = container.querySelector('.streaming-footer-wrapper')
    expect(wrapper?.classList.contains('streaming-footer-wrapper--inline')).toBe(true)
    const bubble = container.querySelector('.streaming-msg')
    expect(bubble?.classList.contains('streaming-msg--inline')).toBe(true)
    // In-flow row has nothing behind it to refract — glass chrome must be off.
    expect(bubble?.classList.contains('liquid-glass')).toBe(false)
    expect(container.querySelector('.liquid-glass-defs')).toBeNull()
    expect(container.querySelector('.streaming-refraction')).toBeNull()
    // Shared body semantics survive: markdown blocks + the tail cursor
    // marker (the blinking bar itself is the tail leaf's ::after — a
    // sibling span would drop onto its own line below the block).
    const body = container.querySelector('.streaming-plain')
    expect([...body!.querySelectorAll('.md p')].map((p) => p.textContent)).toEqual(['para one', 'para two'])
    expect(body?.querySelector('.streaming-tail')).toBeTruthy()
    // The uncapped body is NOT a scroll container: no overlay-scrollbar
    // attachment (that chrome exists for the capped overlay bubble only).
    expect(body?.hasAttribute('data-os-native-hidden')).toBe(false)
    expect(bubble?.querySelector('.os-track')).toBeNull()
  })

  it('overlay variant (explicit): keeps glass-capable bubble and scrollbar chrome', () => {
    // Pins the default: passing variant="overlay" explicitly must behave
    // exactly like the no-prop renders the earlier tests assert.
    const longContent = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')
    const { container } = render(<StreamingFooter content={longContent} variant="overlay" />)
    const scroller = container.querySelector('.streaming-plain') as HTMLElement
    expect(scroller.hasAttribute('data-os-native-hidden')).toBe(true)
    expect(container.querySelector('.streaming-msg')?.classList.contains('streaming-msg--inline')).toBe(false)
  })

  it('renders a fenced code block live alongside prose', () => {
    const { container } = render(
      <StreamingFooter content={'explain\n```js\nconst x = 1\n```\ndone'} />,
    )
    const scroller = container.querySelector('.streaming-plain')
    expect(scroller?.textContent).toContain('explain')
    expect(scroller?.textContent).toContain('done')
    expect(container.querySelector('.code-block-lang')?.textContent).toBe('js')
    // The fence is closed → content is stable → the copy button is available.
    expect(container.querySelector('.code-block-copy')).toBeTruthy()
    // The code block must sit under a .md root — .md pre carries the block
    // chrome (background/border/padding) the settled card's code has; a bare
    // <pre> would jump styling at settle.
    expect(container.querySelector('.md .code-block')).toBeTruthy()
    expect(container.querySelector('.md pre')).toBeTruthy()
  })

  it('renders an open streaming code block without a copy button', () => {
    const { container } = render(<StreamingFooter content={'```js\nconst x = 1'} />)
    expect(container.querySelector('.code-block')).toBeTruthy()
    expect(container.querySelector('.code-block-copy')).toBeFalsy()
    // The cursor lives inside the still-growing code block.
    expect(container.querySelector('.code-block .streaming-cursor')).toBeTruthy()
  })

  it('re-renders only the tail block per flush — closed blocks stay frozen', () => {
    // The incremental-render contract the streaming card's perf rests on:
    // blocks are memoized on their (byte-stable, freeze-invariant) text, so a
    // flush that only grows the tail must compile ONE block, not the turn.
    // Two mutations bite here: collapsing back to whole-string rendering
    // (block count drops) or losing the memo (every block re-renders).
    const base = 'para one\n\npara two\n\npara three'
    const { container, rerender } = render(<StreamingFooter content={base} />)
    expect(container.querySelectorAll('.md')).toHaveLength(3)
    mdRenders.n = 0
    rerender(<StreamingFooter content={base + ' more'} />)
    expect(container.querySelectorAll('.md')).toHaveLength(3)
    expect(mdRenders.n).toBe(1)
  })
})

describe('OlderHistoryFloat', () => {
  it('stays hidden (no is-visible, no content) when idle', () => {
    const { container } = render(
      <OlderHistoryFloat loading={false} error={null} onRetry={() => {}} />,
    )
    const wrap = container.querySelector('.chat-older-float')
    expect(wrap).toBeTruthy()
    // Always mounted (stable aria-live region, CSS transition both ways) —
    // but visually hidden until a page is loading or a page failed.
    expect(wrap!.classList.contains('is-visible')).toBe(false)
    expect(wrap!.textContent).not.toContain('Loading earlier messages')
  })

  it('shows the loading pill while a page is in flight', () => {
    const { container } = render(
      <OlderHistoryFloat loading error={null} onRetry={() => {}} />,
    )
    const wrap = container.querySelector('.chat-older-float')!
    expect(wrap.classList.contains('is-visible')).toBe(true)
    expect(wrap.textContent).toContain('Loading earlier messages')
    // No retry affordance while the request is still running.
    expect(wrap.querySelector('.chat-older-float-retry')).toBeNull()
  })

  it('shows the failure pill with a retry action and invokes onRetry on click', () => {
    const onRetry = vi.fn()
    const { container } = render(
      <OlderHistoryFloat loading={false} error="Couldn't load earlier messages" onRetry={onRetry} />,
    )
    const wrap = container.querySelector('.chat-older-float')!
    expect(wrap.classList.contains('is-visible')).toBe(true)
    expect(wrap.textContent).toContain("Couldn't load earlier messages")
    const retry = wrap.querySelector('.chat-older-float-retry') as HTMLButtonElement | null
    expect(retry).toBeTruthy()
    fireEvent.click(retry!)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('loading takes precedence over a stale error (retry in flight → pill, no retry button)', () => {
    const { container } = render(
      <OlderHistoryFloat loading error="Couldn't load earlier messages" onRetry={() => {}} />,
    )
    const wrap = container.querySelector('.chat-older-float')!
    expect(wrap.textContent).toContain('Loading earlier messages')
    expect(wrap.textContent).not.toContain("Couldn't load earlier messages")
    expect(wrap.querySelector('.chat-older-float-retry')).toBeNull()
  })
})
