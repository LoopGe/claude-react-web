import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VirtuosoHandle } from 'react-virtuoso'
import { setCollapseAnimating } from '../collapse-animation'
import {
  createInitialScrollState,
  reduceScroll,
  type ScrollEvent,
  type ScrollState,
  type WorkRequest,
} from './transcript-scroll-machine'
import {
  createTranscriptScrollWriter,
  type ScrollScheduler,
} from './transcript-scroll-writer'
import type { FoldFrame } from './fold-scroll-session'

interface ScheduledTimeout {
  callback: () => void
  ms: number
}

class FakeScheduler implements ScrollScheduler {
  private nextId = 1
  private readonly frames = new Map<number, () => void>()
  private readonly timeouts = new Map<number, ScheduledTimeout>()
  readonly frameCallbacks = new Map<number, () => void>()
  readonly timeoutCallbacks = new Map<number, ScheduledTimeout>()

  raf(callback: () => void): number {
    const id = this.nextId++
    this.frames.set(id, callback)
    this.frameCallbacks.set(id, callback)
    return id
  }

  cancelRaf(id: number): void {
    this.frames.delete(id)
  }

  timeout(callback: () => void, ms: number): number {
    const id = this.nextId++
    this.timeouts.set(id, { callback, ms })
    this.timeoutCallbacks.set(id, { callback, ms })
    return id
  }

  clearTimeout(id: number): void {
    this.timeouts.delete(id)
  }

  get pendingFrames(): number {
    return this.frames.size
  }

  get pendingTimeouts(): number {
    return this.timeouts.size
  }

  get lastTimeout(): ScheduledTimeout | undefined {
    return [...this.timeouts.values()].at(-1)
  }

  flushFrames(): void {
    const callbacks = [...this.frames.values()]
    this.frames.clear()
    for (const callback of callbacks) callback()
  }

  flushTimeouts(): void {
    const callbacks = [...this.timeouts.values()]
    this.timeouts.clear()
    for (const { callback } of callbacks) callback()
  }
}

function makeScroller(scrollHeight = 1000, clientHeight = 200) {
  const element = document.createElement('div')
  const itemList = document.createElement('div')
  itemList.dataset.testid = 'virtuoso-item-list'
  element.append(itemList)
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: scrollHeight },
    clientHeight: { configurable: true, value: clientHeight },
  })
  const scrollTo = vi.fn((optionsOrX?: ScrollToOptions | number, _y?: number) => {
    if (typeof optionsOrX === 'object' && typeof optionsOrX.top === 'number') {
      element.scrollTop = optionsOrX.top
    }
  })
  element.scrollTo = scrollTo
  document.body.append(element)
  return { element, itemList, scrollTo }
}

function makeVirtuoso() {
  const scrollToIndex = vi.fn()
  const virtuoso = { scrollToIndex } as unknown as VirtuosoHandle
  return { virtuoso, scrollToIndex }
}

function work(kind: WorkRequest['kind'], id = 9): WorkRequest {
  return { id, kind, delivery: 'after-owner' }
}

function foldFrame(
  element: HTMLElement,
  body: HTMLElement,
  bodyHeight: number,
  overrides: Partial<FoldFrame> = {},
): FoldFrame {
  return {
    bodyHeights: new Map([[body, bodyHeight]]),
    itemListDelta: null,
    contentDelta: 0,
    paddingDelta: 0,
    itemListHeight: bodyHeight,
    contentHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    devicePixelRatio: 1,
    ...overrides,
  }
}

function makeSeekLifecycle(clientHeight = 200) {
  const scheduler = new FakeScheduler()
  const scroller = makeScroller(4000, clientHeight)
  const { virtuoso, scrollToIndex } = makeVirtuoso()
  let state: ScrollState = createInitialScrollState(1)
  function dispatch(event: ScrollEvent): void {
    const transition = reduceScroll(state, event)
    state = transition.state
    writer.execute(transition.commands)
  }
  const writer = createTranscriptScrollWriter({
    scheduler,
    virtuoso,
    onSeekEaseLanded: (token) => dispatch({ type: 'SEEK_EASE_LANDED', token }),
    onOwnerLanded: (token) => dispatch({ type: 'OWNER_LANDED', token }),
  })
  writer.attach(scroller.element)
  dispatch({ type: 'ELEMENT_ATTACHED', element: scroller.element })
  dispatch({ type: 'SEEK_REQUESTED', index: 12, align: 'start' })
  return {
    scheduler,
    virtuoso,
    scrollToIndex,
    dispatch,
    state: () => state,
    ...scroller,
  }
}

const animatingBodies = new Set<HTMLElement>()
afterEach(() => {
  for (const body of animatingBodies) setCollapseAnimating(body, false)
  animatingBodies.clear()
  document.body.replaceChildren()
})

