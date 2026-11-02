import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnchoredPopover, type AnchorRect } from './AnchoredPopover'
import { expectPortaledToBody } from './portal-test-utils'

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

function makeRect(left: number, top: number, width = 100, height = 16): DOMRect {
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

function renderPopover(
  opts: {
    placement?: 'above' | 'below'
    anchor?: AnchorRect | null
    triggerRect?: DOMRect
    withTrigger?: boolean
    width?: number
    height?: number
  } = {},
) {
  const trigger = document.createElement('button')
  document.body.appendChild(trigger)
  triggers.push(trigger)
  let liveRect = opts.triggerRect ?? makeRect(20, 100)
  trigger.getBoundingClientRect = () => liveRect
  const onClose = vi.fn()
  const anchor = opts.anchor === undefined ? liveRect : opts.anchor
  const utils = render(
    <AnchoredPopover
      className="test-pop"
      ariaLabel="Details"
      {...(anchor ? { anchor } : {})}
      triggerRef={{ current: opts.withTrigger === false ? null : trigger }}
      placement={opts.placement}
      onClose={onClose}
    >
      <div>Popover body</div>
    </AnchoredPopover>,
  )
  const pop = document.querySelector('.test-pop') as HTMLElement
  Object.defineProperty(pop, 'offsetWidth', { value: opts.width ?? 100, configurable: true })
  Object.defineProperty(pop, 'offsetHeight', { value: opts.height ?? 50, configurable: true })
  act(() => {
    window.dispatchEvent(new Event('resize'))
  })
  return {
    ...utils,
    pop,
    trigger,
    onClose,
    setRect(next: DOMRect) {
      liveRect = next
    },
  }
}

describe('AnchoredPopover geometry', () => {
  it('defaults to above the live trigger', () => {
    const { pop } = renderPopover({ triggerRect: makeRect(20, 200) })
    expect(pop.style.top).toBe('144px')
  })

  it('supports below as the preferred placement', () => {
    const { pop } = renderPopover({ placement: 'below', triggerRect: makeRect(20, 100) })
    expect(pop.style.top).toBe('122px')
  })

  it('flips a below-preferred popover above when space below is insufficient', () => {
    setWindowValue('innerHeight', 200)
    const { pop } = renderPopover({ placement: 'below', triggerRect: makeRect(20, 160) })
    expect(pop.style.top).toBe('104px')
  })

  it('preserves the legacy below-flip coordinates for an offscreen anchor', () => {
    setWindowValue('innerHeight', 200)
    const { pop } = renderPopover({ placement: 'below', triggerRect: makeRect(20, 250) })
    // ProjectPopover's pre-migration formula had no final clamp after a
    // below→above flip. Keep that geometry in this dedup change rather than
    // silently bundling an offscreen-position behavior fix.
    expect(pop.style.top).toBe('194px')
  })

  it('flips an above-preferred popover below and clamps it to the viewport', () => {
    setWindowValue('innerHeight', 120)
    const { pop } = renderPopover({ triggerRect: makeRect(20, 10), height: 90 })
    expect(pop.style.top).toBe('22px')
  })

  it('uses the fallback anchor when no live trigger is available', () => {
    const { pop } = renderPopover({ withTrigger: false, triggerRect: makeRect(20, 200) })
    expect(pop.style.top).toBe('144px')
  })

  it('stays hidden when neither a live trigger nor a fallback anchor exists', () => {
    expect(() => renderPopover({ withTrigger: false, anchor: null })).not.toThrow()
    const pop = document.querySelector('.test-pop') as HTMLElement
    expect(pop.style.visibility).toBe('hidden')
  })

  it('hides a zero-sized live anchor instead of clamping it into the viewport', () => {
    const { pop } = renderPopover({ triggerRect: makeRect(0, 0, 0, 0) })
    expect(pop.style.visibility).toBe('hidden')
  })

  it('snaps fractional coordinates to the device pixel grid', () => {
    setWindowValue('devicePixelRatio', 2)
    const { pop } = renderPopover({
      placement: 'below',
      triggerRect: makeRect(10.8, 77.8438, 110, 16),
    })
    expect(pop.style.left).toBe('11px')
    expect(pop.style.top).toBe('100px')
  })

  it('re-reads the live trigger on capture-scroll', () => {
    const { pop, setRect } = renderPopover({ placement: 'below', triggerRect: makeRect(20, 100) })
    expect(pop.style.top).toBe('122px')

    setRect(makeRect(20, 120))
    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
    expect(pop.style.top).toBe('142px')
  })

  it('re-measures when ResizeObserver reports a content height change', () => {
    const { pop } = renderPopover({ triggerRect: makeRect(20, 200) })
    expect(pop.style.top).toBe('144px')

    Object.defineProperty(pop, 'offsetHeight', { value: 80, configurable: true })
    act(() => {
      for (const callback of resizeCallbacks) callback()
    })
    expect(pop.style.top).toBe('114px')
  })
})

describe('AnchoredPopover portal and dismissal', () => {
  it('portals to body and preserves inside and trigger presses while dismissing outside and on Escape', () => {
    const { container, pop, trigger, onClose } = renderPopover()
    expectPortaledToBody(container, '.test-pop')

    fireEvent.mouseDown(pop)
    fireEvent.mouseDown(trigger)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
