// @vitest-environment jsdom
// overlay-scrollbar.ts touches the real DOM (appendChild, MutationObserver,
// getComputedStyle), so it needs jsdom even though src/utils defaults to node.
import { describe, it, expect } from 'vitest'
import { attachOverlayScrollbar } from './overlay-scrollbar'

describe('attachOverlayScrollbar', () => {
  it('keeps the native-scrollbar hide across a React className rewrite and cleans up on destroy', () => {
    const parent = document.createElement('div')
    const el = document.createElement('div')
    parent.appendChild(el)

    const controller = attachOverlayScrollbar(el, { autoHide: 'never' })
    expect(el.hasAttribute('data-os-native-hidden')).toBe(true)

    // Simulate React rewriting className from its own template (e.g. the
    // sidebar's entrance class dropping after the stagger window). React
    // wholesale-replaces className on the element it owns, but never touches
    // data-* attributes it does not manage — so the hide survives without an
    // observer to re-assert it. (A class-based hide would be clobbered here,
    // which is the double-scrollbar bug this guards against.)
    el.className = 'session-list'
    expect(el.hasAttribute('data-os-native-hidden')).toBe(true)

    controller.destroy()
    expect(el.hasAttribute('data-os-native-hidden')).toBe(false)

    // No observer lingers to resurrect the hide after teardown.
    el.className = 'session-list'
    expect(el.hasAttribute('data-os-native-hidden')).toBe(false)
  })
})