describe('transcript scroll writer commands', () => {
  it('writes the absolute bottom immediately', () => {
    const scheduler = new FakeScheduler()
    const { element } = makeScroller()
    const writer = createTranscriptScrollWriter({ scheduler })
    writer.attach(element)
    element.scrollTop = 40

    writer.execute([{ type: 'WRITE_ABSOLUTE_BOTTOM', epoch: 3, workId: 2, kind: 'absolute-bottom' }])

    expect(element.scrollTop).toBe(1000)
    expect(scheduler.pendingFrames).toBe(0)
  })

  it('publishes following and seek activity onto the attached element', () => {
    const scheduler = new FakeScheduler()
    const { element } = makeScroller()
    const writer = createTranscriptScrollWriter({ scheduler })
    writer.attach(element)

    writer.execute([
      { type: 'PUBLISH_FOLLOWING', epoch: 1, following: false },
      { type: 'PUBLISH_SEEK_STATE', epoch: 1, seekState: 'ease' },
    ])
    expect(element.dataset.following).toBe('false')
    expect(element.dataset.crwSeekActive).toBe('true')

    writer.execute([
      { type: 'PUBLISH_FOLLOWING', epoch: 1, following: true },
      { type: 'PUBLISH_SEEK_STATE', epoch: 1, seekState: 'hold' },
    ])
    expect(element.dataset.following).toBe('true')
    expect(element.dataset.crwSeekActive).toBe('true')

    writer.execute([{ type: 'PUBLISH_SEEK_STATE', epoch: 1, seekState: 'idle' }])
    expect(element.dataset.crwSeekActive).toBeUndefined()
  })

  it('eases follow toward a freshly measured bottom on every frame', () => {
    const scheduler = new FakeScheduler()
    const { element, scrollTo } = makeScroller()
    const writer = createTranscriptScrollWriter({ scheduler })
    writer.attach(element)

    writer.execute([{ type: 'START_FOLLOW', epoch: 1, token: 4 }])
    scheduler.flushFrames()
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 200, behavior: 'auto' })

    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 1400 })
    scheduler.flushFrames()
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 450, behavior: 'auto' })
  })

  it('restores an arbitrary target and holds it through scheduled frames', () => {
    const scheduler = new FakeScheduler()
    const { element, scrollTo } = makeScroller()
    const writer = createTranscriptScrollWriter({ scheduler })
    writer.attach(element)

    writer.execute([{ type: 'START_RESTORE', epoch: 2, token: 8, target: 317 }])
    expect(element.scrollTop).toBe(317)
    scheduler.flushFrames()
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 317, behavior: 'auto' })
  })
})

