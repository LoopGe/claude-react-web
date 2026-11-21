// terminalToggleShortcut: the Ctrl+` entry that toggles the focused panel's
// terminal overlay.
//
// These tests run against the REAL useKeyboardShortcuts dispatcher — only the
// open/close handlers are test doubles, because the real ones live in App's
// overlay union (useAppOverlays). The unit under test is the routing: combo
// spelling (platform-fixed ctrl, never meta), the focused-session gate, the
// open-vs-close decision, true-modal suppression, and allowInInput.
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts'
import { terminalToggleShortcut, type TerminalToggleInput } from './terminal-shortcut'

function press(key: string, opts: Partial<KeyboardEventInit> = {}) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, ...opts }))
}

/** Mount the dispatcher with one terminal-toggle entry, mirroring how App
 *  builds it inside its shortcuts useMemo. Returns the handlers plus a
 *  rerender that models App rebuilding the entry on a state change. */
function setup(overrides: Partial<TerminalToggleInput> = {}) {
  const onOpen = vi.fn()
  const onClose = vi.fn()
  const onUnsupported = vi.fn()
  const input: TerminalToggleInput = {
    focusedId: 's1',
    supported: true,
    terminalOpenFor: null,
    modalOpen: false,
    onOpen,
    onClose,
    onUnsupported,
    ...overrides,
  }
  const { rerender } = renderHook(
    (props: TerminalToggleInput) => useKeyboardShortcuts([terminalToggleShortcut(props)]),
    { initialProps: input },
  )
  return {
    onOpen,
    onClose,
    onUnsupported,
    rerender: (next: Partial<TerminalToggleInput>) => rerender({ ...input, ...next }),
  }
}

describe('terminalToggleShortcut', () => {
  it('ctrl+` opens the focused panel’s terminal when none is open', () => {
    const { onOpen, onClose } = setup()
    press('`', { ctrlKey: true })
    expect(onOpen).toHaveBeenCalledWith('s1')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('ctrl+` closes the focused panel’s terminal when it is already open', () => {
    const { onOpen, onClose } = setup({ terminalOpenFor: 's1' })
    press('`', { ctrlKey: true })
    expect(onClose).toHaveBeenCalledOnce()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('ctrl+` opens (replacing the sibling) when another panel’s terminal is the open overlay', () => {
    const { onOpen, onClose } = setup({ terminalOpenFor: 's2' })
    press('`', { ctrlKey: true })
    expect(onOpen).toHaveBeenCalledWith('s1')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('meta+` does NOT fire (Cmd+` is macOS window cycling)', () => {
    const { onOpen, onClose } = setup()
    press('`', { metaKey: true })
    expect(onOpen).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('bare backquote and ctrl+shift+` do not fire', () => {
    const { onOpen, onClose } = setup()
    press('`')
    press('`', { ctrlKey: true, shiftKey: true })
    expect(onOpen).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('fires while a textarea holds focus (allowInInput — the xterm case)', () => {
    const { onOpen } = setup()
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()
    const event = new KeyboardEvent('keydown', { key: '`', ctrlKey: true })
    Object.defineProperty(event, 'target', { value: textarea })
    window.dispatchEvent(event)
    expect(onOpen).toHaveBeenCalledWith('s1')
    document.body.removeChild(textarea)
  })

  it('is suppressed while a true modal is open, and re-arms when it closes', () => {
    const { onOpen, onClose, rerender } = setup()
    rerender({ modalOpen: true })
    press('`', { ctrlKey: true })
    expect(onOpen).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    // Suppression is state-driven, not a one-shot latch.
    rerender({ modalOpen: false })
    press('`', { ctrlKey: true })
    expect(onOpen).toHaveBeenCalledWith('s1')
  })

  it('is suppressed under a modal even when the terminal is already open', () => {
    const { onOpen, onClose } = setup({ terminalOpenFor: 's1', modalOpen: true })
    press('`', { ctrlKey: true })
    expect(onOpen).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not fire during IME composition (isComposing)', () => {
    const { onOpen, onClose } = setup()
    const event = new KeyboardEvent('keydown', { key: '`', ctrlKey: true })
    Object.defineProperty(event, 'isComposing', { value: true })
    window.dispatchEvent(event)
    expect(onOpen).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does nothing when no panel is focused', () => {
    const { onOpen, onClose } = setup({ focusedId: null })
    press('`', { ctrlKey: true })
    expect(onOpen).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('fires the unavailable toast and does not toggle when the session is unsupported', () => {
    const { onOpen, onClose, onUnsupported } = setup({ supported: false })
    press('`', { ctrlKey: true })
    expect(onUnsupported).toHaveBeenCalledOnce()
    expect(onOpen).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not fire the unavailable toast on a supported press', () => {
    const { onUnsupported } = setup()
    press('`', { ctrlKey: true })
    expect(onUnsupported).not.toHaveBeenCalled()
  })

  it('stays silent under a modal even when unsupported (the modal owns the keypress)', () => {
    const { onOpen, onClose, onUnsupported } = setup({ supported: false, modalOpen: true })
    press('`', { ctrlKey: true })
    expect(onUnsupported).not.toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('stays silent with no focused panel even when unsupported', () => {
    const { onOpen, onClose, onUnsupported } = setup({ focusedId: null, supported: false })
    press('`', { ctrlKey: true })
    expect(onUnsupported).not.toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('hides the palette entry when unsupported, shows it when supported', () => {
    const base = {
      focusedId: 's1',
      terminalOpenFor: null,
      modalOpen: false,
      onOpen: vi.fn(),
      onClose: vi.fn(),
      onUnsupported: vi.fn(),
    }
    expect(terminalToggleShortcut({ ...base, supported: false }).paletteHidden).toBe(true)
    expect(terminalToggleShortcut({ ...base, supported: true }).paletteHidden).toBe(false)
  })

  it('routes to the newly focused session after an App-style rebuild', () => {
    const { onOpen, rerender } = setup()
    rerender({ focusedId: 's2' })
    press('`', { ctrlKey: true })
    expect(onOpen).toHaveBeenCalledWith('s2')
  })

  it('works when invoked directly with a synthetic event (the palette action path)', () => {
    const onOpen = vi.fn()
    const onClose = vi.fn()
    const shortcut = terminalToggleShortcut({
      focusedId: 's1',
      supported: true,
      terminalOpenFor: null,
      modalOpen: false,
      onOpen,
      onClose,
      onUnsupported: vi.fn(),
    })
    expect(shortcut.combo).toBe('ctrl+`')
    expect(shortcut.allowInInput).toBe(true)
    expect(shortcut.description).toBe('Toggle terminal')
    // CommandPalette invokes handlers with a synthetic KeyboardEvent.
    shortcut.handler(new KeyboardEvent('keydown'))
    expect(onOpen).toHaveBeenCalledWith('s1')
  })
})
