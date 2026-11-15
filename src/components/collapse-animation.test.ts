import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  anyCollapseAnimatingInside,
  anyCollapseMotionInside,
  bodyHeightDelta,
  claimCollapseMotionInside,
  currentBodyHeight,
  releaseAncestorCollapsePins,
  setCollapseAnimating,
  snapshotBodyHeights,
} from './collapse-animation'

/** Build `depth` nested collapse bodies, the shape AnimatedCollapse renders:
 *  body(.animated-collapse) > .animated-collapse-content > body(…) …
 *  Outermost first, so the LAST entry is the body that animates and every
 *  earlier one is an ancestor of it. */
function nest(depth: number): HTMLElement[] {
  const bodies: HTMLElement[] = []
  let parent = document.createElement('div')
  for (let i = 0; i < depth; i++) {
    const body = document.createElement('div')
    body.className = 'animated-collapse'
    const content = document.createElement('div')
    content.className = 'animated-collapse-content'
    body.appendChild(content)
    parent.appendChild(body)
    parent = content
    bodies.push(body)
  }
  created.push(...bodies)
  return bodies
}

/** The registry is module state holding live elements — every body a test
 *  created must be unregistered, and the trees here are detached (so they can
 *  never be found by a document query). */
const created: HTMLElement[] = []

afterEach(() => {
  for (const body of created) setCollapseAnimating(body, false)
  created.length = 0
  vi.restoreAllMocks()
})

describe('releaseAncestorCollapsePins', () => {
  it('clears the pin of a settled open ancestor', () => {
    const [outer, animating] = nest(2)
    outer.style.height = '722px'

    releaseAncestorCollapsePins(animating)

    expect(outer.style.height).toBe('')
  })

  it('leaves a folded (0px-pinned) ancestor alone', () => {
    // A search-forced result row can open inside a folded group: releasing the
    // group's 0px pin there would spill the folded card open.
    const [outer, animating] = nest(2)
    outer.style.height = '0px'

    releaseAncestorCollapsePins(animating)

    expect(outer.style.height).toBe('0px')
  })

  it('leaves an ancestor that is animating alone', () => {
    // Its own tween owns that pin (it rewrites the height every frame).
    const [outer, animating] = nest(2)
    outer.style.height = '300px'
    setCollapseAnimating(outer, true)

    releaseAncestorCollapsePins(animating)

    expect(outer.style.height).toBe('300px')
  })

  it('stops at a folded ancestor instead of releasing the pins above it', () => {
    // The middle body is folded (0px), so everything inside it is clipped: the
    // content above cannot move and there is nothing to relay. Walking PAST it
    // would un-pin an unrelated card's body for no reason.
    const [outer, middle, animating] = nest(3)
    outer.style.height = '500px'
    middle.style.height = '0px'

    releaseAncestorCollapsePins(animating)

    expect(middle.style.height).toBe('0px')
    expect(outer.style.height).toBe('500px')
  })
})

describe('currentBodyHeight', () => {
  it('keeps the pin when the used box agrees with it (fractional pin survives)', () => {
    // The pin is what the device-px tween wrote (fractional CSS px at
    // fractional dpr); offsetHeight rounds it away. The pin must win or the
    // fold-lockstep's delta signal quantizes to ±0.5px per frame.
    const body = document.createElement('div')
    body.style.height = '246.667px'
    vi.spyOn(body, 'offsetHeight', 'get').mockReturnValue(247)

    expect(currentBodyHeight(body)).toBeCloseTo(246.667, 3)
  })

  it('falls back to the used box when the pin is a clamping fiction', () => {
    // A flex-clamped body (the chat-bottom-stack shape): the pin tweens but
    // the ancestor's box governs, and the cards below move with the BOX.
    const body = document.createElement('div')
    body.style.height = '400px'
    vi.spyOn(body, 'offsetHeight', 'get').mockReturnValue(250)

    expect(currentBodyHeight(body)).toBe(250)
  })

  it('reads the used box for an un-pinned body', () => {
    const body = document.createElement('div')
    vi.spyOn(body, 'offsetHeight', 'get').mockReturnValue(80)

    expect(currentBodyHeight(body)).toBe(80)
  })
})

