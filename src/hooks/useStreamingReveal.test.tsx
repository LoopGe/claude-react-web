import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrictMode, useRef } from 'react'
import { render } from '@testing-library/react'
import type { StreamSegment } from '../utils/stream-segments'
import {
  computeStreamingReveal,
  isRevealableTail,
  lastGlyphSpan,
  lineBoxTop,
  useStreamingReveal,
  type StreamingRevealPoint,
} from './useStreamingReveal'

/** Fixed container geometry: the reveal window is expressed in the masked
 *  element's own coordinate space (mask coordinates are border-box relative). */
const BOX = { left: 100, top: 50, width: 400, height: 200 }

function measure(right: number, textLength: number, top = 60, height = 20) {
  return {
    caret: { right, top, height },
    box: BOX,
    textLength,
  }
}

const prev = (x: number, y: number, textLength: number): StreamingRevealPoint => ({
  x,
  y,
  textLength,
})

function rect(over: Partial<DOMRect>): DOMRect {
  return {
    left: 0, top: 0, width: 0, height: 0,
    right: 0, bottom: 0, x: 0, y: 0,
    toJSON: () => ({}),
    ...over,
  } as DOMRect
}

/** happy-dom has no layout: install deterministic rects for the masked box
 *  and for the Range that measures the caret. Returns a restore function. */
function installLayout(caretRight: () => number, caretTop = 0) {
  const originalBox = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')
  const originalRange = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value: () => rect({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200 }),
  })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value: () => {
      const right = caretRight()
      return rect({ left: right - 10, right, top: caretTop, height: 20, width: 10, bottom: caretTop + 20 })
    },
  })
  return {
    restore: () => {
      if (originalBox) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', originalBox)
      else delete (HTMLElement.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect
      if (originalRange) Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalRange)
      else delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect
    },
  }
}

interface FakeAnimation {
  cancel: ReturnType<typeof vi.fn>
  onfinish: (() => void) | null
  frames: Keyframe[]
  options: KeyframeAnimationOptions
}

/** Replace WAAPI with a deterministic recorder. Returns the recorded list. */
function installAnimate() {
  const original = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
  const animations: FakeAnimation[] = []
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: (frames: Keyframe[], options: KeyframeAnimationOptions) => {
      const animation: FakeAnimation = { cancel: vi.fn(), onfinish: null, frames, options }
      animations.push(animation)
      return animation as unknown as Animation
    },
  })
  return {
    animations,
    restore: () => {
      if (original) Object.defineProperty(Element.prototype, 'animate', original)
      else delete (Element.prototype as { animate?: unknown }).animate
    },
  }
}

function keyframes(animation: FakeAnimation) {
  return {
    from: String((animation.frames[0] as Record<string, unknown>).maskSize),
    to: String((animation.frames[1] as Record<string, unknown>).maskSize),
  }
}

describe('computeStreamingReveal', () => {
  it('sweeps the first chunk from the line start to the caret', () => {
    // caret.right 180 - box.left 100 = 80; caret.top 60 - box.top 50 = 10.
    expect(computeStreamingReveal(null, measure(180, 5))).toEqual({
      fromW: 0,
      toW: 80,
      lineTop: 10,
    })
  })

  it('sweeps a same-line append from the previous caret to the new one', () => {
    expect(computeStreamingReveal(prev(80, 10, 5), measure(200, 9))).toEqual({
      fromW: 80,
      toW: 100,
      lineTop: 10,
    })
  })

  it('restarts from the line start when the append wrapped to a new line', () => {
    expect(computeStreamingReveal(prev(380, 10, 12), measure(140, 15, 90))).toEqual({
      fromW: 0,
      toW: 40,
      lineTop: 40,
    })
  })

  it('treats sub-half-line font-metric jitter as the same line', () => {
    expect(computeStreamingReveal(prev(80, 10, 5), measure(200, 9, 61))).toEqual({
      fromW: 80,
      toW: 100,
      lineTop: 11,
    })
  })

  it('returns null when the text did not grow', () => {
    expect(computeStreamingReveal(prev(80, 10, 5), measure(200, 5))).toBeNull()
  })

  it('returns null when the text shrank (supersede / reset)', () => {
    expect(computeStreamingReveal(prev(80, 10, 9), measure(200, 4))).toBeNull()
  })

  it('returns null when the masked box has no measurable size', () => {
    const measureWithEmptyBox = {
      caret: { right: 180, top: 60, height: 20 },
      box: { ...BOX, width: 0 },
      textLength: 5,
    }
    expect(computeStreamingReveal(null, measureWithEmptyBox)).toBeNull()
  })

  it('returns null when the caret has no measurable rect (hidden / jsdom)', () => {
    expect(computeStreamingReveal(null, measure(180, 5, 60, 0))).toBeNull()
  })

  it('returns null when the caret is left of the box (offscreen measurement)', () => {
    expect(computeStreamingReveal(null, measure(90, 5))).toBeNull()
  })

  it('returns null when the append added no horizontal width', () => {
    expect(computeStreamingReveal(prev(80, 10, 5), measure(180, 6))).toBeNull()
  })

  it('clamps a first-line caret whose line box starts a fraction above the box', () => {
    // Half-leading can push the line box top a sub-pixel above the masked
    // element; that must still reveal instead of being rejected as offscreen.
    expect(computeStreamingReveal(null, measure(180, 5, 49.8))).toEqual({
      fromW: 0,
      toW: 80,
      lineTop: 0,
    })
  })

  it('returns null when the caret is more than a line above the box', () => {
    // A genuinely scrolled-out tail (not the half-leading epsilon).
    expect(computeStreamingReveal(null, measure(180, 5, 20))).toBeNull()
  })
})

