import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useKeyboardShortcuts } from './useKeyboardShortcuts'

function press(key: string, opts: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent('keydown', { key, ...opts })
  window.dispatchEvent(event)
  return event
}

describe('useKeyboardShortcuts', () => {
  it('calls handler when combo matches', () => {
    const handler = vi.fn()
    renderHook(() =>
      useKeyboardShortcuts([{ combo: 'mod+k', handler, description: 'Test' }]),
    )
    press('k', { ctrlKey: true })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('does not call handler when combo does not match', () => {
    const handler = vi.fn()
    renderHook(() =>
      useKeyboardShortcuts([{ combo: 'mod+k', handler }]),
    )
    press('k') // no modifier
    expect(handler).not.toHaveBeenCalled()
  })

  it('normalises mod to both ctrl and meta', () => {
    const handler = vi.fn()
    renderHook(() =>
      useKeyboardShortcuts([{ combo: 'mod+1', handler }]),
    )
    press('1', { metaKey: true })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('skips handler when target is a textarea (unless allowInInput)', () => {
    const handler = vi.fn()
    renderHook(() =>
      useKeyboardShortcuts([{ combo: 'mod+k', handler }]),
    )
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()
    const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })
    Object.defineProperty(event, 'target', { value: textarea })
    window.dispatchEvent(event)
    expect(handler).not.toHaveBeenCalled()
    document.body.removeChild(textarea)
  })

  it('fires handler in textarea when allowInInput is true', () => {
    const handler = vi.fn()
    renderHook(() =>
      useKeyboardShortcuts([{ combo: 'escape', handler, allowInInput: true }]),
    )
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()
    const event = new KeyboardEvent('keydown', { key: 'Escape' })
    Object.defineProperty(event, 'target', { value: textarea })
    window.dispatchEvent(event)
    expect(handler).toHaveBeenCalledOnce()
    document.body.removeChild(textarea)
  })

  it('handles shift modifier', () => {
    const handler = vi.fn()
    renderHook(() =>
      useKeyboardShortcuts([{ combo: 'mod+shift+p', handler }]),
    )
    press('p', { ctrlKey: true, shiftKey: true })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('handles alt modifier', () => {
    const handler = vi.fn()
    renderHook(() =>
      useKeyboardShortcuts([{ combo: 'alt+w', handler }]),
    )
    press('w', { altKey: true })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('does not fire shortcuts during IME composition (isComposing)', () => {
    const handler = vi.fn()
    renderHook(() =>
      useKeyboardShortcuts([{ combo: 'escape', handler, allowInInput: true }]),
    )
    // A CJK IME cancelling its candidate window dispatches Escape with
    // isComposing=true — that press belongs to the IME, not the app. jsdom's
    // KeyboardEventInit doesn't reliably carry isComposing, so define it on
    // the instance (same trick as the target-override tests above).
    const event = new KeyboardEvent('keydown', { key: 'Escape' })
    Object.defineProperty(event, 'isComposing', { value: true })
    window.dispatchEvent(event)
    expect(handler).not.toHaveBeenCalled()
  })

  // Platform-fixed combos: the embedded terminal toggles on Ctrl+Backquote
  // on EVERY platform — Cmd+Backquote is macOS window cycling and must not
  // trigger it. `ctrl` therefore matches ctrlKey only, `meta` metaKey only,
  // while `mod` keeps accepting either.
  describe('distinct ctrl / meta modifiers', () => {
    it('ctrl+` fires on Ctrl+Backquote', () => {
      const handler = vi.fn()
      renderHook(() => useKeyboardShortcuts([{ combo: 'ctrl+`', handler }]))
      press('`', { ctrlKey: true })
      expect(handler).toHaveBeenCalledOnce()
    })

    it('ctrl+` does NOT fire on Cmd+Backquote (metaKey)', () => {
      const handler = vi.fn()
      renderHook(() => useKeyboardShortcuts([{ combo: 'ctrl+`', handler }]))
      press('`', { metaKey: true })
      expect(handler).not.toHaveBeenCalled()
    })

    it('mod+1 still fires on both the ctrl and the meta variant', () => {
      const handler = vi.fn()
      renderHook(() => useKeyboardShortcuts([{ combo: 'mod+1', handler }]))
      press('1', { ctrlKey: true })
      press('1', { metaKey: true })
      expect(handler).toHaveBeenCalledTimes(2)
    })

    it('ctrl+` fires while a textarea holds focus (allowInInput)', () => {
      const handler = vi.fn()
      renderHook(() => useKeyboardShortcuts([{ combo: 'ctrl+`', handler, allowInInput: true }]))
      const textarea = document.createElement('textarea')
      document.body.appendChild(textarea)
      textarea.focus()
      const event = new KeyboardEvent('keydown', { key: '`', ctrlKey: true })
      Object.defineProperty(event, 'target', { value: textarea })
      window.dispatchEvent(event)
      expect(handler).toHaveBeenCalledOnce()
      document.body.removeChild(textarea)
    })

    it('ctrl+` does not fire during IME composition (isComposing)', () => {
      const handler = vi.fn()
      renderHook(() => useKeyboardShortcuts([{ combo: 'ctrl+`', handler }]))
      const event = new KeyboardEvent('keydown', { key: '`', ctrlKey: true })
      Object.defineProperty(event, 'isComposing', { value: true })
      window.dispatchEvent(event)
      expect(handler).not.toHaveBeenCalled()
    })

    it('meta+k fires on meta only, not on ctrl', () => {
      const handler = vi.fn()
      renderHook(() => useKeyboardShortcuts([{ combo: 'meta+k', handler }]))
      press('k', { ctrlKey: true })
      expect(handler).not.toHaveBeenCalled()
      press('k', { metaKey: true })
      expect(handler).toHaveBeenCalledOnce()
    })

    it('mod+k still fires when both ctrl and meta are held', () => {
      const handler = vi.fn()
      renderHook(() => useKeyboardShortcuts([{ combo: 'mod+k', handler }]))
      press('k', { ctrlKey: true, metaKey: true })
      expect(handler).toHaveBeenCalledOnce()
    })
  })
})
