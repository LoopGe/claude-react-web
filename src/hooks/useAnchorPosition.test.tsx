import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RefObject } from 'react'
import {
  useAnchorPosition,
  type AnchorAlign,
  type AnchorSide,
} from './useAnchorPosition'

const triggers: HTMLButtonElement[] = []
const resizeCallbacks: Array<() => void> = []
const originalViewport = {
  width: window.innerWidth,
  height: window.innerHeight,
  dpr: window.devicePixelRatio,
}

class ResizeObserverMock {
  constructor(callback: () => void) {
    resizeCallbacks.push(callback)
  }
  observe() {}
  disconnect() {}
}

function makeRect(left: number, top: number, width = 80, height = 20): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

function setWindowValue(key: 'innerWidth' | 'innerHeight' | 'devicePixelRatio', value: number) {
  Object.defineProperty(window, key, { value, configurable: true })
}

beforeEach(() => {
  resizeCallbacks.length = 0
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  setWindowValue('innerWidth', 800)
  setWindowValue('innerHeight', 600)
  setWindowValue('devicePixelRatio', 1)
})

afterEach(() => {
  for (const trigger of triggers) trigger.remove()
  triggers.length = 0
  vi.unstubAllGlobals()
  setWindowValue('innerWidth', originalViewport.width)
  setWindowValue('innerHeight', originalViewport.height)
  setWindowValue('devicePixelRatio', originalViewport.dpr)
})

function Probe({
  triggerRef,
  side,
  align,
}: {
  triggerRef: RefObject<HTMLElement | null>
  side: AnchorSide
  align: AnchorAlign
}) {
  const { ref, x, y, hidden } = useAnchorPosition(triggerRef, { side, align })
  return (
    <div
      ref={ref}
      className="anchor-probe"
      style={{ left: x ?? 0, top: y ?? 0, visibility: hidden ? 'hidden' : undefined }}
    />
  )
}

function renderProbe(opts: {
  side: AnchorSide
  align: AnchorAlign
  triggerRect?: DOMRect
  triggerMissing?: boolean
  width?: number
  height?: number
}) {
  const trigger = document.createElement('button')
  document.body.appendChild(trigger)
  triggers.push(trigger)
  let liveRect = opts.triggerRect ?? makeRect(100, 200)
  trigger.getBoundingClientRect = () => liveRect

  const utils = render(
    <Probe
      triggerRef={{ current: opts.triggerMissing === true ? null : trigger }}
      side={opts.side}
      align={opts.align}
    />,
  )
  const probe = document.querySelector('.anchor-probe') as HTMLElement
  Object.defineProperty(probe, 'offsetWidth', { value: opts.width ?? 100, configurable: true })
  Object.defineProperty(probe, 'offsetHeight', { value: opts.height ?? 50, configurable: true })
  act(() => {
    window.dispatchEvent(new Event('resize'))
  })

  return {
    ...utils,
    probe,
    setRect(next: DOMRect) {
      liveRect = next
    },
  }
}

describe('useAnchorPosition', () => {
  it('places a top/center popover above the trigger, centered on it', () => {
    const { probe } = renderProbe({ side: 'top', align: 'center' })
    expect(probe.style.left).toBe('90px')
    expect(probe.style.top).toBe('144px')
  })

  it('flips a top-preferred popover below when there is no room above', () => {
    const { probe } = renderProbe({
      side: 'top',
      align: 'center',
      triggerRect: makeRect(100, 10),
    })
    expect(probe.style.top).toBe('36px')
  })

  it('clamps a centered popover inside the left viewport edge', () => {
    const { probe } = renderProbe({
      side: 'top',
      align: 'center',
      triggerRect: makeRect(0, 200, 20),
    })
    expect(probe.style.left).toBe('8px')
  })

  it('flips a right-preferred popover to the left when it would overhang', () => {
    const { probe } = renderProbe({
      side: 'right',
      align: 'center',
      triggerRect: makeRect(700, 200),
    })
    expect(probe.style.left).toBe('594px')
  })

  it('aligns a bottom/end popover to the trigger right edge', () => {
    const { probe } = renderProbe({
      side: 'bottom',
      align: 'end',
      triggerRect: makeRect(100, 100),
    })
    expect(probe.style.left).toBe('80px')
    expect(probe.style.top).toBe('126px')
  })

  it('hides when the trigger is missing or measures zero', () => {
    const { probe } = renderProbe({ side: 'top', align: 'center', triggerMissing: true })
    expect(probe.style.visibility).toBe('hidden')
  })

  it('re-measures on scroll', () => {
    const { probe, setRect } = renderProbe({ side: 'top', align: 'center' })
    expect(probe.style.top).toBe('144px')
    setRect(makeRect(100, 300))
    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
    expect(probe.style.top).toBe('244px')
  })
})