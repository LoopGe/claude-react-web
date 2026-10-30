import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen, act } from '@testing-library/react'
import { CreateMenuButton } from './CreateMenuButton'
import { closeAllContextMenus } from './context-menu-registry'

function setup(overrides: Partial<React.ComponentProps<typeof CreateMenuButton>> = {}) {
  const onNewSession = overrides.onNewSession ?? vi.fn()
  const onCreateGroup = overrides.onCreateGroup ?? vi.fn()
  const askPrompt = (overrides.askPrompt ?? vi.fn()) as ReturnType<typeof vi.fn>
  const utils = render(
    <CreateMenuButton
      className="session-nav-new btn btn-icon"
      aria-label="Create"
      title="Create"
      onNewSession={onNewSession}
      onCreateGroup={onCreateGroup}
      askPrompt={askPrompt}
      {...overrides}
    >
      +
    </CreateMenuButton>,
  )
  return { onNewSession, onCreateGroup, askPrompt, ...utils }
}

describe('CreateMenuButton', () => {
  it('does not fire onNewSession on the + click itself — it opens the menu', () => {
    const { onNewSession } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(onNewSession).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('menu lists New session… and New group…', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    const labels = Array.from(document.querySelectorAll('.ctx-menu-label')).map((e) => e.textContent)
    expect(labels).toEqual(['New session…', 'New group…'])
  })

  it('New session… fires onNewSession and closes the menu', () => {
    const { onNewSession } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    fireEvent.click(document.querySelectorAll('.ctx-menu-item')[0])
    expect(onNewSession).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('New group… opens the create prompt and closes the menu', () => {
    const { askPrompt } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    fireEvent.click(document.querySelectorAll('.ctx-menu-item')[1])
    expect(askPrompt).toHaveBeenCalledOnce()
    expect(askPrompt.mock.calls[0][0].title).toBe('New group')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('clicking the + again dismisses the menu instead of reopening it', () => {
    setup()
    const plus = screen.getByRole('button', { name: 'Create' })
    fireEvent.click(plus)
    expect(screen.getByRole('menu')).toBeTruthy()
    // Second press on the trigger is a toggle: outside-mousedown must NOT
    // close-then-reopen via the trailing click.
    fireEvent.mouseDown(plus)
    fireEvent.click(plus)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(plus.getAttribute('aria-expanded')).toBe('false')
  })

  it('moves focus to the first menu item when opened', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    const items = document.querySelectorAll<HTMLButtonElement>('.ctx-menu-item')
    expect(document.activeElement).toBe(items[0])
  })

  it('returns focus to the + when the menu closes', () => {
    setup()
    const plus = screen.getByRole('button', { name: 'Create' })
    fireEvent.click(plus)
    expect(document.activeElement).not.toBe(plus)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(plus)
  })

  it('a right-click outside dismisses the create menu (left-click-owned surface)', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.mouseDown(document.body, { button: 2 })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('a programmatic dismiss (closeAllContextMenus) does not steal focus', () => {
    // Layout shifts (sidebar toggle / keyboard sidebar resize) dismiss every
    // menu via the registry while the user is on ANOTHER control (e.g. the
    // resizer mid keyboard-resize) — returning focus to the + would kill that
    // control's continued interaction. Only user dismissals from within the
    // menu flow return focus.
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(screen.getByRole('menu')).toBeTruthy()
    const other = document.createElement('button')
    document.body.appendChild(other)
    other.focus()
    act(() => closeAllContextMenus())
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(other)
  })
})