describe('single-owner cancellation and stale callbacks', () => {
  it('lets only the newest continuous owner write, even when an old callback runs', () => {
    const scheduler = new FakeScheduler()
    const { element, scrollTo } = makeScroller()
    const writer = createTranscriptScrollWriter({ scheduler })
    writer.attach(element)

    writer.execute([{ type: 'START_FOLLOW', epoch: 1, token: 1 }])
    const oldFollow = scheduler.frameCallbacks.get(1)!
    writer.execute([{ type: 'START_RESTORE', epoch: 1, token: 2, target: 275 }])
    expect(scheduler.pendingFrames).toBe(1)
    scrollTo.mockClear()
    element.scrollTop = 275

    oldFollow()

    expect(scrollTo).not.toHaveBeenCalled()
    expect(element.scrollTop).toBe(275)
  })

  it('rejects a captured rAF after owner cancellation', () => {
    const scheduler = new FakeScheduler()
    const { element, scrollTo } = makeScroller()
    const writer = createTranscriptScrollWriter({ scheduler })
    writer.attach(element)
    writer.execute([{ type: 'START_FOLLOW', epoch: 1, token: 1 }])
    const captured = scheduler.frameCallbacks.get(1)!

    writer.execute([{ type: 'CANCEL_OWNER', epoch: 1, token: 1 }])
    captured()

    expect(scrollTo).not.toHaveBeenCalled()
    expect(scheduler.pendingFrames).toBe(0)
  })

  it('cancels rAF and rejects its captured callback on detach', () => {
    const scheduler = new FakeScheduler()
    const { element, scrollTo } = makeScroller()
    const writer = createTranscriptScrollWriter({ scheduler })
    writer.attach(element)
    writer.execute([{ type: 'START_FOLLOW', epoch: 1, token: 1 }])
    const captured = scheduler.frameCallbacks.get(1)!

    writer.attach(null)
    captured()

    expect(scheduler.pendingFrames).toBe(0)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('cancels rAF and rejects its captured callback on dispose', () => {
    const scheduler = new FakeScheduler()
    const { element, scrollTo } = makeScroller()
    const writer = createTranscriptScrollWriter({ scheduler })
    writer.attach(element)
    writer.execute([{ type: 'START_FOLLOW', epoch: 1, token: 1 }])
    const captured = scheduler.frameCallbacks.get(1)!

    writer.dispose()
    captured()
    writer.execute([{ type: 'WRITE_ABSOLUTE_BOTTOM', epoch: 1, workId: 3, kind: 'verify' }])

    expect(scheduler.pendingFrames).toBe(0)
    expect(scrollTo).not.toHaveBeenCalled()
    expect(element.scrollTop).toBe(0)
  })

  it('invalidates old-epoch callbacks and commands when a newer epoch arrives', () => {
    const scheduler = new FakeScheduler()
    const { element, scrollTo } = makeScroller()
    const writer = createTranscriptScrollWriter({ scheduler })
    writer.attach(element)
    writer.execute([{ type: 'START_FOLLOW', epoch: 4, token: 1 }])
    const captured = scheduler.frameCallbacks.get(1)!

    writer.execute([{ type: 'START_RESTORE', epoch: 5, token: 1, target: 90 }])
    captured()
    expect(scrollTo).not.toHaveBeenCalled()

    const replacement = makeScroller()
    writer.attach(replacement.element)
    replacement.element.scrollTop = 20
    writer.execute([{ type: 'WRITE_ABSOLUTE_BOTTOM', epoch: 4, workId: 2, kind: 'verify' }])
    expect(replacement.element.scrollTop).toBe(20)
  })
})

describe('work scheduling', () => {
  it('runs a trailing correction through the scheduler timeout', () => {
    const scheduler = new FakeScheduler()
    const { element } = makeScroller()
    const onWorkConsumed = vi.fn()
    const writer = createTranscriptScrollWriter({ scheduler, onWorkConsumed })
    writer.attach(element)

    writer.execute([{ type: 'SCHEDULE_WORK', epoch: 1, work: work('trailing-micro') }])

    expect(scheduler.lastTimeout?.ms).toBe(250)
    expect(element.scrollTop).toBe(0)
    scheduler.flushTimeouts()
    expect(element.scrollTop).toBe(1000)
    expect(onWorkConsumed).toHaveBeenCalledExactlyOnceWith(9)
  })

  it('rejects a captured timeout after work cancellation', () => {
    const scheduler = new FakeScheduler()
    const { element } = makeScroller()
    const writer = createTranscriptScrollWriter({ scheduler })
    writer.attach(element)
    writer.execute([{ type: 'SCHEDULE_WORK', epoch: 1, work: work('trailing-micro') }])
    const captured = scheduler.timeoutCallbacks.get(1)!.callback

    writer.execute([{ type: 'CANCEL_WORK', epoch: 1, id: 9 }])
    captured()

    expect(scheduler.pendingTimeouts).toBe(0)
    expect(element.scrollTop).toBe(0)
  })

  it.each(['detach', 'dispose', 'epoch'] as const)('rejects a captured timeout after %s', (invalidation) => {
    const scheduler = new FakeScheduler()
    const { element } = makeScroller()
    const writer = createTranscriptScrollWriter({ scheduler })
    writer.attach(element)
    writer.execute([{ type: 'SCHEDULE_WORK', epoch: 1, work: work('trailing-micro') }])
    const captured = scheduler.timeoutCallbacks.get(1)!.callback

    if (invalidation === 'detach') writer.attach(null)
    if (invalidation === 'dispose') writer.dispose()
    if (invalidation === 'epoch') {
      writer.execute([{ type: 'PUBLISH_FOLLOWING', epoch: 2, following: true }])
    }
    captured()

    expect(scheduler.pendingTimeouts).toBe(0)
    expect(element.scrollTop).toBe(0)
  })

  it('consumes a trailing correction without writing when live geometry is already within epsilon', () => {
    const scheduler = new FakeScheduler()
    const { element } = makeScroller()
    element.scrollTop = 999
    const onWorkConsumed = vi.fn()
    const writer = createTranscriptScrollWriter({ scheduler, onWorkConsumed })
    writer.attach(element)
    writer.execute([{ type: 'SCHEDULE_WORK', epoch: 1, work: work('trailing-micro') }])

    scheduler.flushTimeouts()

    expect(element.scrollTop).toBe(999)
    expect(onWorkConsumed).toHaveBeenCalledExactlyOnceWith(9)
  })

  it('consumes a trailing correction without writing on a hidden scroller', () => {
    const scheduler = new FakeScheduler()
    const { element } = makeScroller(1000, 0)
    const onWorkConsumed = vi.fn()
    const writer = createTranscriptScrollWriter({ scheduler, onWorkConsumed })
    writer.attach(element)
    writer.execute([{ type: 'SCHEDULE_WORK', epoch: 1, work: work('trailing-micro') }])

    scheduler.flushTimeouts()

    expect(element.scrollTop).toBe(0)
    expect(onWorkConsumed).toHaveBeenCalledExactlyOnceWith(9)
  })

  it('retains a fired trailing correction while an owner is active', () => {
    const scheduler = new FakeScheduler()
    const { element } = makeScroller()
    const onWorkConsumed = vi.fn()
    const writer = createTranscriptScrollWriter({ scheduler, onWorkConsumed })
    writer.attach(element)
    writer.execute([{ type: 'START_FOLD', epoch: 1, token: 4 }])
    writer.execute([{ type: 'SCHEDULE_WORK', epoch: 1, work: work('trailing-micro') }])

    scheduler.flushTimeouts()
    expect(element.scrollTop).toBe(0)
    expect(onWorkConsumed).not.toHaveBeenCalled()

    writer.execute([
      { type: 'CANCEL_OWNER', epoch: 1, token: 4 },
      { type: 'WRITE_ABSOLUTE_BOTTOM', epoch: 1, workId: 9, kind: 'trailing-micro' },
    ])
    expect(element.scrollTop).toBe(1000)
    expect(onWorkConsumed).toHaveBeenCalledExactlyOnceWith(9)
  })

  it('runs verification through cancellable writer frames until the bottom is stable', () => {
    const scheduler = new FakeScheduler()
    const { element } = makeScroller()
    const onWorkConsumed = vi.fn()
    const writer = createTranscriptScrollWriter({ scheduler, onWorkConsumed })
    writer.attach(element)
    writer.execute([
      { type: 'SCHEDULE_WORK', epoch: 1, work: work('verify') },
      { type: 'WRITE_ABSOLUTE_BOTTOM', epoch: 1, workId: 9, kind: 'verify' },
    ])

    expect(element.scrollTop).toBe(0)
    expect(scheduler.pendingFrames).toBe(1)
    scheduler.flushFrames()
    expect(element.scrollTop).toBe(1000)
    scheduler.flushFrames()
    scheduler.flushFrames()
    scheduler.flushFrames()
    expect(scheduler.pendingFrames).toBe(0)
    expect(onWorkConsumed).toHaveBeenCalledExactlyOnceWith(9)
  })

  it('does not restart the original verification deadline on sustained requests', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      const scheduler = new FakeScheduler()
      const { element } = makeScroller()
      const onWorkConsumed = vi.fn()
      const writer = createTranscriptScrollWriter({ scheduler, onWorkConsumed })
      writer.attach(element)
      writer.execute([
        { type: 'SCHEDULE_WORK', epoch: 1, work: work('verify') },
        { type: 'WRITE_ABSOLUTE_BOTTOM', epoch: 1, workId: 9, kind: 'verify' },
      ])

      const capturedFirstFrame = scheduler.frameCallbacks.get(1)!
      now.mockReturnValue(1200)
      writer.execute([
        { type: 'SCHEDULE_WORK', epoch: 1, work: work('verify', 10) },
        { type: 'WRITE_ABSOLUTE_BOTTOM', epoch: 1, workId: 10, kind: 'verify' },
      ])
      expect(scheduler.pendingFrames).toBe(1)
      capturedFirstFrame()
      expect(scheduler.pendingFrames).toBe(1)

      now.mockReturnValue(2501)
      scheduler.flushFrames()

      expect(scheduler.pendingFrames).toBe(0)
      expect(onWorkConsumed).toHaveBeenCalledExactlyOnceWith(10)
    } finally {
      now.mockRestore()
    }
  })

  it('bounds consumed-work bookkeeping during continuous attachment', () => {
    const sizes: number[] = []
    const add = Set.prototype.add
    const remove = Set.prototype.delete
    vi.spyOn(Set.prototype, 'add').mockImplementation(function (this: Set<unknown>, value: unknown) {
      const result = add.call(this, value)
      if (typeof value === 'number') sizes.push(this.size)
      return result
    })
    vi.spyOn(Set.prototype, 'delete').mockImplementation(function (this: Set<unknown>, value: unknown) {
      const result = remove.call(this, value)
      if (typeof value === 'number') sizes.push(this.size)
      return result
    })
    try {
      const scheduler = new FakeScheduler()
      const { element } = makeScroller()
      const onWorkConsumed = vi.fn()
      const writer = createTranscriptScrollWriter({ scheduler, onWorkConsumed })
      writer.attach(element)
      for (let id = 1; id <= 100; id++) {
        writer.execute([
          { type: 'SCHEDULE_WORK', epoch: 1, work: { id, kind: 'absolute-bottom', delivery: 'after-owner' } },
          { type: 'WRITE_ABSOLUTE_BOTTOM', epoch: 1, workId: id, kind: 'absolute-bottom' },
        ])
      }
      expect(onWorkConsumed).toHaveBeenCalledTimes(100)
      expect(Math.max(...sizes)).toBeLessThanOrEqual(64)
    } finally {
      Set.prototype.add = add
      Set.prototype.delete = remove
    }
  })

  it('rejects a captured stale timeout after consumed-work pruning', () => {
    const scheduler = new FakeScheduler()
    const { element, scrollTo } = makeScroller()
    const onWorkConsumed = vi.fn()
    const writer = createTranscriptScrollWriter({ scheduler, onWorkConsumed })
    writer.attach(element)
    writer.execute([{ type: 'SCHEDULE_WORK', epoch: 1, work: { id: 1, kind: 'trailing-micro', delivery: 'after-owner' } }])
    const captured = scheduler.timeoutCallbacks.get(1)!.callback
    for (let id = 2; id <= 100; id++) {
      writer.execute([
        { type: 'SCHEDULE_WORK', epoch: 1, work: { id, kind: 'absolute-bottom', delivery: 'after-owner' } },
        { type: 'WRITE_ABSOLUTE_BOTTOM', epoch: 1, workId: id, kind: 'absolute-bottom' },
      ])
    }
    scrollTo.mockClear()
    onWorkConsumed.mockClear()
    captured()

    expect(scrollTo).not.toHaveBeenCalled()
    expect(onWorkConsumed.mock.calls.filter(([id]) => id === 1)).toHaveLength(0)
  })

  it('holds fired work for attachment instead of dropping its write', () => {
    const scheduler = new FakeScheduler()
    const writer = createTranscriptScrollWriter({ scheduler })
    writer.execute([
      { type: 'SCHEDULE_WORK', epoch: 1, work: work('absolute-bottom') },
      { type: 'WRITE_ABSOLUTE_BOTTOM', epoch: 1, workId: 9, kind: 'absolute-bottom' },
    ])
    const { element } = makeScroller()

    writer.attach(element)

    expect(element.scrollTop).toBe(1000)
  })
})