describe('lastGlyphSpan', () => {
  it('selects the last non-whitespace character', () => {
    expect(lastGlyphSpan('abc')).toEqual({ start: 2, end: 3 })
    expect(lastGlyphSpan('ab  ')).toEqual({ start: 1, end: 2 })
  })

  it('selects a whole astral code point, not half a surrogate pair', () => {
    expect(lastGlyphSpan('done 😀')).toEqual({ start: 5, end: 7 })
    expect(lastGlyphSpan('😀')).toEqual({ start: 0, end: 2 })
  })

  it('returns null for whitespace-only / empty text', () => {
    expect(lastGlyphSpan('   ')).toBeNull()
    expect(lastGlyphSpan('')).toBeNull()
  })
})

describe('lineBoxTop', () => {
  it('lifts the boundary by half the leading so taller inline content stays below it', () => {
    expect(lineBoxTop(20, 18, 28)).toBe(15)
  })

  it('keeps the glyph top when there is no leading or line-height is unknown', () => {
    expect(lineBoxTop(20, 18, 18)).toBe(20)
    expect(lineBoxTop(20, 18, Number.NaN)).toBe(20)
  })
})

describe('isRevealableTail', () => {
  const text = (content: string): StreamSegment => ({ type: 'text', content })
  const code = (content: string): StreamSegment => ({ type: 'code', lang: 'js', content, closed: false })

  it('accepts prose and inline formatting', () => {
    expect(isRevealableTail(text('普通段落，含 **粗体** 与 `code`。'))).toBe(true)
  })

  it('accepts inline prose that merely contains $$ mid-line', () => {
    expect(isRevealableTail(text('The invoice total is $$1,200 for the batch'))).toBe(true)
  })

  it('rejects fenced code', () => {
    expect(isRevealableTail(code('const x = 1'))).toBe(false)
  })

  it('rejects block-level content that renders after the measured caret', () => {
    expect(isRevealableTail(text('看这张图 ![shot](https://x/y.png)'))).toBe(false)
    expect(isRevealableTail(text('| a | b |\n| - | - |\n| 1 | 2 |'))).toBe(false)
    expect(isRevealableTail(text('段落\n\n---\n'))).toBe(false)
    expect(isRevealableTail(text('公式\n\n$$\nx = 1\n$$'))).toBe(false)
  })

  it('rejects an empty/whitespace tail and a missing segment', () => {
    expect(isRevealableTail(text(''))).toBe(false)
    expect(isRevealableTail(text('\n\n'))).toBe(false)
    expect(isRevealableTail(null)).toBe(false)
    expect(isRevealableTail(undefined)).toBe(false)
  })
})

