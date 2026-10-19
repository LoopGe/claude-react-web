import { describe, it, expect } from 'vitest'
import { useRef, type ReactNode } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { useFocusTrap } from './useFocusTrap'

function Trap({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref, { restoreFocus: false })
  return (
    <div ref={ref} data-testid="trap">
      {children}
    </div>
  )
}

/**
 * Unfocusable inputs still match the trap's `input` selector. If one lands
 * at either end of the focusable list, the Tab/Shift+Tab wrap compares
 * document.activeElement against it and never fires — so those elements
 * must be filtered out of the boundary calculation.
 */
describe('useFocusTrap boundary calculation', () => {
  it('wraps past a trailing [hidden] file input', () => {
    render(
      <Trap>
        <button>First</button>
        <button>Last</button>
        <input type="file" hidden />
      </Trap>,
    )
    const trap = screen.getByTestId('trap')
    const first = screen.getByText('First')
    const last = screen.getByText('Last')

    last.focus()
    fireEvent.keyDown(trap, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    first.focus()
    fireEvent.keyDown(trap, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('wraps past a trailing display:none file input', () => {
    render(
      <Trap>
        <button>First</button>
        <button>Last</button>
        <input type="file" style={{ display: 'none' }} />
      </Trap>,
    )
    const trap = screen.getByTestId('trap')
    const first = screen.getByText('First')
    const last = screen.getByText('Last')

    last.focus()
    fireEvent.keyDown(trap, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
  })

  it('wraps past a trailing disabled control', () => {
    render(
      <Trap>
        <button>First</button>
        <button>Last</button>
        <button disabled>Disabled</button>
      </Trap>,
    )
    const trap = screen.getByTestId('trap')
    const first = screen.getByText('First')
    const last = screen.getByText('Last')

    last.focus()
    fireEvent.keyDown(trap, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    first.focus()
    fireEvent.keyDown(trap, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })
})