describe('adapter callback scheduling', () => {
  it('runs follow debounce through a writer timeout and clears its pending state', () => {
    const scheduler = new FakeScheduler()
    const onFollowDebounce = vi.fn()
    const writer = createTranscriptScrollWriter({ scheduler, onFollowDebounce })

    writer.execute([{ type: 'SCHEDULE_CALLBACK', epoch: 1, kind: 'follow-debounce', delayMs: 150 }])
    expect(writer.isScheduled('follow-debounce')).toBe(true)
    scheduler.flushTimeouts()

    expect(onFollowDebounce).toHaveBeenCalledTimes(1)
    expect(writer.isScheduled('follow-debounce')).toBe(false)
  })

  it.each(['focus-reset', 'thumb-clear'] as const)('runs %s through a writer frame', (kind) => {
    const scheduler = new FakeScheduler()
    const onFocusReset = vi.fn()
    const onThumbClear = vi.fn()
    const writer = createTranscriptScrollWriter({ scheduler, onFocusReset, onThumbClear })
    const callback = kind === 'focus-reset' ? onFocusReset : onThumbClear

    writer.execute([{ type: 'SCHEDULE_CALLBACK', epoch: 1, kind }])
    expect(writer.isScheduled(kind)).toBe(true)
    scheduler.flushFrames()

    expect(callback).toHaveBeenCalledTimes(1)
    expect(writer.isScheduled(kind)).toBe(false)
  })

  it.each(['follow-debounce', 'focus-reset', 'thumb-clear'] as const)('rejects a captured %s callback after cancellation', (kind) => {
    const scheduler = new FakeScheduler()
    const onFollowDebounce = vi.fn()
    const onFocusReset = vi.fn()
    const onThumbClear = vi.fn()
    const writer = createTranscriptScrollWriter({ scheduler, onFollowDebounce, onFocusReset, onThumbClear })
    const callback = kind === 'follow-debounce' ? onFollowDebounce : kind === 'focus-reset' ? onFocusReset : onThumbClear
    writer.execute([{ type: 'SCHEDULE_CALLBACK', epoch: 1, kind, delayMs: 150 }])
    const captured = kind === 'follow-debounce'
      ? scheduler.timeoutCallbacks.get(1)!.callback
      : scheduler.frameCallbacks.get(1)!

    writer.execute([{ type: 'CANCEL_CALLBACK', epoch: 1, kind }])
    captured()

    expect(callback).not.toHaveBeenCalled()
    expect(writer.isScheduled(kind)).toBe(false)
    expect(scheduler.pendingFrames).toBe(0)
    expect(scheduler.pendingTimeouts).toBe(0)
  })

  it('cancels adapter callbacks on detach', () => {
    const scheduler = new FakeScheduler()
    const onThumbClear = vi.fn()
    const writer = createTranscriptScrollWriter({ scheduler, onThumbClear })
    const { element } = makeScroller()
    writer.attach(element)
    writer.execute([{ type: 'SCHEDULE_CALLBACK', epoch: 1, kind: 'thumb-clear' }])
    const captured = scheduler.frameCallbacks.get(1)!

    writer.attach(null)
    captured()

    expect(onThumbClear).not.toHaveBeenCalled()
    expect(writer.isScheduled('thumb-clear')).toBe(false)
  })
})

