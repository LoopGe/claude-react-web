import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { __resetForTests, getEscapeStackCount, useEscapeStack } from './useEscapeStack'

// Behavioral contract for the Escape ownership stack:
//   - one Esc closes only the topmost layer the user is interacting with
//     (most recently opened wins, resolved by which container holds focus)
//   - an open overlay swallows Esc even when focus sits outside every container,
//     so it can't fall through to App's bubble-phase interrupt chain
//   - a busy winner (canClose false) still swallows, so the layer beneath stays
//     shut
//   - the stack is a module singleton: the window capture listener is installed
//     lazily on 0→1 and removed on 1→0, and __resetForTests() restores a clean
//     slate between tests.

function Harness(props: {
  name: string
  active?: boolean
  onEscape: (e: KeyboardEvent) => void
  canClose?: () => boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEscapeStack({
    active: props.active,
    onEscape: props.onEscape,
    canClose: props.canClose,
    getContainer: () => ref.current,
  })
  return (
    <div ref={ref} data-testid={props.name}>
      <input data-testid={`${props.name}-input`} />
    </div>
  )
}

afterEach(() => {
  cleanup()
  __resetForTests()
})

describe('useEscapeStack', () => {
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
