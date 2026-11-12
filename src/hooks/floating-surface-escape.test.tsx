import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { __resetFloatingSurfacesForTests, getEscapeStackCount, registerFloatingSurface, updateFloatingSurfacePhase } from './floating-surface-registry'
import { useFloatingSurface } from './useFloatingSurface'

// Behavioral contract for the unified registry's Escape ownership:
//   - one Esc closes only the topmost layer the user is interacting with
//   - an open overlay swallows Esc even when focus sits outside every container
//   - a busy winner still swallows, so the layer beneath stays shut
//   - the capture listener is installed lazily and removed on 1→0.

function Harness(props: {
  name: string
  active?: boolean
  onEscape: (e: KeyboardEvent) => void
  canClose?: () => boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useFloatingSurface({
    kind: 'dialog',
    active: props.active ?? true,
    phase: 'open',
    onDismiss: () => {},
    onEscape: props.onEscape,
    canCloseOnEscape: props.canClose,
    getContainer: () => ref.current,
  })
  return (
    <div ref={ref} data-testid={props.name}>
      <input data-testid={`${props.name}-input`} />
    </div>
  )
}

afterEach(() => {
  __resetFloatingSurfacesForTests()
})

describe('floating surface Escape ownership', () => {
  it('routes Escape to the topmost entry whose container holds focus (LIFO)', () => {
    const onA = vi.fn()
    const onB = vi.fn()
    render(<Harness name="a" onEscape={onA} />)
    render(<Harness name="b" onEscape={onB} />)
    expect(getEscapeStackCount()).toBe(2)

    const inputB = screen.getByTestId('b-input')
    inputB.focus()
    fireEvent.keyDown(inputB, { key: 'Escape' })
    expect(onB).toHaveBeenCalledTimes(1)
    expect(onA).not.toHaveBeenCalled()
  })

  it('routes Escape to the entry holding focus even when it is not the topmost', () => {
    const onA = vi.fn()
    const onB = vi.fn()
    render(<Harness name="a" onEscape={onA} />)
    render(<Harness name="b" onEscape={onB} />)

    const inputA = screen.getByTestId('a-input')
    inputA.focus()
    fireEvent.keyDown(inputA, { key: 'Escape' })
    expect(onA).toHaveBeenCalledTimes(1)
    expect(onB).not.toHaveBeenCalled()
  })

  it('consumes Escape when focus is outside every container, closing the topmost', () => {
    const onA = vi.fn()
    const onB = vi.fn()
    render(<Harness name="a" onEscape={onA} />)
    render(<Harness name="b" onEscape={onB} />)

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onB).toHaveBeenCalledTimes(1)
    expect(onA).not.toHaveBeenCalled()
  })

  it('swallows Escape when the winner is busy (canClose false) so lower layers stay shut', () => {
    const onA = vi.fn()
    const onB = vi.fn()
    render(<Harness name="a" onEscape={onA} />)
    render(<Harness name="b" onEscape={onB} canClose={() => false} />)

    const inputB = screen.getByTestId('b-input')
    inputB.focus()
    fireEvent.keyDown(inputB, { key: 'Escape' })
    expect(onB).not.toHaveBeenCalled()
    expect(onA).not.toHaveBeenCalled()
  })

  it('stops the keydown from reaching bubble-phase listeners (beats the App chain)', () => {
    const onA = vi.fn()
    const onBubble = vi.fn()
    window.addEventListener('keydown', onBubble)
    render(<Harness name="a" onEscape={onA} />)

    const inputA = screen.getByTestId('a-input')
    inputA.focus()
    fireEvent.keyDown(inputA, { key: 'Escape' })
    expect(onA).toHaveBeenCalledTimes(1)
    expect(onBubble).not.toHaveBeenCalled()
    window.removeEventListener('keydown', onBubble)
  })

  it('ignores Escape while IME composition is active', () => {
    const onA = vi.fn()
    render(<Harness name="a" onEscape={onA} />)
    const inputA = screen.getByTestId('a-input')
    inputA.focus()
    fireEvent.keyDown(inputA, { key: 'Escape', isComposing: true })
    expect(onA).not.toHaveBeenCalled()
  })

  it('ignores non-Escape keys', () => {
    const onA = vi.fn()
    render(<Harness name="a" onEscape={onA} />)

    const inputA = screen.getByTestId('a-input')
    inputA.focus()
    fireEvent.keyDown(inputA, { key: 'Enter' })
    expect(onA).not.toHaveBeenCalled()
  })

  it('does not register while active is false, and a closed stack is a no-op', () => {
    const onA = vi.fn()
    render(<Harness name="a" active={false} onEscape={onA} />)
    expect(getEscapeStackCount()).toBe(0)

    const inputA = screen.getByTestId('a-input')
    inputA.focus()
    fireEvent.keyDown(inputA, { key: 'Escape' })
    expect(onA).not.toHaveBeenCalled()
  })

  it('removing a middle entry keeps LIFO order for the rest', () => {
    const onA = vi.fn()
    const onB = vi.fn()
    const onC = vi.fn()
    const a = render(<Harness name="a" onEscape={onA} />)
    const b = render(<Harness name="b" onEscape={onB} />)
    render(<Harness name="c" onEscape={onC} />)
    expect(getEscapeStackCount()).toBe(3)

    b.unmount()
    expect(getEscapeStackCount()).toBe(2)

    const inputC = screen.getByTestId('c-input')
    inputC.focus()
    fireEvent.keyDown(inputC, { key: 'Escape' })
    expect(onC).toHaveBeenCalledTimes(1)
    expect(onA).not.toHaveBeenCalled()
    a.unmount()
    expect(getEscapeStackCount()).toBe(1)
  })

  it('reinstalls the capture listener when an exiting surface re-enters', () => {
    const onA = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const unregisterA = registerFloatingSurface({
      id: 'a', kind: 'dialog', getContainer: () => container,
      onDismiss: () => {}, onEscape: onA,
    })
    updateFloatingSurfacePhase('a', 'exiting')
    const unregisterB = registerFloatingSurface({
      id: 'b', kind: 'dialog', getContainer: () => container,
      onDismiss: () => {}, onEscape: () => {},
    })
    unregisterB()
    updateFloatingSurfacePhase('a', 'open')

    fireEvent.keyDown(container, { key: 'Escape' })
    expect(onA).toHaveBeenCalledOnce()
    unregisterA()
    container.remove()
  })

  it('unregisters every entry on unmount (listener torn down on 1→0)', () => {
    const onA = vi.fn()
    const onB = vi.fn()
    const a = render(<Harness name="a" onEscape={onA} />)
    const b = render(<Harness name="b" onEscape={onB} />)
    expect(getEscapeStackCount()).toBe(2)

    a.unmount()
    b.unmount()
    expect(getEscapeStackCount()).toBe(0)
  })
})