describe('fold transform ownership', () => {
  it('writes the fractional remainder as a transform and clears it at settle', () => {
    const scheduler = new FakeScheduler()
    const { element, itemList } = makeScroller(300, 200)
    const body = document.createElement('div')
    Object.defineProperty(body, 'offsetHeight', { configurable: true, value: 100 })
    body.style.height = '100px'
    element.append(body)
    animatingBodies.add(body)
    setCollapseAnimating(body, true)
    element.scrollTop = 100
    const writer = createTranscriptScrollWriter({ scheduler })
    writer.attach(element)

    writer.execute([
      { type: 'START_FOLD', epoch: 1, token: 6 },
      { type: 'SAMPLE_FOLD', epoch: 1, token: 6, frame: foldFrame(element, body, 100) },
    ])
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 300.5 })
    body.style.height = '100.5px'
    writer.execute([{
      type: 'SAMPLE_FOLD',
      epoch: 1,
      token: 6,
      frame: foldFrame(element, body, 100.5, { itemListDelta: 0.5, contentDelta: 0.5 }),
    }])

    expect(element.scrollTop).toBe(101)
    expect(itemList.style.transform).toBe('translateY(0.5px)')

    setCollapseAnimating(body, false)
    animatingBodies.delete(body)
    scheduler.flushFrames()
    expect(itemList.style.transform).toBe('')
    expect(scheduler.pendingFrames).toBe(0)
  })

  it('clears the fold transform when its owner is cancelled', () => {
    const scheduler = new FakeScheduler()
    const { element, itemList } = makeScroller(300, 200)
    const body = document.createElement('div')
    Object.defineProperty(body, 'offsetHeight', { configurable: true, value: 100 })
    body.style.height = '100px'
    element.append(body)
    animatingBodies.add(body)
    setCollapseAnimating(body, true)
    element.scrollTop = 100
    const writer = createTranscriptScrollWriter({ scheduler })
    writer.attach(element)
    writer.execute([
      { type: 'START_FOLD', epoch: 1, token: 6 },
      { type: 'SAMPLE_FOLD', epoch: 1, token: 6, frame: foldFrame(element, body, 100) },
    ])
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 300.5 })
    body.style.height = '100.5px'
    writer.execute([{
      type: 'SAMPLE_FOLD',
      epoch: 1,
      token: 6,
      frame: foldFrame(element, body, 100.5, { itemListDelta: 0.5, contentDelta: 0.5 }),
    }])
    expect(itemList.style.transform).toBe('translateY(0.5px)')

    writer.execute([{ type: 'CANCEL_OWNER', epoch: 1, token: 6 }])

    expect(itemList.style.transform).toBe('')
    expect(scheduler.pendingFrames).toBe(0)
  })

  it('consumes absolute work on fold alignment while retaining verification', () => {
    const scheduler = new FakeScheduler()
    const { element } = makeScroller(300, 200)
    const body = document.createElement('div')
    element.append(body)
    animatingBodies.add(body)
    setCollapseAnimating(body, true)
    const onWorkConsumed = vi.fn()
    const writer = createTranscriptScrollWriter({ scheduler, onWorkConsumed })
    writer.attach(element)
    writer.execute([
      { type: 'START_FOLD', epoch: 1, token: 6 },
      { type: 'SCHEDULE_WORK', epoch: 1, work: { id: 2, kind: 'absolute-bottom', delivery: 'next-observation' } },
      { type: 'SCHEDULE_WORK', epoch: 1, work: { id: 3, kind: 'verify', delivery: 'after-owner' } },
      { type: 'SAMPLE_FOLD', epoch: 1, token: 6, frame: foldFrame(element, body, 100) },
    ])

    expect(element.scrollTop).toBe(300)
    expect(onWorkConsumed).toHaveBeenCalledExactlyOnceWith(2)
    expect(scheduler.pendingFrames).toBe(1) // fold settlement poll, not verification

    writer.execute([{ type: 'WRITE_ABSOLUTE_BOTTOM', epoch: 1, workId: 3, kind: 'verify' }])
    expect(scheduler.pendingFrames).toBe(2)
    expect(onWorkConsumed).not.toHaveBeenCalledWith(3)
  })

  it('reconciles absolute alignment to fractional DOM readback before the next delta', () => {
    const scheduler = new FakeScheduler()
    const { element, itemList } = makeScroller(300.25, 200)
    let rawScrollTop = 100
    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      get: () => {
        const maximum = element.scrollHeight - element.clientHeight
        return Math.round(Math.min(rawScrollTop, maximum) * 1.5) / 1.5
      },
      set: (value: number) => { rawScrollTop = value },
    })
    const body = document.createElement('div')
    Object.defineProperty(body, 'offsetHeight', { configurable: true, value: 100 })
    body.style.height = '100px'
    element.append(body)
    animatingBodies.add(body)
    setCollapseAnimating(body, true)
    const writer = createTranscriptScrollWriter({ scheduler })
    writer.attach(element)
    writer.execute([
      { type: 'START_FOLD', epoch: 1, token: 6 },
      {
        type: 'SAMPLE_FOLD',
        epoch: 1,
        token: 6,
        frame: foldFrame(element, body, 100, { devicePixelRatio: 1.5 }),
      },
    ])
    expect(element.scrollTop).toBe(100)

    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 300.75 })
    body.style.height = '100.5px'
    writer.execute([{
      type: 'SAMPLE_FOLD',
      epoch: 1,
      token: 6,
      frame: foldFrame(element, body, 100.5, {
        itemListDelta: 0.5,
        contentDelta: 0.5,
        devicePixelRatio: 1.5,
      }),
    }])

    expect(element.scrollTop).toBe(100.66666666666667)
    expect(itemList.style.transform).toBe('translateY(0.1666666666666714px)')
  })
})

