// scrollNavShortcuts: the Alt+↑ / Alt+↓ (previous / next USER message) and
// Ctrl/⌘+↑ / ↓ (previous / next TURN-FINAL assistant message) shortcut
// entries that drive the focused panel's transcript.
//
// These tests run against the REAL useKeyboardShortcuts dispatcher and the
// REAL createCallbackRegistry — only the ScrollNavigator itself is a test
// double, because the real one lives inside MessageList and is covered by
// MessageList.test.tsx. The unit under test here is the routing: combo
// spelling, focused-session gate, registry lookup, direction mapping, and
// allowInInput.
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts'
import { scrollNavShortcuts } from './scroll-nav-shortcuts'
import { createCallbackRegistry } from '../utils/callbackRegistry'
import type { ScrollNavigator } from '../components/MessageList'

function press(key: string, opts: Partial<KeyboardEventInit> = {}) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, ...opts }))
}

function fakeNav(): ScrollNavigator {
  return {
    prev: vi.fn(),
    next: vi.fn(),
    prevTurn: vi.fn(),
    nextTurn: vi.fn(),
    to: vi.fn(),
    toBottom: vi.fn(),
  }
}

/** Mount the dispatcher with entries built for `focusedId`, mirroring how
 *  App passes the value into its shortcuts useMemo. Returns the live
 *  registry so tests can register navigators after mounting. */
function setup(focusedId: string | null) {
  const registry = createCallbackRegistry<ScrollNavigator>()
  renderHook(
    (fid: string | null) => useKeyboardShortcuts(scrollNavShortcuts(registry, fid)),
    { initialProps: focusedId },
  )
  return registry
}

describe('scrollNavShortcuts', () => {
  it('alt+arrowup calls prev() on the focused session’s navigator', () => {
    const nav = fakeNav()
    const registry = setup('s1')
    registry.register('s1', nav)
    press('ArrowUp', { altKey: true })
    expect(nav.prev).toHaveBeenCalledOnce()
    expect(nav.next).not.toHaveBeenCalled()
  })

  it('alt+arrowdown calls next() on the focused session’s navigator', () => {
    const nav = fakeNav()
    const registry = setup('s1')
    registry.register('s1', nav)
    press('ArrowDown', { altKey: true })
    expect(nav.next).toHaveBeenCalledOnce()
    expect(nav.prev).not.toHaveBeenCalled()
  })

  it('fires while a textarea holds focus (allowInInput)', () => {
    const nav = fakeNav()
    const registry = setup('s1')
    registry.register('s1', nav)
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()
    const event = new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true })
    Object.defineProperty(event, 'target', { value: textarea })
    window.dispatchEvent(event)
    expect(nav.prev).toHaveBeenCalledOnce()
    document.body.removeChild(textarea)
  })

  it('does nothing when no session is focused', () => {
    const nav = fakeNav()
    const registry = setup(null)
    registry.register('s1', nav)
    press('ArrowUp', { altKey: true })
    press('ArrowDown', { altKey: true })
    expect(nav.prev).not.toHaveBeenCalled()
    expect(nav.next).not.toHaveBeenCalled()
  })

  it('does nothing when the focused session has no registered navigator', () => {
    const nav = fakeNav()
    const registry = setup('other')
    registry.register('s1', nav)
    press('ArrowUp', { altKey: true })
    expect(nav.prev).not.toHaveBeenCalled()
  })

  it('does not match alt+shift+arrows (the sidebar group-move combos)', () => {
    const nav = fakeNav()
    const registry = setup('s1')
    registry.register('s1', nav)
    press('ArrowUp', { altKey: true, shiftKey: true })
    press('ArrowDown', { altKey: true, shiftKey: true })
    expect(nav.prev).not.toHaveBeenCalled()
    expect(nav.next).not.toHaveBeenCalled()
  })

  it('resolves the navigator at event time, not at mount', () => {
    const nav = fakeNav()
    const registry = setup('s1')
    // Registered AFTER the shortcuts were mounted — the handler reads the
    // registry when the key lands, so a panel that mounts (and registers)
    // later than the shortcut list is still routed to.
    registry.register('s1', nav)
    press('ArrowUp', { altKey: true })
    expect(nav.prev).toHaveBeenCalledOnce()
  })

  it('routes to the newly focused session after App-style re-render', () => {
    const navA = fakeNav()
    const navB = fakeNav()
    const registry = createCallbackRegistry<ScrollNavigator>()
    // focusedId is a value baked into the entries, so App rebuilds them on
    // a focus change (it is a useMemo dep) — modeled here by rerendering
    // with a new prop, exactly like App re-renders on setFocusedId.
    const { rerender } = renderHook(
      (fid: string | null) => useKeyboardShortcuts(scrollNavShortcuts(registry, fid)),
      { initialProps: 'a' as string | null },
    )
    registry.register('a', navA)
    registry.register('b', navB)
    rerender('b')
    press('ArrowUp', { altKey: true })
    expect(navA.prev).not.toHaveBeenCalled()
    expect(navB.prev).toHaveBeenCalledOnce()
  })

  it('mod+arrowup (ctrl) calls prevTurn() on the focused session’s navigator', () => {
    const nav = fakeNav()
    const registry = setup('s1')
    registry.register('s1', nav)
    press('ArrowUp', { ctrlKey: true })
    expect(nav.prevTurn).toHaveBeenCalledOnce()
    expect(nav.prev).not.toHaveBeenCalled()
  })

  it('mod+arrowdown (meta) calls nextTurn() on the focused session’s navigator', () => {
    const nav = fakeNav()
    const registry = setup('s1')
    registry.register('s1', nav)
    // metaKey, not ctrlKey: 'mod' maps to Cmd on macOS, and this pair must
    // fire under both spellings like every other mod combo.
    press('ArrowDown', { metaKey: true })
    expect(nav.nextTurn).toHaveBeenCalledOnce()
    expect(nav.next).not.toHaveBeenCalled()
  })

  it('mod+arrows fire while a textarea holds focus (allowInInput)', () => {
    const nav = fakeNav()
    const registry = setup('s1')
    registry.register('s1', nav)
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()
    const event = new KeyboardEvent('keydown', { key: 'ArrowUp', ctrlKey: true })
    Object.defineProperty(event, 'target', { value: textarea })
    window.dispatchEvent(event)
    expect(nav.prevTurn).toHaveBeenCalledOnce()
    document.body.removeChild(textarea)
  })

  it('plain arrows fire nothing (no modifier is not a combo)', () => {
    const nav = fakeNav()
    const registry = setup('s1')
    registry.register('s1', nav)
    press('ArrowUp')
    press('ArrowDown')
    expect(nav.prev).not.toHaveBeenCalled()
    expect(nav.next).not.toHaveBeenCalled()
    expect(nav.prevTurn).not.toHaveBeenCalled()
    expect(nav.nextTurn).not.toHaveBeenCalled()
  })
})
