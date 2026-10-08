import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { StreamingFooter } from './transcript-chrome'

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

  it('folds newline runs to a single break in the plain-text streaming preview (no blank lines)', () => {
    // The streaming bubble renders the in-progress turn as plain text under
    // white-space:pre-wrap. Markdown's structural whitespace (paragraph \n\n,
    // code-fence delimiters, list gaps) would otherwise render as literal empty
    // rows. It must be collapsed so the preview matches the settled render.
    const { container } = render(
      <StreamingFooter content={'para one\n\n\npara two\n\npara three'} />,
    )
    const scroller = container.querySelector('.streaming-plain')
    expect(scroller?.textContent).toContain('para one')
    expect(scroller?.textContent).toContain('para three')
    // A single newline (soft break) survives; no run of ≥2 newlines remains.
    expect(scroller?.textContent).toContain('para two\npara three')
    expect(scroller?.textContent).not.toMatch(/\n{2,}/)
  })

  it('inline variant: plain text + cursor, no glass, no scrollbar chrome, no cap class', () => {
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
    // Shared body semantics survive: newline fold + cursor.
    const body = container.querySelector('.streaming-plain')
    expect(body?.textContent).toContain('para one\npara two')
    expect(body?.querySelector('.streaming-cursor')).toBeTruthy()
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

  /* Temporarily disabled along with the live code-block rendering in
   * StreamingFooter (see transcript-chrome.tsx) — the streaming bubble now
   * renders the whole turn as plain text. Uncomment together with the source
   * to re-enable. */
  /* it('renders a fenced code block live and keeps prose as plain text', () => {
    const { container } = render(
      <StreamingFooter content={'explain\n```js\nconst x = 1\n```\ndone'} />,
    )
    const scroller = container.querySelector('.streaming-plain')
    expect(scroller?.textContent).toContain('explain')
    expect(scroller?.textContent).toContain('done')
    expect(container.querySelector('.code-block-lang')?.textContent).toBe('js')
    // The fence is closed → content is stable → the copy button is available.
    expect(container.querySelector('.code-block-copy')).toBeTruthy()
  })

  it('renders an open streaming code block without a copy button', () => {
    const { container } = render(<StreamingFooter content={'```js\nconst x = 1'} />)
    expect(container.querySelector('.code-block')).toBeTruthy()
    expect(container.querySelector('.code-block-copy')).toBeFalsy()
  }) */
})
