import { act, render } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAutoHeightTransition } from './useAutoHeightTransition'

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Minimal consumer: the hook needs a ref to a real element. */
function Harness({ onReady }: { onReady: (captureHeight: () => void, el: HTMLElement) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const { captureHeight } = useAutoHeightTransition(ref, 'key')
  useEffect(() => {
    if (ref.current) onReady(captureHeight, ref.current)
  }, [captureHeight, onReady])
  return <div data-testid="target" ref={ref} />
}

it('captures the used height, not a rect scaled by an ancestor transform', () => {
  // captureHeight pins the element's current height as a tween's start point,
  // and its callers (a settings panel body, a folder picker list) live inside
  // `.chat-panel`, which enters with `scale(0.98)` (layout.css). A rect read
  // there is 2% short, so the tween starts smaller than the box it is animating
  // and jumps on the first frame. Same hazard the fold components document.
  let capture: (() => void) | null = null
  let el: HTMLElement | null = null
  render(
    <Harness
      onReady={(c, e) => {
        capture = c
        el = e
      }}
    />,
  )
  expect(capture).not.toBeNull()
  // A 100px box under scale(0.98): the rect reads 98, the used height is 100.
  vi.spyOn(el!, 'offsetHeight', 'get').mockReturnValue(100)
  vi.spyOn(el!, 'getBoundingClientRect').mockReturnValue({ height: 98 } as DOMRect)

  act(() => capture!())

  expect(el!.style.height).toBe('100px')
})