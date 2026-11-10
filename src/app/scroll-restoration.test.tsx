import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import type { VirtuosoHandle } from 'react-virtuoso'
import { useTranscriptScroll } from '../components/message-list/useTranscriptScroll'
import { TRANSCRIPT_ANCHOR_REVEAL_EVENT, TRANSCRIPT_RESTORE_EVENT } from '../components/panel-transition'
import type { PanelScrollSnapshot } from '../utils/panel-cache'
import { AppScrollRestoration } from './AppScrollRestoration'

function makeScroller() {
  const element = document.createElement('div')
  let top = 0
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 1200 },
    clientHeight: { configurable: true, value: 200 },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => { top = value },
    },
  })
  element.scrollTo = vi.fn((optionsOrX?: ScrollToOptions | number, y?: number) => {
    const topValue = typeof optionsOrX === 'number' ? y : optionsOrX?.top
    if (typeof topValue === 'number') top = topValue
  })
  return element
}

function makeAppPanel() {
  const body = document.createElement('div')
  const panel = document.createElement('div')
  panel.dataset.panelId = 's1'
  const scroller = document.createElement('div')
  scroller.className = 'chat-virtuoso-scroller'
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: 1200 },
    offsetHeight: { configurable: true, value: 200 },
    scrollTop: { configurable: true, value: 0, writable: true },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({ top: 0, bottom: 200, left: 0, right: 800, width: 800, height: 200 }),
    },
  })
  const wrap = document.createElement('div')
  wrap.className = 'chat-messages-wrap'
  wrap.dataset.following = 'false'
  wrap.append(scroller)
  panel.append(wrap)
  body.append(panel)
  document.body.append(body)
  return { body, scroller }
}

function renderAppRestoration(body: HTMLDivElement, snapshot: PanelScrollSnapshot) {
  return render(
    <AppScrollRestoration
      bodyRef={{ current: body }}
      openIds={['s1']}
      panelCache={['s1']}
      panelScrollMemoryRef={{ current: new Map([['s1', snapshot]]) }}
      panelShowEpochsRef={{ current: new Map([['s1', 1]]) }}
      panelReassertEpochsRef={{ current: new Map() }}
    />,
  )
}

function addRestoreAnchor(scroller: HTMLElement): void {
  const row = document.createElement('div')
  row.dataset.crwRowId = 'row-1'
  Object.defineProperty(row, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: 100, bottom: 200, left: 0, right: 800, width: 800, height: 100 }),
  })
  scroller.append(row)
}