describe('missing-element continuation', () => {
  it('defers follow until attachment without calling a Virtuoso smooth fallback', () => {
    const scheduler = new FakeScheduler()
    const { virtuoso, scrollToIndex } = makeVirtuoso()
    const writer = createTranscriptScrollWriter({ scheduler, virtuoso })

    writer.execute([{ type: 'START_FOLLOW', epoch: 1, token: 4 }])
    expect(scrollToIndex).not.toHaveBeenCalled()
    expect(scheduler.pendingFrames).toBe(0)

    const { element, scrollTo } = makeScroller()
    writer.attach(element)
    expect(scheduler.pendingFrames).toBe(1)
    scheduler.flushFrames()

    expect(scrollTo).toHaveBeenCalledWith({ top: 200, behavior: 'auto' })
    expect(scrollToIndex).not.toHaveBeenCalled()
  })

  it('continues a new owner requested after a detach when the replacement attaches', () => {
    const scheduler = new FakeScheduler()
    const { virtuoso, scrollToIndex } = makeVirtuoso()
    const writer = createTranscriptScrollWriter({ scheduler, virtuoso })
    writer.attach(makeScroller().element)
    writer.attach(null)

    writer.execute([{ type: 'START_FOLLOW', epoch: 1, token: 5 }])
    const replacement = makeScroller()
    writer.attach(replacement.element)

    expect(scheduler.pendingFrames).toBe(1)
    scheduler.flushFrames()
    expect(replacement.scrollTo).toHaveBeenCalledWith({ top: 200, behavior: 'auto' })
    expect(scrollToIndex).not.toHaveBeenCalled()
  })

  it('invalidates a deferred owner on detach even when no element was attached', () => {
    const scheduler = new FakeScheduler()
    const writer = createTranscriptScrollWriter({ scheduler })
    writer.execute([{ type: 'START_FOLLOW', epoch: 1, token: 4 }])

    writer.attach(null)
    writer.attach(makeScroller().element)

    expect(scheduler.pendingFrames).toBe(0)
  })

  it('does not continue a deferred owner whose token was cancelled before attachment', () => {
    const scheduler = new FakeScheduler()
    const { virtuoso, scrollToIndex } = makeVirtuoso()
    const writer = createTranscriptScrollWriter({ scheduler, virtuoso })
    writer.execute([{ type: 'START_SEEK', epoch: 1, token: 8, index: 12, align: 'center' }])

    writer.execute([{ type: 'CANCEL_OWNER', epoch: 1, token: 8 }])
    writer.attach(makeScroller().element)

    expect(scheduler.pendingFrames).toBe(0)
    expect(scrollToIndex).not.toHaveBeenCalled()
  })

  it('uses only an auto Virtuoso fallback when an attached seek has no measurable rows', () => {
    const scheduler = new FakeScheduler()
    const { virtuoso, scrollToIndex } = makeVirtuoso()
    const writer = createTranscriptScrollWriter({ scheduler, virtuoso })
    writer.attach(makeScroller().element)

    writer.execute([{ type: 'START_SEEK', epoch: 1, token: 8, index: 12, align: 'center' }])
    scheduler.flushFrames()

    expect(scrollToIndex).toHaveBeenCalledTimes(1)
    expect(scrollToIndex).toHaveBeenCalledWith({ index: 12, behavior: 'auto', align: 'center' })
    expect(scrollToIndex.mock.calls.every((call) => call[0].behavior !== 'smooth')).toBe(true)
  })

  it('resolves a data-space seek against offset-space rows with a nonzero anchor', () => {
    const scheduler = new FakeScheduler()
    const { virtuoso, scrollToIndex } = makeVirtuoso()
    const { element, itemList, scrollTo } = makeScroller(1200, 200)
    const row = document.createElement('div')
    row.dataset.itemIndex = '101'
    Object.defineProperty(row, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: 400 - element.scrollTop,
        bottom: 500 - element.scrollTop,
        height: 100,
      }),
    })
    itemList.append(row)
    element.scrollTop = 800
    let anchor = 100
    const writer = createTranscriptScrollWriter({
      scheduler,
      virtuoso,
      firstItemIndex: () => anchor,
    })
    writer.attach(element)

    writer.execute([{ type: 'START_SEEK', epoch: 1, token: 8, index: 1, align: 'start' }])
    scheduler.flushFrames()

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 700, behavior: 'auto' })
    expect(scrollToIndex).not.toHaveBeenCalled()

    anchor = 200
    row.dataset.itemIndex = '201'
    scheduler.flushFrames()
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 625, behavior: 'auto' })
  })

  it('reports natural owner landing to the lifecycle adapter', () => {
    const scheduler = new FakeScheduler()
    const { element } = makeScroller(300, 200)
    element.scrollTop = 100
    const onOwnerLanded = vi.fn()
    const writer = createTranscriptScrollWriter({ scheduler, onOwnerLanded })
    writer.attach(element)

    writer.execute([{ type: 'START_FOLLOW', epoch: 1, token: 4 }])
    scheduler.flushFrames()

    expect(onOwnerLanded).toHaveBeenCalledExactlyOnceWith(4)
  })

  it('reports trailing work consumption to the lifecycle adapter', () => {
    const scheduler = new FakeScheduler()
    const { element } = makeScroller()
    const onWorkConsumed = vi.fn()
    const writer = createTranscriptScrollWriter({ scheduler, onWorkConsumed })
    writer.attach(element)

    writer.execute([{ type: 'SCHEDULE_WORK', epoch: 1, work: work('trailing-micro') }])
    scheduler.flushTimeouts()

    expect(onWorkConsumed).toHaveBeenCalledExactlyOnceWith(9)
  })

  it('resolves an already mounted restore anchor immediately without a Virtuoso reveal jump', () => {
    const scheduler = new FakeScheduler()
    const { virtuoso, scrollToIndex } = makeVirtuoso()
    const { element, itemList, scrollTo } = makeScroller(1200, 200)
    const row = document.createElement('div')
    row.dataset.itemIndex = '101'
    Object.defineProperty(row, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: 400 - element.scrollTop,
        bottom: 500 - element.scrollTop,
        height: 100,
      }),
    })
    itemList.append(row)
    let firstItemIndex = 100
    const writer = createTranscriptScrollWriter({
      scheduler,
      virtuoso,
      firstItemIndex: () => firstItemIndex,
    })
    writer.attach(element)

    writer.execute([{
      type: 'START_RESTORE',
      epoch: 1,
      token: 8,
      target: 317,
      reveal: { index: 1, offset: -12 },
    }])

    expect(scrollToIndex).not.toHaveBeenCalled()
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 388, behavior: 'auto' })

    firstItemIndex = 50
    Object.defineProperty(row, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: 700 - element.scrollTop,
        bottom: 800 - element.scrollTop,
        height: 100,
      }),
    })
    scheduler.flushFrames()
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 688, behavior: 'auto' })
    expect(scrollToIndex).not.toHaveBeenCalled()
  })

  it('reveals a virtualized restore anchor and resolves its relative target', () => {
    const scheduler = new FakeScheduler()
    const { virtuoso, scrollToIndex } = makeVirtuoso()
    const { element, itemList, scrollTo } = makeScroller(1200, 200)
    const row = document.createElement('div')
    row.dataset.itemIndex = '101'
    Object.defineProperty(row, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: 400 - element.scrollTop,
        bottom: 500 - element.scrollTop,
        height: 100,
      }),
    })
    let firstItemIndex = 100
    const writer = createTranscriptScrollWriter({
      scheduler,
      virtuoso,
      firstItemIndex: () => firstItemIndex,
    })
    writer.attach(element)

    writer.execute([{
      type: 'START_RESTORE',
      epoch: 1,
      token: 8,
      target: 317,
      reveal: { index: 1, offset: -12 },
    }])

    expect(scrollToIndex).toHaveBeenCalledExactlyOnceWith({ index: 1, behavior: 'auto', align: 'start' })
    expect(scrollTo).not.toHaveBeenCalled()

    itemList.append(row)
    scheduler.flushFrames()
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 388, behavior: 'auto' })

    // A real prepend moves firstItemIndex down while the anchor's DATA index
    // moves up by the same amount: its absolute Virtuoso offset stays 101.
    // Rewrap must still resolve that same absolute row against new geometry.
    firstItemIndex = 50
    Object.defineProperty(row, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: 700 - element.scrollTop,
        bottom: 800 - element.scrollTop,
        height: 100,
      }),
    })
    scheduler.flushFrames()
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 688, behavior: 'auto' })
  })

  it('uses the restore pixel fallback when the reveal anchor never mounts', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
    try {
      const scheduler = new FakeScheduler()
      const { virtuoso, scrollToIndex } = makeVirtuoso()
      const { element, scrollTo } = makeScroller(1200, 200)
      const writer = createTranscriptScrollWriter({ scheduler, virtuoso })
      writer.attach(element)

      writer.execute([{
        type: 'START_RESTORE',
        epoch: 1,
        token: 8,
        target: 317,
        reveal: { index: 1, offset: -12 },
      }])
      expect(scrollToIndex).toHaveBeenCalledExactlyOnceWith({ index: 1, behavior: 'auto', align: 'start' })
      expect(scrollTo).not.toHaveBeenCalled()

      now.mockReturnValue(1751)
      scheduler.flushFrames()

      expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 317, behavior: 'auto' })
      expect(scheduler.pendingFrames).toBe(0)
    } finally {
      now.mockRestore()
    }
  })

  it('cancels a revealed restore without a later pixel fallback', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
    try {
      const scheduler = new FakeScheduler()
      const { virtuoso, scrollToIndex } = makeVirtuoso()
      const { element, scrollTo } = makeScroller(1200, 200)
      const writer = createTranscriptScrollWriter({ scheduler, virtuoso })
      writer.attach(element)
      writer.execute([{
        type: 'START_RESTORE',
        epoch: 1,
        token: 8,
        target: 317,
        reveal: { index: 1, offset: -12 },
      }])
      expect(scrollToIndex).toHaveBeenCalledExactlyOnceWith({ index: 1, behavior: 'auto', align: 'start' })

      now.mockReturnValue(1751)
      writer.execute([{ type: 'CANCEL_OWNER', epoch: 1, token: 8 }])
      scheduler.flushFrames()

      expect(scrollTo).not.toHaveBeenCalled()
      expect(scrollToIndex).toHaveBeenCalledTimes(1)
      expect(scheduler.pendingFrames).toBe(0)
    } finally {
      now.mockRestore()
    }
  })
})

