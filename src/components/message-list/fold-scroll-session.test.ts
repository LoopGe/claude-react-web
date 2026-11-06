import { describe, expect, it } from 'vitest'
import {
  createFoldScrollSession,
  type FoldFrame,
  type FoldScrollSession,
} from './fold-scroll-session'

interface GeometryHarness {
  session: FoldScrollSession
  observe(update?: {
    contentDelta?: number
    itemListDelta?: number | null
    bodies?: FoldFrame['bodyHeights']
    itemListHeight?: number
    contentHeight?: number
    scrollTop?: number
    clientHeight?: number
    paddingDelta?: number
    devicePixelRatio?: number
  }): ReturnType<FoldScrollSession['sample']>
}

function geometryHarness(start: { from: number; to: number } = { from: 100, to: 100 }): GeometryHarness {
  const session = createFoldScrollSession({ token: 7, ...start })
  let bodies: FoldFrame['bodyHeights'] = new Map()
  let itemListHeight = 200
  let contentHeight = 200
  let previousItemListHeight: number | null = null
  let previousContentHeight = contentHeight
  let scrollTop = 100
  let clientHeight = 100
  let paddingDelta = 0
  let devicePixelRatio = 1

  return {
    session,
    observe(update = {}) {
      bodies = update.bodies ?? bodies
      itemListHeight = update.itemListHeight ?? itemListHeight
      contentHeight = update.contentHeight ?? contentHeight
      scrollTop = update.scrollTop ?? scrollTop
      clientHeight = update.clientHeight ?? clientHeight
      paddingDelta = update.paddingDelta ?? 0
      devicePixelRatio = update.devicePixelRatio ?? devicePixelRatio
      const frame: FoldFrame = {
        bodyHeights: bodies,
        itemListDelta: update.itemListDelta === undefined
          ? previousItemListHeight === null ? null : itemListHeight - previousItemListHeight
          : update.itemListDelta,
        contentDelta: update.contentDelta ?? contentHeight - previousContentHeight,
        paddingDelta,
        itemListHeight,
        contentHeight,
        scrollTop,
        scrollHeight: contentHeight,
        clientHeight,
        devicePixelRatio,
      }
      previousItemListHeight = itemListHeight
      previousContentHeight = contentHeight
      return session.sample(frame)
    },
  }
}

const bodyElements = new Map<string, HTMLElement>()

function bodies(...entries: Array<[string, number]>): FoldFrame['bodyHeights'] {
  return new Map(entries.map(([id, height]) => {
    let element = bodyElements.get(id)
    if (!element) {
      element = { id } as unknown as HTMLElement
      bodyElements.set(id, element)
    }
    return [element, height]
  }))
}