describe('App transcript scroll restoration', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('restores and holds an arbitrary target through the transcript API', () => {
    const virtuosoRef = createRef<VirtuosoHandle>()
    const firstItemIndexRef = { current: 0 }
    const { result } = renderHook(() => useTranscriptScroll({
      virtuosoRef,
      setOsScroller: () => {},
      rowCount: 0,
      itemCount: 0,
      transcriptRevealKey: 'restore',
      bottomStackHeight: 0,
      firstItemIndexRef,
      panelVisible: true,
    }))
    const scroller = makeScroller()
    act(() => { result.current.scrollerRefCb(scroller) })

    act(() => { result.current.restoreScroll(317) })
    expect(scroller.scrollTop).toBe(317)

    scroller.scrollTop = 280
    act(() => { vi.advanceTimersByTime(16) })
    expect(scroller.scrollTop).toBe(317)
    act(() => { vi.advanceTimersByTime(1000) })
  })

  it('dispatches a remembered target from the real App layout effect', () => {
    const { body, scroller } = makeAppPanel()
    const restore = vi.fn()
    scroller.addEventListener(TRANSCRIPT_RESTORE_EVENT, restore)

    renderAppRestoration(body, { top: 317, anchorId: null, anchorOffset: 0 })

    expect(restore).toHaveBeenCalledTimes(1)
    expect((restore.mock.calls[0][0] as CustomEvent<{ target: number }>).detail).toEqual({ target: 317 })
    expect(scroller.scrollTop).toBe(0)
  })

  it('ignores a static transcript scroller inside the same panel', () => {
    const { body, scroller } = makeAppPanel()
    const panel = body.querySelector<HTMLElement>('[data-panel-id="s1"]')!
    const staticWrap = document.createElement('div')
    staticWrap.className = 'chat-messages-wrap'
    staticWrap.dataset.staticTranscript = 'true'
    const staticScroller = document.createElement('div')
    staticScroller.className = 'chat-virtuoso-scroller'
    Object.defineProperties(staticScroller, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1200 },
    })
    staticWrap.append(staticScroller)
    // Put the preview first in DOM order: the selector must still restore the
    // live transcript, not the snapshot.
    panel.prepend(staticWrap)
    const restore = vi.fn()
    const staticRestore = vi.fn()
    scroller.addEventListener(TRANSCRIPT_RESTORE_EVENT, restore)
    staticScroller.addEventListener(TRANSCRIPT_RESTORE_EVENT, staticRestore)

    renderAppRestoration(body, { top: 317, anchorId: null, anchorOffset: 0 })

    expect(restore).toHaveBeenCalledTimes(1)
    expect(staticRestore).not.toHaveBeenCalled()
  })

  it('produces an initially measurable anchor reveal exactly once without an App scheduler', () => {
    const { body, scroller } = makeAppPanel()
    addRestoreAnchor(scroller)
    const reveal = vi.fn()
    const restore = vi.fn()
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    scroller.addEventListener(TRANSCRIPT_ANCHOR_REVEAL_EVENT, reveal)
    scroller.addEventListener(TRANSCRIPT_RESTORE_EVENT, restore)

    renderAppRestoration(body, { top: 317, anchorId: 'row-1', anchorOffset: -12 })

    expect(reveal).toHaveBeenCalledTimes(1)
    expect((reveal.mock.calls[0][0] as CustomEvent<Record<string, unknown>>).detail).toEqual({
      anchorId: 'row-1',
      anchorOffset: -12,
      fallbackTarget: 317,
    })
    expect(restore).not.toHaveBeenCalled()
    expect(raf).not.toHaveBeenCalled()
    raf.mockRestore()
  })

  it('produces a virtualized anchor reveal exactly once without an App scheduler', () => {
    const { body, scroller } = makeAppPanel()
    const reveal = vi.fn()
    const restore = vi.fn()
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    scroller.addEventListener(TRANSCRIPT_ANCHOR_REVEAL_EVENT, reveal)
    scroller.addEventListener(TRANSCRIPT_RESTORE_EVENT, restore)
    renderAppRestoration(body, { top: 317, anchorId: 'row-1', anchorOffset: -12 })

    expect(reveal).toHaveBeenCalledTimes(1)
    expect((reveal.mock.calls[0][0] as CustomEvent<Record<string, unknown>>).detail).toEqual({
      anchorId: 'row-1',
      anchorOffset: -12,
      fallbackTarget: 317,
    })
    expect(raf).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()

    addRestoreAnchor(scroller)
    act(() => { vi.advanceTimersByTime(16) })
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(restore).not.toHaveBeenCalled()
    raf.mockRestore()
  })

  it('does not install a second App-owned input listener lifecycle', () => {
    const { body, scroller } = makeAppPanel()
    const reveal = vi.fn()
    const restore = vi.fn()
    const addListener = vi.spyOn(scroller, 'addEventListener')
    scroller.addEventListener(TRANSCRIPT_ANCHOR_REVEAL_EVENT, reveal)
    scroller.addEventListener(TRANSCRIPT_RESTORE_EVENT, restore)
    renderAppRestoration(body, { top: 317, anchorId: 'row-1', anchorOffset: -12 })

    expect(reveal).toHaveBeenCalledTimes(1)
    for (const type of ['wheel', 'touchstart', 'touchmove', 'keydown', 'pointerdown']) {
      expect(addListener.mock.calls.some(([event]) => event === type)).toBe(false)
    }

    addRestoreAnchor(scroller)
    act(() => {
      fireEvent.wheel(scroller, { deltaY: -120 })
      vi.advanceTimersByTime(1000)
    })
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(restore).not.toHaveBeenCalled()
    addListener.mockRestore()
  })

  it('uses the restore owner event instead of an App-level direct writer', () => {
    const restoration = readFileSync(resolve(process.cwd(), 'src/app/useAppScrollRestoration.ts'), 'utf8')
    const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8')
    const start = app.indexOf('  // Scroll-position memory for panel reorders')
    const end = app.indexOf('  const endPanelExit', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const appRestoration = app.slice(start, end)

    expect(restoration).toContain('TRANSCRIPT_RESTORE_EVENT')
    expect(appRestoration).toContain('useAppScrollRestoration({')
    expect(appRestoration).toContain('panelScrollMemoryRef')
    for (const source of [restoration, appRestoration]) {
      expect(source).not.toMatch(/\.\s*scrollTop\s*=/)
      expect(source).not.toMatch(/\.\s*scrollTo\s*\(/)
      expect(source).not.toMatch(/\.\s*scrollToIndex\s*\(/)
    }
  })
})