describe('seek terminal lifecycle integration', () => {
  it('settles to idle when the scroller is hidden during ease', () => {
    const lifecycle = makeSeekLifecycle(0)

    lifecycle.scheduler.flushFrames()

    expect(lifecycle.state().owner).toEqual({ kind: 'none' })
    expect(lifecycle.state().seekState).toBe('idle')
    expect(lifecycle.element.dataset.crwSeekActive).toBeUndefined()

    lifecycle.dispatch({ type: 'RESTORE_REQUESTED', target: 317 })
    expect(lifecycle.state().owner).toEqual({ kind: 'restore', token: 2, target: 317 })
    expect(lifecycle.element.hasAttribute('data-crw-seek-active')).toBe(false)
  })

  it('settles to idle after the missing-target Virtuoso fallback', () => {
    const lifecycle = makeSeekLifecycle()

    lifecycle.scheduler.flushFrames()

    expect(lifecycle.scrollToIndex).toHaveBeenCalledExactlyOnceWith({ index: 12, behavior: 'auto', align: 'start' })
    expect(lifecycle.state().owner).toEqual({ kind: 'none' })
    expect(lifecycle.state().seekState).toBe('idle')
    expect(lifecycle.element.dataset.crwSeekActive).toBeUndefined()

    lifecycle.dispatch({ type: 'RESTORE_REQUESTED', target: 317 })
    expect(lifecycle.state().owner).toEqual({ kind: 'restore', token: 2, target: 317 })
    expect(lifecycle.element.hasAttribute('data-crw-seek-active')).toBe(false)
  })

  it('settles to idle after ease exhaustion and its Virtuoso fallback', () => {
    const lifecycle = makeSeekLifecycle()
    const row = document.createElement('div')
    row.dataset.itemIndex = '12'
    Object.defineProperty(row, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 1200, bottom: 1300, height: 100 }),
    })
    lifecycle.itemList.append(row)
    lifecycle.element.scrollTo = vi.fn()

    for (let frame = 0; frame < 601; frame++) lifecycle.scheduler.flushFrames()

    expect(lifecycle.scrollToIndex).toHaveBeenCalledExactlyOnceWith({ index: 12, behavior: 'auto', align: 'start' })
    expect(lifecycle.state().owner).toEqual({ kind: 'none' })
    expect(lifecycle.state().seekState).toBe('idle')
    expect(lifecycle.element.dataset.crwSeekActive).toBeUndefined()

    lifecycle.dispatch({ type: 'RESTORE_REQUESTED', target: 317 })
    expect(lifecycle.state().owner).toEqual({ kind: 'restore', token: 2, target: 317 })
    expect(lifecycle.element.hasAttribute('data-crw-seek-active')).toBe(false)
  })
})
