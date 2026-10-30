// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { prepareSessionMoveFlip, NAV_ITEM_ID_ATTR } from './flip'

// The break pinned here: a session reorder that animates only ONE of the two
// nav surfaces (sidebar cards / header-strip slots). The strip is a permanent
// header surface now (utils/nav-strip-mount), so a move shows on both surfaces
// at once — both must glide.

type Pt = { left: number; top: number }

function makeNavEl(keyAttr: string, id: string, at: Pt): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute(keyAttr, id)
  // Own mock per element: the shared prototype mock would merge call counts.
  Object.defineProperty(el, 'animate', {
    value: vi.fn(),
    writable: true,
    configurable: true,
  })
  moveEl(el, at)
  document.body.appendChild(el)
  return el
}

/** Bind (or re-bind) the element's rect — the test moves rows by swapping it. */
function moveEl(el: HTMLElement, at: Pt): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left: at.left,
    top: at.top,
    right: at.left,
    bottom: at.top,
    width: 0,
    height: 0,
    x: at.left,
    y: at.top,
    toJSON: () => ({}),
  } as DOMRect)
}

beforeEach(() => {
  // Deterministic gates: motion allowed, rAF synchronous (the play closures
  // then run inside the returned function, as they would a frame later).
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('prepareSessionMoveFlip', () => {
  it('glides both the sidebar card and the strip tab to their new slots', () => {
    const card = makeNavEl('data-session-card-id', 's1', { left: 0, top: 0 })
    const slot = makeNavEl(NAV_ITEM_ID_ATTR, 's1', { left: 0, top: 100 })

    const play = prepareSessionMoveFlip()
    moveEl(card, { left: 0, top: 200 })
    moveEl(slot, { left: 50, top: 100 })
    play()

    // Card: 0,0 → 0,200 ⇒ invert translate(0px, -200px)
    expect(card.animate).toHaveBeenCalledTimes(1)
    expect(card.animate).toHaveBeenCalledWith(
      [{ transform: 'translate(0px, -200px)' }, { transform: 'translate(0, 0)' }],
      { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' },
    )
    // Slot: 0,100 → 50,100 ⇒ invert translate(-50px, 0px)
    expect(slot.animate).toHaveBeenCalledTimes(1)
    expect(slot.animate).toHaveBeenCalledWith(
      [{ transform: 'translate(-50px, 0px)' }, { transform: 'translate(0, 0)' }],
      { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' },
    )
  })

  it('still glides the sidebar card when the strip is unmounted (mobile / custom-titlebar hosts)', () => {
    const card = makeNavEl('data-session-card-id', 's1', { left: 0, top: 0 })

    const play = prepareSessionMoveFlip()
    moveEl(card, { left: 0, top: 200 })
    play()

    expect(card.animate).toHaveBeenCalledTimes(1)
    expect(card.animate).toHaveBeenCalledWith(
      [{ transform: 'translate(0px, -200px)' }, { transform: 'translate(0, 0)' }],
      { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' },
    )
  })
})
