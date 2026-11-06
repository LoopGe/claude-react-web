import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HoverPopover, type HoverPopoverProps } from './HoverPopover'
import { expectPortaledToBody } from './portal-test-utils'

vi.stubGlobal('matchMedia', () => ({
  matches: false,
  media: '',
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
}))

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

const triggers: HTMLButtonElement[] = []

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
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  setWindowValue('innerWidth', 800)
  setWindowValue('innerHeight', 600)
  setWindowValue('devicePixelRatio', 1)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  for (const trigger of triggers) trigger.remove()
  triggers.length = 0
})

function setup(overrides: Partial<HoverPopoverProps> = {}) {
  const trigger = document.createElement('button')
  document.body.appendChild(trigger)
  triggers.push(trigger)
  trigger.getBoundingClientRect = () => makeRect(20, 100)
  const utils = render(
    <HoverPopover triggerRef={{ current: trigger }} {...overrides}>
      <div className="card-body">Details</div>
    </HoverPopover>,
  )
  return { trigger, ...utils }
}

function pop(): HTMLElement | null {
  return document.querySelector('.hover-pop')
}

function open(trigger: HTMLElement, by: 'pointer' | 'focus' = 'pointer', ms = 200) {
  if (by === 'pointer') fireEvent.pointerEnter(trigger)
  else fireEvent.focusIn(trigger)
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('HoverPopover lifecycle', () => {
  it('opens only after the dwell', () => {
    const { trigger } = setup()
    fireEvent.pointerEnter(trigger)
    act(() => {
      vi.advanceTimersByTime(199)
    })
    expect(pop()).toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(pop()).not.toBeNull()
  })

  it('cancels a pending open when the pointer leaves', () => {
    const { trigger } = setup()
    fireEvent.pointerEnter(trigger)
    act(() => {
      vi.advanceTimersByTime(100)
    })
    fireEvent.pointerLeave(trigger)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(pop()).toBeNull()
  })

  it('closes after the grace when the pointer leaves', () => {
    const { trigger } = setup()
    open(trigger)
    expect(pop()).not.toBeNull()
    fireEvent.pointerLeave(trigger)
    act(() => {
      vi.advanceTimersByTime(149)
    })
    expect(pop()).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(pop()).toBeNull()
  })

  it('opens on focus and closes on focusout', () => {
    const { trigger } = setup()
    open(trigger, 'focus')
    expect(pop()).not.toBeNull()
    fireEvent.focusOut(trigger)
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(pop()).toBeNull()
  })
})

describe('HoverPopover modes', () => {
  it('renders a passive popover as a tooltip with pointer-events off', () => {
    const { trigger } = setup()
    open(trigger)
    const el = pop()!
    expect(el.getAttribute('role')).toBe('tooltip')
    expect(el.classList.contains('hover-pop-interactive')).toBe(false)
  })

  it('renders an interactive popover as a dialog with pointer-events on', () => {
    const { trigger } = setup({ interactive: true, ariaLabel: 'Details' })
    open(trigger)
    const el = pop()!
    expect(el.getAttribute('role')).toBe('dialog')
    expect(el.getAttribute('aria-label')).toBe('Details')
    expect(el.classList.contains('hover-pop-interactive')).toBe(true)
  })

  it('crosses the trigger → popover gap while interactive', () => {
    const { trigger } = setup({ interactive: true })
    open(trigger)
    fireEvent.pointerLeave(trigger)
    act(() => {
      vi.advanceTimersByTime(149)
    })
    const el = pop()!
    fireEvent.pointerEnter(el)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(pop()).not.toBeNull()
    fireEvent.pointerLeave(el)
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(pop()).toBeNull()
  })

  it('does not close while focus moves into an interactive popover', () => {
    const { trigger } = setup({ interactive: true })
    open(trigger)
    const el = pop()!
    fireEvent.focusOut(trigger, { relatedTarget: el })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(pop()).not.toBeNull()
  })

  it('describes the trigger while passive', () => {
    const { trigger } = setup()
    open(trigger)
    const el = pop()!
    expect(el.id).not.toBe('')
    expect(trigger.getAttribute('aria-describedby')).toBe(el.id)
  })

  it('does not describe the trigger while interactive', () => {
    const { trigger } = setup({ interactive: true })
    open(trigger)
    expect(trigger.getAttribute('aria-describedby')).toBeNull()
  })

  it('dismisses an interactive popover on Escape', () => {
    const { trigger } = setup({ interactive: true })
    open(trigger)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(pop()).toBeNull()
  })

  it('dismisses an interactive popover on an outside mousedown', () => {
    const { trigger } = setup({ interactive: true })
    open(trigger)
    fireEvent.mouseDown(document.body)
    expect(pop()).toBeNull()
  })

  it('renders nothing while disabled', () => {
    const { trigger } = setup({ disabled: true })
    fireEvent.pointerEnter(trigger)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(pop()).toBeNull()
  })

  it('portals to body', () => {
    const { trigger, container } = setup()
    open(trigger)
    expectPortaledToBody(container, '.hover-pop')
  })
})