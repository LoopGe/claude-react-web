import { createPortal } from 'react-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SearchField } from '../components/SearchField'
import { useSearchablePicker } from './useSearchablePicker'

interface Row {
  id: string
  label: string
}

interface HarnessProps {
  rows?: Row[]
  searchable?: boolean
  enterOnButtons?: 'activate-row' | 'native'
  disabled?: boolean
  onReset?: () => void
  onActivate?: (row: Row) => void
}

const DEFAULT_ROWS: Row[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
]

function Harness({
  rows = DEFAULT_ROWS,
  searchable = true,
  enterOnButtons = 'activate-row',
  disabled = false,
  onReset,
  onActivate = () => {},
}: HarnessProps) {
  const {
    open,
    search,
    setSearchValue,
    searchRef,
    active,
    rows: visibleRows,
    hover,
    listRef,
    listId,
    optionId,
    close,
    activate,
    triggerProps,
    menuProps,
  } = useSearchablePicker<Row>({
    id: 'test',
    rows: (query) => rows.filter((row) => row.label.toLowerCase().includes(query.toLowerCase())),
    searchable,
    disabled,
    listMaxVar: '--test-picker-list-max',
    enterOnButtons,
    onReset,
    onActivate: choose,
  })

  function choose(row: Row): void {
    onActivate(row)
    close(true)
  }

  return (
    <>
      <button type="button" className="test-trigger" disabled={disabled} {...triggerProps}>
        Open
      </button>
      {open &&
        createPortal(
          <div className="test-menu" {...menuProps}>
            {searchable && (
              <SearchField
                value={search}
                onChange={setSearchValue}
                placeholder="Search"
                ariaLabel="Search"
                wrapperClassName="test-search"
                inputRef={searchRef}
                ariaControls={listId}
                ariaActiveDescendant={active >= 0 ? optionId(active) : undefined}
              />
            )}
            <button type="button" className="test-menu-button">
              Menu button
            </button>
            <div
              ref={listRef}
              id={listId}
              className="test-list"
              role="listbox"
              tabIndex={searchable ? -1 : 0}
            >
              {visibleRows.map((row, index) => (
                <button
                  type="button"
                  id={optionId(index)}
                  data-index={index}
                  role="option"
                  key={row.id}
                  onClick={() => activate(row)}
                  onMouseEnter={() => hover(index)}
                >
                  {row.label}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

const trigger = () => document.querySelector('.test-trigger') as HTMLButtonElement
const menu = () => document.querySelector('.test-menu')
const search = () => screen.getByRole('textbox', { name: 'Search' })

function openPicker() {
  fireEvent.click(trigger())
  return menu()
}

describe('useSearchablePicker', () => {
  it('filters rows through the query factory and activates a row with Enter', () => {
    const onActivate = vi.fn()
    const onReset = vi.fn()
    render(<Harness onActivate={onActivate} onReset={onReset} />)
    openPicker()
    const input = search()
    expect(document.activeElement).toBe(input)

    fireEvent.change(input, { target: { value: 'beta' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onActivate).toHaveBeenCalledWith({ id: 'b', label: 'Beta' })
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('wraps arrow navigation and ignores keys during IME composition', () => {
    render(<Harness />)
    openPicker()
    const input = search()
    expect(input.getAttribute('aria-activedescendant')).toBe('test-menu-opt-0')

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.getAttribute('aria-activedescendant')).toBe('test-menu-opt-1')
    fireEvent.keyDown(
      input,
      new KeyboardEvent('keydown', { key: 'ArrowDown', isComposing: true, bubbles: true }),
    )
    expect(input.getAttribute('aria-activedescendant')).toBe('test-menu-opt-1')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toBe('test-menu-opt-0')
  })

  it('preserves native Enter on buttons in native mode', () => {
    const onActivate = vi.fn()
    render(<Harness enterOnButtons="native" onActivate={onActivate} />)
    openPicker()
    const menuButton = screen.getByRole('button', { name: 'Menu button' })
    act(() => {
      menuButton.focus()
    })

    const notPrevented = fireEvent.keyDown(menuButton, { key: 'Enter' })
    expect(notPrevented).toBe(true)
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('activates the highlighted row for button Enter in activate-row mode', () => {
    const onActivate = vi.fn()
    render(<Harness enterOnButtons="activate-row" onActivate={onActivate} />)
    openPicker()
    const menuButton = screen.getByRole('button', { name: 'Menu button' })
    act(() => {
      menuButton.focus()
    })

    fireEvent.keyDown(menuButton, { key: 'Enter' })
    expect(onActivate).toHaveBeenCalledWith(DEFAULT_ROWS[0])
  })

  it('focuses the list when search is disabled', () => {
    render(<Harness searchable={false} />)
    openPicker()
    expect(document.activeElement).toBe(document.querySelector('.test-list'))
  })

  it('keeps Safari null-blur open but closes when focus leaves the menu', () => {
    render(<Harness />)
    openPicker()
    const input = search()
    fireEvent.focusOut(input, { relatedTarget: null })
    expect(menu()).toBeTruthy()

    const outside = document.createElement('button')
    document.body.appendChild(outside)
    fireEvent.focusOut(input, { relatedTarget: outside })
    expect(menu()).toBeNull()
    outside.remove()
  })

  it('positions and caps the menu using the caller list-max variable', () => {
    const previousHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { value: 180, configurable: true })
    try {
      render(<Harness />)
      trigger().getBoundingClientRect = () =>
        ({
          left: 0,
          top: 100,
          right: 100,
          bottom: 116,
          width: 100,
          height: 16,
          x: 0,
          y: 100,
          toJSON: () => ({}),
        }) as DOMRect
      openPicker()
      const menuElement = menu() as HTMLElement
      const list = document.querySelector('.test-list') as HTMLElement
      Object.defineProperty(menuElement, 'offsetHeight', { value: 100, configurable: true })
      Object.defineProperty(list, 'offsetHeight', { value: 60, configurable: true })
      Object.defineProperty(list, 'scrollHeight', { value: 200, configurable: true })

      act(() => {
        window.dispatchEvent(new Event('resize'))
      })

      expect(menuElement.style.width).toBe('264px')
      expect(menuElement.style.left).toBe('8px')
      expect(menuElement.style.top).toBe('8px')
      expect(menuElement.style.getPropertyValue('--test-picker-list-max')).toBe('96px')
    } finally {
      Object.defineProperty(window, 'innerHeight', { value: previousHeight, configurable: true })
    }
  })

  it('retires an open menu during the disabled render and resets caller state', () => {
    const onReset = vi.fn()
    const { rerender } = render(<Harness onReset={onReset} />)
    openPicker()

    rerender(<Harness onReset={onReset} disabled />)

    expect(menu()).toBeNull()
    expect(onReset).toHaveBeenCalled()
  })

  it('clears the query and refocuses search', () => {
    render(<Harness />)
    openPicker()
    const input = search()
    fireEvent.change(input, { target: { value: 'beta' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect((input as HTMLInputElement).value).toBe('')
    expect(screen.getAllByRole('option')).toHaveLength(2)
    expect(document.activeElement).toBe(input)
  })

  it('closes on Escape, restores focus, and resets caller state', () => {
    const onReset = vi.fn()
    render(<Harness onReset={onReset} />)
    openPicker()

    fireEvent.keyDown(search(), { key: 'Escape' })
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(trigger())
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  // Shared useListSelection wiring: hover only moves the highlight; the arrow
  // keys scroll the row they land on (and wrap — see the hook's options).
  it('hovers without scrolling and scrolls the row arrow navigation lands on', () => {
    const originalScrollIntoView = Element.prototype.scrollIntoView
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      render(<Harness />)
      openPicker()
      const options = () => screen.getAllByRole('option')
      scrollIntoView.mockClear()

      fireEvent.mouseEnter(options()[1])
      expect(search().getAttribute('aria-activedescendant')).toBe('test-menu-opt-1')
      expect(scrollIntoView).not.toHaveBeenCalled()

      fireEvent.keyDown(menu()!, { key: 'ArrowDown' })
      // Wraps from the last row back to the first.
      expect(search().getAttribute('aria-activedescendant')).toBe('test-menu-opt-0')
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
      expect(scrollIntoView.mock.instances[0]).toBe(options()[0])
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView
    }
  })
})