describe('fold scroll session', () => {
  it('seeds an initial growth delta from the DOM scroll position', () => {
    const harness = geometryHarness({ from: 100, to: 800 })

    expect(harness.observe({
      bodies: bodies(['a', 100]),
      itemListDelta: 2,
      contentDelta: 0,
      contentHeight: 1000,
    })).toEqual({ kind: 'delta', delta: 2, ledger: 102, transform: 0 })
  })

  it('seeds an initial shrink delta from the browser-clamped DOM position without reapplying shrink', () => {
    const harness = geometryHarness({ from: 100, to: 800 })

    expect(harness.observe({
      bodies: bodies(['a', 100]),
      itemListDelta: -2,
      contentDelta: 0,
      contentHeight: 1000,
    })).toEqual({ kind: 'delta', delta: -2, ledger: 100, transform: 0 })
  })

  it('reconciles absolute alignment to the actual DOM readback before the next delta', () => {
    const harness = geometryHarness()
    expect(harness.observe({
      bodies: bodies(['a', 100]),
      contentHeight: 200.25,
    })).toEqual({ kind: 'absolute-bottom', reason: 'new-body' })

    harness.session.reconcileAbsolute(100)

    expect(harness.observe({
      bodies: bodies(['a', 100.5]),
      itemListHeight: 200.75,
      contentHeight: 200.75,
    })).toEqual({ kind: 'delta', delta: 0.5, ledger: 100.5, transform: 0.5 })
  })

  it('absolutely aligns a new body, then carries fractional growth in the ledger', () => {
    const harness = geometryHarness()
    const body = bodies(['a', 100])

    expect(harness.observe({ bodies: body })).toEqual({ kind: 'absolute-bottom', reason: 'new-body' })
    expect(harness.observe({
      bodies: bodies(['a', 100.5]),
      itemListHeight: 200.5,
      contentHeight: 200.5,
    })).toEqual({ kind: 'delta', delta: 0.5, ledger: 100.5, transform: 0.5 })
  })

  it('absolutely aligns padding growth instead of adding it to the fold ledger', () => {
    const harness = geometryHarness()
    harness.observe({ bodies: bodies(['a', 100]) })

    expect(harness.observe({
      bodies: bodies(['a', 100]),
      itemListHeight: 220,
      contentHeight: 220,
      paddingDelta: 20,
    })).toEqual({ kind: 'absolute-bottom', reason: 'other-growth' })
  })

  it('realigns when another body joins a consecutive fold', () => {
    const harness = geometryHarness()
    const first = bodies(['a', 100])
    harness.observe({ bodies: first })
    harness.observe({ bodies: bodies(['a', 101]), itemListHeight: 201, contentHeight: 201 })

    expect(harness.observe({
      bodies: bodies(['a', 101], ['b', 40]),
      itemListHeight: 241,
      contentHeight: 241,
    })).toEqual({ kind: 'absolute-bottom', reason: 'other-growth' })
  })

  it('accumulates sub-pixel non-fold growth until it warrants absolute alignment', () => {
    const harness = geometryHarness()
    harness.observe({ bodies: bodies(['a', 100]) })
    harness.observe({ bodies: bodies(['a', 101]), itemListHeight: 201, contentHeight: 201 })

    expect(harness.observe({
      bodies: bodies(['a', 101]),
      itemListHeight: 201.8,
      contentHeight: 201.8,
    })).toEqual({ kind: 'delta', delta: 0, ledger: 101, transform: 0 })
    expect(harness.observe({
      bodies: bodies(['a', 101]),
      itemListHeight: 202.6,
      contentHeight: 202.6,
    })).toEqual({ kind: 'absolute-bottom', reason: 'other-growth' })
  })

  it('honours an explicit pending alignment on the next sample', () => {
    const harness = geometryHarness()
    harness.observe({ bodies: bodies(['a', 100]) })
    harness.session.requestAbsoluteBottom()

    expect(harness.observe({ bodies: bodies(['a', 100]) })).toEqual({
      kind: 'absolute-bottom',
      reason: 'pending',
    })
  })

  it('clears accumulated non-fold residual when pending alignment runs', () => {
    const harness = geometryHarness()
    harness.observe({ bodies: bodies(['a', 100]) })
    harness.session.reconcileAbsolute(100)
    expect(harness.observe({
      bodies: bodies(['a', 100]),
      contentHeight: 200.8,
    })).toEqual({ kind: 'delta', delta: 0, ledger: 100, transform: 0 })

    harness.session.requestAbsoluteBottom()
    expect(harness.observe({ bodies: bodies(['a', 100]) })).toEqual({
      kind: 'absolute-bottom',
      reason: 'pending',
    })
    harness.session.reconcileAbsolute(100)

    expect(harness.observe({
      bodies: bodies(['a', 100]),
      contentHeight: 201.6,
    })).toEqual({ kind: 'delta', delta: 0, ledger: 100, transform: 0 })
  })

  it('snaps the scroll half to device pixels and leaves the remainder in the transform', () => {
    const harness = geometryHarness()
    harness.observe({ bodies: bodies(['a', 100]) })

    const result = harness.observe({
      bodies: bodies(['a', 100.5]),
      itemListHeight: 200.5,
      contentHeight: 200.5,
      devicePixelRatio: 1.5,
    })

    expect(result).toMatchObject({ kind: 'delta', delta: 0.5, ledger: 100.5 })
    expect(result.kind === 'delta' && result.transform).toBeCloseTo(1 / 6, 12)
  })

  it('continues the ledger across a shrink after absolute alignment', () => {
    const harness = geometryHarness()
    harness.observe({ bodies: bodies(['a', 100]) })
    harness.observe({ bodies: bodies(['a', 101]), itemListHeight: 201, contentHeight: 201 })
    harness.session.requestAbsoluteBottom()
    harness.observe({ bodies: bodies(['a', 101]) })

    const result = harness.observe({
      bodies: bodies(['a', 96]),
      itemListHeight: 196,
      contentHeight: 196,
      scrollTop: 96,
    })

    expect(result).toEqual({ kind: 'delta', delta: -5, ledger: 96, transform: 0 })
  })
})
