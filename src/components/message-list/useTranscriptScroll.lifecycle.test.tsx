import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCallback, useLayoutEffect, useRef, StrictMode, type MutableRefObject } from 'react'
import type { VirtuosoHandle } from 'react-virtuoso'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../../test/resize-observer-stub'
import { setCollapseAnimating } from '../collapse-animation'
import { useTranscriptScroll, TRAILING_MICRO_PIN_MS, type TranscriptScrollApi } from './useTranscriptScroll'

const adapterSource = () => readFileSync(
  resolve(process.cwd(), 'src/components/message-list/useTranscriptScroll.ts'),
  'utf8',
)
const withoutSourceComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')
const bareTimerCall = /(?<![\w$.])(?:setTimeout|clearTimeout)\s*\(/

interface Geometry {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
  contentTops: number[]
}

interface HarnessProps {
  apiRef: MutableRefObject<TranscriptScrollApi | null>
  geometry: Geometry
  virtuoso: VirtuosoHandle
  attached?: boolean
  panelVisible?: boolean
  bottomStackHeight?: number
  itemCount?: number
  onVisibleTopChange?: (index: number) => void
}

function stubGeometry(element: HTMLElement, geometry: Geometry): void {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => geometry.scrollHeight },
    clientHeight: { configurable: true, get: () => geometry.clientHeight },
    scrollTop: {
      configurable: true,
      get: () => geometry.scrollTop,
      set: (value: number) => { geometry.scrollTop = value },
    },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({
        top: 0,
        bottom: geometry.clientHeight,
        left: 0,
        right: 800,
        width: 800,
        height: geometry.clientHeight,
      }),
    },
  })
}

function Harness({
  apiRef,
  geometry,
  virtuoso,
  attached = true,
  panelVisible = true,
  bottomStackHeight = 0,
  itemCount = 3,
  onVisibleTopChange,
}: HarnessProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(virtuoso)
  const firstItemIndexRef = useRef(100)
  const setOsScroller = useCallback((_element: HTMLElement | null) => {}, [])
  const api = useTranscriptScroll({
    virtuosoRef,
    setOsScroller,
    rowCount: 3,
    itemCount,
    transcriptRevealKey: 'lifecycle',
    bottomStackHeight,
    firstItemIndexRef,
    onVisibleTopChange,
    panelVisible,
    showEpoch: 1,
  })
  useLayoutEffect(() => { apiRef.current = api })
  const scrollerRefCb = api.scrollerRefCb
  const scrollerRef = useCallback((element: HTMLDivElement | null) => {
    if (element) stubGeometry(element, geometry)
    scrollerRefCb(element)
  }, [scrollerRefCb, geometry])

  if (!attached) return null
  return (
    <div data-testid="scroller" ref={scrollerRef}>
      <div data-testid="virtuoso-item-list">
        {geometry.contentTops.map((_contentTop, index) => (
          <div
            key={index}
            data-item-index={100 + index}
            ref={(row) => {
              if (!row) return
              Object.defineProperty(row, 'getBoundingClientRect', {
                configurable: true,
                value: () => {
                  const top = geometry.contentTops[index] - geometry.scrollTop
                  return { top, bottom: top + 200, left: 0, right: 800, width: 800, height: 200 }
                },
              })
            }}
          />
        ))}
      </div>
    </div>
  )
}

function setup(initial: Partial<HarnessProps> = {}) {
  const apiRef: MutableRefObject<TranscriptScrollApi | null> = { current: null }
  const geometry: Geometry = {
    scrollHeight: 1200,
    clientHeight: 200,
    scrollTop: 1000,
    contentTops: [0, 300, 600],
    ...initial.geometry,
  }
  const scrollToIndex = vi.fn()
  const virtuoso = { scrollToIndex } as unknown as VirtuosoHandle
  const props: HarnessProps = { ...initial, apiRef, geometry, virtuoso }
  // Match the real root: post-render assertions run after StrictMode's
  // mount-effect cleanup/setup replay, not just after the first setup.
  const view = render(<StrictMode><Harness {...props} /></StrictMode>)
  const scroller = view.container.querySelector<HTMLElement>('[data-testid="scroller"]')
  if (scroller) {
    scroller.scrollTo = vi.fn((optionsOrX?: ScrollToOptions | number, y?: number) => {
      const top = typeof optionsOrX === 'number' ? y : optionsOrX?.top
      if (typeof top === 'number') geometry.scrollTop = top
    })
  }
  return {
    ...view,
    api: () => apiRef.current!,
    geometry,
    scroller,
    scrollToIndex,
    update(next: Partial<HarnessProps>) {
      Object.assign(props, next)
      view.rerender(<StrictMode><Harness {...props} /></StrictMode>)
    },
  }
}