describe('bodyHeightDelta', () => {
  it('returns null when the previous snapshot belongs only to an earlier fold', () => {
    const [previous] = nest(1)
    const [current] = nest(1)
    const prev = new Map([[previous, 0]])
    const snap = new Map([[current, 14]])

    expect(bodyHeightDelta(prev, snap)).toBeNull()
  })

  it('returns null when a new body joins an already animating snapshot', () => {
    const [shared] = nest(1)
    const [current] = nest(1)

    expect(bodyHeightDelta(
      new Map([[shared, 10]]),
      new Map([[shared, 12], [current, 20]]),
    )).toBeNull()
  })

  it('sums changes only for bodies present in both snapshots', () => {
    const [shared] = nest(1)
    const [previous] = nest(1)

    expect(bodyHeightDelta(
      new Map([[shared, 10], [previous, 0]]),
      new Map([[shared, 24]]),
    )).toBe(14)
  })
})

describe('snapshotBodyHeights', () => {
  it('reports the fractional pin of animating bodies', () => {
    const [body] = nest(1)
    document.body.appendChild(body)
    body.style.height = '55.333px'
    vi.spyOn(body, 'offsetHeight', 'get').mockReturnValue(55)
    setCollapseAnimating(body, true)

    const snap = snapshotBodyHeights(document.body)

    expect(snap.get(body)).toBeCloseTo(55.333, 3)
    setCollapseAnimating(body, false)
    body.remove()
  })
})

describe('anyCollapseAnimatingInside (strict)', () => {
  it('reports a body while it is registered and clears the moment it settles', () => {
    // Strict on purpose: AnimatedCollapse's ancestor observer re-pins from the
    // settle's own tail delivery, so the settle must NOT read as animating.
    const [body] = nest(1)
    document.body.appendChild(body)
    setCollapseAnimating(body, true)
    expect(anyCollapseAnimatingInside(document.body)).toBe(true)

    setCollapseAnimating(body, false)
    expect(anyCollapseAnimatingInside(document.body)).toBe(false)

    claimCollapseMotionInside(document.body)
    body.remove()
  })
})

describe('anyCollapseMotionInside (pacing probe)', () => {
  it('reports a body while it is registered', () => {
    const [body] = nest(1)
    document.body.appendChild(body)
    setCollapseAnimating(body, true)

    expect(anyCollapseMotionInside(document.body)).toBe(true)

    setCollapseAnimating(body, false)
    claimCollapseMotionInside(document.body)
    body.remove()
  })

  it('keeps reporting through the settle-tail delivery, then clears once claimed', () => {
    // The final size's ResizeObserver observation lands one rendering step
    // after the settle write. The scroll machinery paces itself off this
    // probe (fold owner, sampleFold, verify stand-down, fold-lockstep gate),
    // so a body that just settled — including the motion-off SNAP path,
    // which never registers but still settles through finishOpen/finishClosed
    // — must read as motion until that delivery is claimed.
    const [body] = nest(1)
    document.body.appendChild(body)
    setCollapseAnimating(body, true)
    setCollapseAnimating(body, false)

    expect(anyCollapseMotionInside(document.body)).toBe(true)

    // The measurement site claims the latch (one stand-down per settle)…
    expect(claimCollapseMotionInside(document.body)).toBe(true)
    // …and the probe is quiet again for any later genuine change.
    expect(anyCollapseMotionInside(document.body)).toBe(false)

    body.remove()
  })

  it('does not report a settled body outside the queried root', () => {
    const [inside] = nest(1)
    const [outside] = nest(1)
    document.body.appendChild(inside)
    setCollapseAnimating(inside, true)
    setCollapseAnimating(inside, false)
    setCollapseAnimating(outside, true)
    setCollapseAnimating(outside, false)

    const otherRoot = document.createElement('div')
    document.body.appendChild(otherRoot)
    expect(anyCollapseMotionInside(otherRoot)).toBe(false)
    expect(anyCollapseMotionInside(document.body)).toBe(true)

    claimCollapseMotionInside(document.body)
    inside.remove()
    outside.remove()
    otherRoot.remove()
  })
})
