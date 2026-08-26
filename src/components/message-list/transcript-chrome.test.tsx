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
    // attaches to (os-native-hidden) — this is the contract that replaces the
    // native scrollbar with the project's self-built overlay thumb.
    expect(scroller!.classList.contains('os-native-hidden')).toBe(true)
    // And it appends an overlay track as a sibling of the scroller inside the
    // bubble (.streaming-msg), which floats the thumb over the bubble.
    const bubble = container.querySelector('.streaming-msg')
    expect(bubble?.querySelector('.os-track')).toBeTruthy()
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
