/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { AnimatePresence } from 'motion/react'
import { useRef, useState, StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnchoredPopover } from './AnchoredPopover'
import { ContextMenu } from './ContextMenu'
import { HoverPopover } from './HoverPopover'
import { ModelPicker } from './ModelPicker'
import { Overlay } from './Overlay'
import {
  __resetFloatingSurfacesForTests,
  getFloatingSurfaceCount,
} from '../hooks/floating-surface-registry'

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
Element.prototype.scrollIntoView = vi.fn()

function Hover({ label = 'hover' }: { label?: string }) {
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={ref}>{label}</button>
      <HoverPopover triggerRef={ref}>
        <div>hover details</div>
      </HoverPopover>
    </>
  )
}

function hover() {
  return document.querySelector('.hover-pop')
}

function menu() {
  return document.querySelector('.ctx-menu')
}

function MenuHarness({ open }: { open: boolean }) {
  const [dismissed, setDismissed] = useState(false)
  return (
    <>
      <Hover />
      {open && !dismissed && (
        <ContextMenu x={0} y={0} items={[{ label: 'Run' }]} onClose={() => setDismissed(true)} />
      )}
    </>
  )
}

function ExitMenuHarness({ open }: { open: boolean }) {
  return (
    <>
      <Hover />
      <AnimatePresence>
        {open && <ContextMenu key="menu" x={0} y={0} items={[{ label: 'Run' }]} onClose={() => {}} />}
      </AnimatePresence>
    </>
  )
}

function ExitAnchoredHarness({ open }: { open: boolean }) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={anchorRef}>anchor</button>
      <Hover />
      <AnimatePresence>
        {open && (
          <AnchoredPopover key="pop" className="anchored-test" ariaLabel="Details" triggerRef={anchorRef} onClose={() => {}}>
            details
          </AnchoredPopover>
        )}
      </AnimatePresence>
    </>
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  __resetFloatingSurfacesForTests()
})

afterEach(() => {
  __resetFloatingSurfacesForTests()
  vi.useRealTimers()
})