function Harness({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useStreamingReveal(ref, text)
  return (
    <div ref={ref} className="md" data-testid="md">
      <p>{text}</p>
    </div>
  )
}

describe('useStreamingReveal', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('animates a sweep window and restarts it on the next growth', () => {
    let right = 20
    const layout = installLayout(() => right)
    const animate = installAnimate()
    try {
      const { container, rerender } = render(<Harness text="ab" />)
      const el = container.querySelector('[data-testid="md"]') as HTMLElement

      expect(el.classList.contains('stream-reveal')).toBe(true)
      expect(el.style.getPropertyValue('--stream-reveal-to')).toBe('20px')
      expect(animate.animations).toHaveLength(1)
      expect(keyframes(animate.animations[0])).toEqual({
        from: '100% 100%, 0px 100%, 100% 100%',
        to: '100% 100%, 20px 100%, 100% 100%',
      })

      right = 40
      rerender(<Harness text="abcd" />)

      expect(animate.animations).toHaveLength(2)
      expect(animate.animations[0].cancel).toHaveBeenCalled()
      expect(keyframes(animate.animations[1])).toEqual({
        from: '100% 100%, 20px 100%, 100% 100%',
        to: '100% 100%, 40px 100%, 100% 100%',
      })
      expect(el.classList.contains('stream-reveal')).toBe(true)
    } finally {
      animate.restore()
      layout.restore()
    }
  })

  it('keeps the first sweep when StrictMode re-runs the mount effect', () => {
    const layout = installLayout(() => 20)
    const animate = installAnimate()
    try {
      const { container } = render(
        <StrictMode>
          <Harness text="ab" />
        </StrictMode>,
      )
      const el = container.querySelector('[data-testid="md"]') as HTMLElement
      expect(el.classList.contains('stream-reveal')).toBe(true)
      expect(animate.animations).toHaveLength(1)
    } finally {
      animate.restore()
      layout.restore()
    }
  })

  it('does not sweep under prefers-reduced-motion', () => {
    const layout = installLayout(() => 20)
    const animate = installAnimate()
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }))
    try {
      const { container } = render(<Harness text="ab" />)
      const el = container.querySelector('[data-testid="md"]') as HTMLElement
      expect(el.classList.contains('stream-reveal')).toBe(false)
      expect(animate.animations).toHaveLength(0)
    } finally {
      animate.restore()
      layout.restore()
    }
  })

  it('skips silently when layout is unmeasurable (happy-dom default)', () => {
    const animate = installAnimate()
    try {
      const { container } = render(<Harness text="ab" />)
      const el = container.querySelector('[data-testid="md"]') as HTMLElement
      expect(el.classList.contains('stream-reveal')).toBe(false)
      expect(animate.animations).toHaveLength(0)
    } finally {
      animate.restore()
    }
  })

  it('clears the mask when the sweep finishes', () => {
    const layout = installLayout(() => 20)
    const animate = installAnimate()
    try {
      const { container } = render(<Harness text="ab" />)
      const el = container.querySelector('[data-testid="md"]') as HTMLElement
      expect(el.classList.contains('stream-reveal')).toBe(true)

      animate.animations[0].onfinish?.()

      expect(el.classList.contains('stream-reveal')).toBe(false)
    } finally {
      animate.restore()
      layout.restore()
    }
  })

  it('keeps the in-flight sweep when growth adds no visible advance', () => {
    const layout = installLayout(() => 20)
    const animate = installAnimate()
    try {
      const { container, rerender } = render(<Harness text="ab" />)
      const el = container.querySelector('[data-testid="md"]') as HTMLElement
      expect(el.classList.contains('stream-reveal')).toBe(true)

      // Whitespace grows the string but not the caret. There is nothing new to
      // sweep, but the 240ms sweep already in flight must not be truncated.
      rerender(<Harness text="ab " />)
      expect(el.classList.contains('stream-reveal')).toBe(true)
      expect(animate.animations[0].cancel).not.toHaveBeenCalled()
    } finally {
      animate.restore()
      layout.restore()
    }
  })

  it('cancels the sweep and drops the mask on unmount', async () => {
    const layout = installLayout(() => 20)
    const animate = installAnimate()
    try {
      const { container, unmount } = render(<Harness text="ab" />)
      const el = container.querySelector('[data-testid="md"]') as HTMLElement
      expect(el.classList.contains('stream-reveal')).toBe(true)

      unmount()
      await Promise.resolve()

      expect(animate.animations[0].cancel).toHaveBeenCalled()
      expect(el.classList.contains('stream-reveal')).toBe(false)
    } finally {
      animate.restore()
      layout.restore()
    }
  })

  it('re-anchors after a rewritten draft moved the caret back', () => {
    let right = 60
    const layout = installLayout(() => right)
    const animate = installAnimate()
    try {
      const { container, rerender } = render(<Harness text="abcdef" />)
      const el = container.querySelector('[data-testid="md"]') as HTMLElement
      expect(el.style.getPropertyValue('--stream-reveal-to')).toBe('60px')

      // Rewrite to a shorter draft (supersede/reset): rejected, but the
      // measured point must move back with it.
      right = 20
      rerender(<Harness text="ab" />)
      expect(el.classList.contains('stream-reveal')).toBe(false)

      // The next growth must sweep from 20, not the stale 60.
      right = 30
      rerender(<Harness text="abc" />)
      expect(el.classList.contains('stream-reveal')).toBe(true)
      expect(keyframes(animate.animations[animate.animations.length - 1])).toEqual({
        from: '100% 100%, 20px 100%, 100% 100%',
        to: '100% 100%, 30px 100%, 100% 100%',
      })
    } finally {
      animate.restore()
      layout.restore()
    }
  })
})