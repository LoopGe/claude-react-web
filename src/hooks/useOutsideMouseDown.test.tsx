// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useRef } from 'react'
import { useOutsideMouseDown } from './useOutsideMouseDown'

// A minimal surface + trigger, so the hook's semantics are pinned in ONE place
// instead of once per host component. `ref` goes on the surface (the thing that
// must stay open when pressed), `trigger` on the control that toggles it.
function Probe({
  onClose,
  withTrigger = true,
  nonPrimary = 'close' as const,
  capture = false,
  active = true,
}: {
  onClose: () => void
  withTrigger?: boolean
  nonPrimary?: 'close' | 'ignore'
  capture?: boolean
  active?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  useOutsideMouseDown({ ref, onClose, triggerRef: withTrigger ? triggerRef : undefined, nonPrimary, capture, active })
  return (
    <div>
      <button ref={triggerRef} data-testid="trigger">
        trigger
      </button>
      <div ref={ref} data-testid="surface">
        <span data-testid="child">inside</span>
      </div>
    </div>
  )
}

const setup = (props: Partial<Parameters<typeof Probe>[0]> = {}) => {
  const onClose = vi.fn()
  const utils = render(<Probe onClose={onClose} {...props} />)
  return { onClose, ...utils }
}

describe('useOutsideMouseDown', () => {
  it('closes on a press outside the surface', () => {
    const { onClose } = setup()
    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('never closes on a press inside the surface, including a descendant', () => {
    const { onClose, getByTestId } = setup()
    fireEvent.mouseDown(getByTestId('surface'))
    fireEvent.mouseDown(getByTestId('child'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('never closes on a primary press of the trigger (that is the toggle)', () => {
    // The click that follows a mousedown is what runs the caller's toggle.
    // Closing here would unmount the surface first, so the click would see a
    // null open-state and re-open — the trigger could never dismiss its own
    // surface.
    const { onClose, getByTestId } = setup()
    fireEvent.mouseDown(getByTestId('trigger'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on a primary press of the trigger when no trigger is passed', () => {
    // Hosts whose trigger is NOT a toggle (it only opens) keep the plain
    // outside-press behaviour.
    const { onClose, getByTestId } = setup({ withTrigger: false })
    fireEvent.mouseDown(getByTestId('trigger'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on a secondary press of the trigger — no click will follow', () => {
    const { onClose, getByTestId } = setup()
    fireEvent.mouseDown(getByTestId('trigger'), { button: 2 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('treats ctrl+click as a primary press, at the trigger and elsewhere', () => {
    // macOS ctrl+click is clickless and secondary, but Windows/Linux ctrl+click
    // IS an ordinary primary click. Classifying it as secondary would strand a
    // ContextMenu on Windows (no `contextmenu` follows to replace it) and, at a
    // trigger, close the surface so the following click re-opens it. So it
    // takes the primary path: exempt on the trigger, an ordinary dismissal
    // elsewhere.
    const { onClose, getByTestId } = setup()
    fireEvent.mouseDown(getByTestId('trigger'), { button: 0, ctrlKey: true })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(document.body, { button: 0, ctrlKey: true })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("leaves a secondary press alone when nonPrimary is 'ignore'", () => {
    // ContextMenu's policy: the browser fires `contextmenu` next, which the
    // owner uses to open a replacement menu — closing here would flash.
    const { onClose, getByTestId } = setup({ nonPrimary: 'ignore' })
    fireEvent.mouseDown(getByTestId('trigger'), { button: 2 })
    fireEvent.mouseDown(document.body, { button: 2 })
    expect(onClose).not.toHaveBeenCalled()
  })

  it("still closes on a plain press when nonPrimary is 'ignore'", () => {
    const { onClose } = setup({ nonPrimary: 'ignore' })
    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close while inactive', () => {
    const { onClose } = setup({ active: false })
    fireEvent.mouseDown(document.body)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('stops listening once active flips to false', () => {
    const onClose = vi.fn()
    const { rerender } = render(<Probe onClose={onClose} active />)
    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
    rerender(<Probe onClose={onClose} active={false} />)
    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('honours the capture phase without changing what closes', () => {
    // CommandPicker wants capture (its surface must collapse before other
    // handlers see the press). The dismissal decision is the same either way.
    const { onClose, getByTestId } = setup({ capture: true })
    fireEvent.mouseDown(getByTestId('surface'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes on unmount', () => {
    const { onClose, unmount } = setup()
    unmount()
    fireEvent.mouseDown(document.body)
    expect(onClose).not.toHaveBeenCalled()
  })
})