describe('floating surface hover policy', () => {
  it('closes visible hover and denies background reentry while a menu is open', () => {
    const { rerender } = render(<MenuHarness open={false} />)
    const trigger = screen.getByRole('button', { name: 'hover' })
    fireEvent.pointerEnter(trigger)
    act(() => vi.advanceTimersByTime(200))
    expect(hover()).not.toBeNull()

    rerender(<MenuHarness open />)
    expect(menu()).not.toBeNull()
    expect(hover()).toBeNull()
    fireEvent.pointerLeave(trigger)
    fireEvent.pointerEnter(trigger)
    act(() => vi.advanceTimersByTime(500))
    expect(hover()).toBeNull()

    fireEvent.keyDown(menu()!, { key: 'Escape' })
    expect(menu()).toBeNull()
    fireEvent.pointerLeave(trigger)
    fireEvent.pointerEnter(trigger)
    act(() => vi.advanceTimersByTime(200))
    expect(hover()).not.toBeNull()
  })

  it('cancels a pending hover when a menu opens and closes before the dwell', () => {
    const { rerender } = render(<MenuHarness open={false} />)
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'hover' }))
    act(() => vi.advanceTimersByTime(100))
    rerender(<MenuHarness open />)
    rerender(<MenuHarness open={false} />)
    act(() => vi.advanceTimersByTime(500))
    expect(hover()).toBeNull()
  })

  it('cancels a pending hover when its kept-mounted dialog closes', () => {
    function Harness({ open }: { open: boolean }) {
      return (
        <Overlay open={open} keepMounted onClose={() => {}}>
          <Hover />
        </Overlay>
      )
    }
    const { rerender } = render(<Harness open />)
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'hover' }))
    act(() => vi.advanceTimersByTime(100))
    rerender(<Harness open={false} />)
    act(() => vi.advanceTimersByTime(500))
    expect(hover()).toBeNull()
  })

  it('keeps nested surfaces mounted through StrictMode effect replay', () => {
    const anchorRef = { current: null as HTMLButtonElement | null }
    render(
      <StrictMode>
        <Overlay open onClose={() => {}}>
          <button ref={anchorRef}>anchor</button>
          <AnchoredPopover className="strict-child" ariaLabel="Child" triggerRef={anchorRef} onClose={() => {}}>
            child
          </AnchoredPopover>
        </Overlay>
      </StrictMode>,
    )
    expect(document.querySelector('.strict-child')).not.toBeNull()
  })

  it('retires a kept-mounted child when its parent dialog closes', async () => {
    const onChildClose = vi.fn()
    function Harness({ open }: { open: boolean }) {
      const anchorRef = useRef<HTMLButtonElement>(null)
      const [childOpen, setChildOpen] = useState(true)
      return (
        <Overlay open={open} keepMounted onClose={() => {}}>
          <button ref={anchorRef}>anchor</button>
          {childOpen && (
            <AnchoredPopover className="kept-child" ariaLabel="Child" triggerRef={anchorRef} onClose={() => { onChildClose(); setChildOpen(false) }}>
              child
            </AnchoredPopover>
          )}
        </Overlay>
      )
    }
    const { rerender } = render(<Harness open />)
    expect(document.querySelector('.kept-child')).not.toBeNull()
    rerender(<Harness open={false} />)
    act(() => {
      vi.runAllTicks()
    })
    expect(onChildClose).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.kept-child')).toBeNull()
  })

  it('allows hover inside a dialog but denies hover on the page behind it', () => {
    render(
      <>
        <Hover label="background" />
        <Overlay open onClose={() => {}}>
          <Hover label="inside" />
        </Overlay>
      </>,
    )
    const inside = screen.getByRole('button', { name: 'inside' })
    fireEvent.pointerEnter(inside)
    act(() => vi.advanceTimersByTime(200))
    expect(hover()).not.toBeNull()

    fireEvent.pointerLeave(inside)
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'background' }))
    act(() => vi.advanceTimersByTime(500))
    expect(hover()).toBeNull()
  })

  it('keeps one entry per surface and routes nested Escape child-first', () => {
    const onParentClose = vi.fn()
    function Nested() {
      const [childOpen, setChildOpen] = useState(true)
      const anchorRef = useRef<HTMLButtonElement>(null)
      return (
        <Overlay open onClose={onParentClose}>
          <button ref={anchorRef}>anchor</button>
          {childOpen && (
            <AnchoredPopover className="child-pop" ariaLabel="Child" triggerRef={anchorRef} onClose={() => setChildOpen(false)}>
              child
            </AnchoredPopover>
          )}
        </Overlay>
      )
    }
    render(<Nested />)
    expect(getFloatingSurfaceCount()).toBe(2)
    const child = document.querySelector('.child-pop')!
    fireEvent.keyDown(child, { key: 'Escape' })
    expect(document.querySelector('.child-pop')).toBeNull()
    expect(onParentClose).not.toHaveBeenCalled()
    fireEvent.keyDown(document.querySelector('.modal')!, { key: 'Escape' })
    expect(onParentClose).toHaveBeenCalledTimes(1)
  })

  it('replaces a nested ModelPicker with a sibling menu without closing its dialog or double-registering', () => {
    const onParentClose = vi.fn()
    function Harness({ menuOpen }: { menuOpen: boolean }) {
      const [pickerOpen, setPickerOpen] = useState(true)
      return (
        <Overlay open onClose={onParentClose}>
          {pickerOpen && (
            <ModelPicker
              anchor={{ x: 0, y: 0, source: null }}
              current={undefined}
              options={{ models: [{ id: 'm1' }], recents: [], defaultModel: 'm1', modelGroups: [] }}
              onSelect={() => {}}
              onClose={() => setPickerOpen(false)}
            />
          )}
          {menuOpen && <ContextMenu x={0} y={0} items={[{ label: 'Run' }]} onClose={() => {}} />}
        </Overlay>
      )
    }
    const { rerender } = render(<Harness menuOpen={false} />)
    expect(document.querySelector('.model-picker')).not.toBeNull()
    expect(getFloatingSurfaceCount()).toBe(2)
    rerender(<Harness menuOpen />)
    expect(document.querySelector('.model-picker')).toBeNull()
    expect(menu()).not.toBeNull()
    expect(onParentClose).not.toHaveBeenCalled()
    expect(getFloatingSurfaceCount()).toBe(2)
  })

  it('re-registers a Motion surface reopened by the same key during exit', () => {
    const onA = vi.fn()
    function Harness() {
      const [aOpen, setAOpen] = useState(true)
      const [bOpen, setBOpen] = useState(false)
      return (
        <>
          <button onClick={() => setBOpen(true)}>open B</button>
          <button onClick={() => { setBOpen(false); setAOpen(true) }}>reopen A</button>
          <AnimatePresence>
            {aOpen && <ContextMenu key="a" x={0} y={0} items={[{ label: 'A' }]} onClose={() => { onA(); setAOpen(false) }} />}
            {bOpen && <ContextMenu key="b" x={0} y={0} items={[{ label: 'B' }]} onClose={() => setBOpen(false)} />}
          </AnimatePresence>
        </>
      )
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'open B' }))
    expect(onA).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'reopen A' }))

    const reopened = screen.getByText('A').closest('.ctx-menu')!
    fireEvent.keyDown(reopened, { key: 'Escape' })
    expect(onA).toHaveBeenCalledTimes(2)
  })

  it('denies hover while a ContextMenu is open but allows it during Motion exit', () => {
    const { rerender } = render(<ExitMenuHarness open />)
    const trigger = screen.getByRole('button', { name: 'hover' })
    fireEvent.pointerEnter(trigger)
    act(() => vi.advanceTimersByTime(200))
    expect(hover()).toBeNull()

    rerender(<ExitMenuHarness open={false} />)
    expect(menu()).not.toBeNull()
    fireEvent.pointerLeave(trigger)
    fireEvent.pointerEnter(trigger)
    act(() => vi.advanceTimersByTime(200))
    expect(hover()).not.toBeNull()
  })

  it('denies hover while an AnchoredPopover is open but allows it during Motion exit', () => {
    const { rerender } = render(<ExitAnchoredHarness open />)
    const trigger = screen.getByRole('button', { name: 'hover' })
    fireEvent.pointerEnter(trigger)
    act(() => vi.advanceTimersByTime(200))
    expect(hover()).toBeNull()

    rerender(<ExitAnchoredHarness open={false} />)
    expect(document.querySelector('.anchored-test')).not.toBeNull()
    fireEvent.pointerLeave(trigger)
    fireEvent.pointerEnter(trigger)
    act(() => vi.advanceTimersByTime(200))
    expect(hover()).not.toBeNull()
  })
})
