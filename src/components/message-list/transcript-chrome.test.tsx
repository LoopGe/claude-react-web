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
})