describe('useTranscriptScroll lifecycle adapter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stubResizeObserver()
  })

  afterEach(() => {
    vi.useRealTimers()
    clearResizeObserverStub()
    vi.unstubAllGlobals()
  })

  it('executes an immediate bottom pin through the writer', () => {
    const { scroller, geometry } = setup({ geometry: {
      scrollHeight: 1200,
      clientHeight: 200,
      scrollTop: 0,
      contentTops: [0, 300, 600],
    } })

    expect(scroller?.scrollTop).toBe(1200)
    expect(geometry.scrollTop).toBe(1200)
  })

  it('eases follow toward fresh bottom geometry and settles', () => {
    const { api, geometry, scroller } = setup()
    geometry.scrollHeight = 1600

    act(() => { api().followOutput(true) })
    act(() => { vi.advanceTimersByTime(16) })
    expect(geometry.scrollTop).toBe(1100)

    geometry.scrollHeight = 1800
    act(() => { vi.runAllTimers() })
    expect(scroller?.scrollTo).toHaveBeenLastCalledWith({ top: 1600, behavior: 'auto' })
    expect(api().following).toBe(true)
  })

  it('defers a missing-element follow without a Virtuoso smooth fallback', () => {
    const { api, scrollToIndex, update } = setup({ attached: false })

    act(() => { api().followOutput(true) })
    expect(scrollToIndex).not.toHaveBeenCalled()

    update({ attached: true })
    act(() => { vi.runAllTimers() })
    expect(scrollToIndex).not.toHaveBeenCalled()
  })

  it('seeks in data space while resolving DOM rows in offset space, then holds and releases', () => {
    const { api, geometry, scroller, scrollToIndex } = setup()

    act(() => { api().seekToIndex(1, 'start') })
    expect(api().following).toBe(false)
    for (let frame = 0; frame < 100 && geometry.scrollTop !== 300; frame++) {
      act(() => { vi.advanceTimersByTime(16) })
    }
    expect(geometry.scrollTop).toBe(300)
    expect(scroller?.dataset.crwSeekActive).toBe('true')
    expect(scrollToIndex).not.toHaveBeenCalled()

    geometry.contentTops[1] = 400
    act(() => { vi.advanceTimersByTime(16) })
    expect(scroller?.scrollTo).toHaveBeenLastCalledWith({ top: 400, behavior: 'auto' })

    act(() => { vi.runAllTimers() })
    expect(scroller?.dataset.crwSeekActive).toBeUndefined()
  })

  it('cancels seek ownership when the panel hides', () => {
    const { api, scroller, update } = setup()
    act(() => { api().seekToIndex(0, 'start') })
    vi.mocked(scroller!.scrollTo).mockClear()

    update({ panelVisible: false })
    act(() => { vi.runAllTimers() })

    expect(scroller?.scrollTo).not.toHaveBeenCalled()
    expect(scroller?.dataset.crwSeekActive).toBeUndefined()
  })

  it('blocks hidden owner work and adapter callbacks while preserving a fresh visible request', () => {
    const { api, scroller, update } = setup()
    act(() => { api().followOutput(true) })
    vi.mocked(scroller!.scrollTo).mockClear()

    update({ panelVisible: false })
    update({ itemCount: 4 })
    act(() => { api().followOutput(true) })
    act(() => { api().restoreScroll(317) })
    act(() => {
      fireEvent.keyDown(scroller!, { key: 'Tab' })
      vi.runAllTimers()
    })
    expect(scroller!.scrollTo).not.toHaveBeenCalled()

    update({ panelVisible: true })
    act(() => { api().followOutput(true) })
    act(() => { vi.runAllTimers() })
    expect(scroller!.scrollTo).toHaveBeenCalled()
  })

  it('cancels restore on an away fold observation without bottom compensation', () => {
    const { api, scroller, geometry } = setup()
    act(() => {
      fireEvent.wheel(scroller!, { deltaY: -120 })
      geometry.scrollTop = 900
      fireEvent.scroll(scroller!)
    })
    expect(api().following).toBe(false)
    act(() => { api().restoreScroll(317) })
    expect(geometry.scrollTop).toBe(317)
    vi.mocked(scroller!.scrollTo).mockClear()
    const fold = document.createElement('div')
    scroller!.append(fold)
    const itemList = scroller!.querySelector('[data-testid="virtuoso-item-list"]')!

    act(() => {
      setCollapseAnimating(fold, true)
      fireResize(itemList)
      vi.runAllTimers()
    })

    expect(scroller!.scrollTo).not.toHaveBeenCalled()
    expect(geometry.scrollTop).toBe(317)
    setCollapseAnimating(fold, false)
  })

  it('pins after a committed spacer resize', () => {
    const { geometry, update } = setup()
    geometry.scrollTop = 900

    update({ bottomStackHeight: 80 })

    expect(geometry.scrollTop).toBe(1200)
  })

  it('pins when the viewport shrinks while following', () => {
    const { geometry, scroller } = setup()
    geometry.clientHeight = 100
    geometry.scrollTop = 1000

    act(() => { fireResize(scroller!) })

    expect(geometry.scrollTop).toBe(1200)
  })

  it('debounces trailing micro corrections into one writer command', () => {
    const { geometry, scroller } = setup()
    const itemList = scroller!.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]')!
    Object.defineProperty(itemList, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600 }),
    })
    act(() => { fireResize(itemList) })
    act(() => { vi.advanceTimersByTime(2500) })
    geometry.scrollTop = 1000
    let writes = 0
    Object.defineProperty(scroller!, 'scrollTop', {
      configurable: true,
      get: () => geometry.scrollTop,
      set: (value: number) => { writes += 1; geometry.scrollTop = value },
    })

    geometry.scrollHeight = 1203
    act(() => { fireResize(itemList) })
    expect(writes).toBe(0)
    act(() => { vi.advanceTimersByTime(TRAILING_MICRO_PIN_MS) })

    expect(writes).toBe(1)
    expect(geometry.scrollTop).toBe(1203)
  })

  it('clears pending trailing work before an upward thumb gesture cancels the owner', () => {
    const { api, scroller, geometry } = setup()
    act(() => { api().restoreScroll(1000) })
    const itemList = scroller!.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]')!
    Object.defineProperty(itemList, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600 }),
    })
    geometry.scrollHeight = 1203
    act(() => { fireResize(itemList) })
    const track = document.createElement('div')
    track.className = 'os-track'
    scroller!.parentElement!.append(track)

    act(() => {
      fireEvent.pointerDown(track, { buttons: 1, clientY: 100 })
      geometry.scrollTop = 900
      fireEvent.scroll(scroller!)
    })

    expect(api().following).toBe(false)
    expect(geometry.scrollTop).toBe(900)
  })

  it('reports the geometric visible top in Virtuoso offset space', () => {
    const onVisibleTopChange = vi.fn()
    const { geometry, scroller } = setup({ onVisibleTopChange })
    geometry.scrollTop = 300

    act(() => { fireEvent.scroll(scroller!) })

    expect(onVisibleTopChange).toHaveBeenLastCalledWith(101)
  })

  it('routes fold and settle correction state through lifecycle work items', () => {
    const source = adapterSource()

    expect(source).not.toContain('pendingFoldPinRef')
    expect(source).not.toContain('armFoldSettleRef')
    expect(source).not.toContain('settleFoldTransform')
    expect(source).not.toContain('settleRunningRef')
    expect(source).not.toContain('verifyRef')
    expect(source).not.toContain('followTimerRef')
    expect(source).not.toContain('focusResetRafRef')
    expect(source).not.toContain('thumbClearRaf')
    expect(source).not.toMatch(/\breason\s*:/)
  })

  it('keeps every adapter scroll write and scheduler inside the writer gateway', () => {
    const source = adapterSource()
    const executableSource = withoutSourceComments(source)

    expect(source).not.toContain("behavior: 'smooth'")
    expect(source).not.toMatch(/\.\s*scrollTop\s*=/)
    expect(source).not.toMatch(/\.\s*scrollTo\s*\(/)
    expect(source).not.toMatch(/\.\s*scrollToIndex\s*\(/)
    expect(source).not.toMatch(/\b(?:requestAnimationFrame|cancelAnimationFrame)\s*\(/)
    expect(executableSource).not.toMatch(/\bwindow\.(?:setTimeout|clearTimeout)\s*\(/)
    expect(executableSource).not.toMatch(bareTimerCall)

    // Positive controls pin the removed bare-call style, while qualified calls
    // and comments cannot make this guard vacuous or noisy.
    expect('setTimeout(callback, 0)').toMatch(bareTimerCall)
    expect('clearTimeout(timer)').toMatch(bareTimerCall)
    expect('window.setTimeout(callback, 0)').not.toMatch(bareTimerCall)
    expect('scheduler.clearTimeout(timer)').not.toMatch(bareTimerCall)
    expect('mysetTimeout(callback, 0)').not.toMatch(bareTimerCall)
    expect(withoutSourceComments('// setTimeout(callback, 0)\n/* clearTimeout(timer) */')).not.toMatch(bareTimerCall)

    const messageListSource = readFileSync(resolve(process.cwd(), 'src/components/MessageList.tsx'), 'utf8')
    expect(messageListSource).not.toMatch(/virtuosoRef\.current\?\.scrollToIndex\s*\(/)
  })

  it('uses named lifecycle events instead of bottom-state mode strings', () => {
    const source = adapterSource()

    expect(source).not.toMatch(/\b(?:FollowMode|BottomSyncMode|followMode|modeWhenAway)\b/)
    expect(source).not.toContain("'disable-now'")
    expect(source).not.toContain("'disable-debounced'")
    expect(source).not.toContain("'confirm-away'")
  })

  it('derives intent and ownership from the reducer instead of parallel refs', () => {
    const source = adapterSource()

    expect(source).not.toContain('shouldFollowRef')
    expect(source).not.toContain('scrollAnimatingRef')
    expect(source).not.toContain('seekActiveRef')
  })
})
