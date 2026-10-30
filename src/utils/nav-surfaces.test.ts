// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { navSurfaceEls } from './nav-surfaces'
import { NAV_ITEM_ID_ATTR } from './flip'

// The break pinned here: a session swap (X→Y) animating only ONE nav surface
// (the sidebar card) while the header-strip slot hard-cuts. Both surfaces show
// the same list at once now (utils/nav-strip-mount) — every session mutation
// must treat both rows alike.

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  document.body.innerHTML = ''
})

function el(attrs: Record<string, string>): HTMLElement {
  const node = document.createElement('div')
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  document.body.appendChild(node)
  return node
}

describe('navSurfaceEls', () => {
  it('returns both the sidebar card and the strip slot for a session', () => {
    const card = el({ 'data-session-card-id': 's1' })
    const slot = el({ [NAV_ITEM_ID_ATTR]: 's1' })
    el({ [NAV_ITEM_ID_ATTR]: 'g1' }) // group chip — different business id

    expect(navSurfaceEls('s1')).toEqual([card, slot])
  })

  it('returns just the card when the strip is unmounted (mobile / custom-titlebar hosts)', () => {
    const card = el({ 'data-session-card-id': 's1' })

    expect(navSurfaceEls('s1')).toEqual([card])
  })
})
