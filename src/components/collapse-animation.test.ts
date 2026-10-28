import { afterEach, describe, expect, it, vi } from 'vitest'
import {
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