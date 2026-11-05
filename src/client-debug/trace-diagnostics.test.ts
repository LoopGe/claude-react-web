// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TRACE_RECORD_OPTIONS,
  recordScrollDiagnostic,
  resetTraceDiagnosticsForTests,
  startTraceDiagnostics,
  stopTraceDiagnostics,
  traceDiagnosticsSnapshot,
  traceFoldEnd,
  traceFoldFrame,
  traceFoldIdFor,
  traceFoldStart,
  traceVisualActive,
  type TraceRecordOptions,
} from './trace-diagnostics'

function options(overrides: Partial<TraceRecordOptions>): TraceRecordOptions {
  return { ...DEFAULT_TRACE_RECORD_OPTIONS, ...overrides }
}

function foldDom() {
  const row = document.createElement('div')
  row.dataset.crwRowId = 'group-row'
  const body = document.createElement('div')
  body.className = 'animated-collapse'
  const content = document.createElement('div')
  content.className = 'animated-collapse-content'
  body.appendChild(content)
  row.appendChild(body)
  const next = document.createElement('div')
  next.dataset.crwRowId = 'next-row'
  document.body.append(row, next)
  return { row, body, content, next }
}

const foldDetails = { open: true, kind: 'fold' as const, from: 0, to: 100, writtenHeight: 20 }

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  resetTraceDiagnosticsForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('trace diagnostics recording gate', () => {
  it('does not emit events or read visual geometry while inactive', () => {
    const { body, next } = foldDom()
    const rect = vi.spyOn(next, 'getBoundingClientRect')

    traceFoldStart(body, foldDetails)
    traceFoldFrame(body, foldDetails)
    traceFoldEnd(body, 'settled', foldDetails)
    recordScrollDiagnostic('pin', { before: 10 })

    expect(traceDiagnosticsSnapshot().events).toEqual([])
    expect(rect).not.toHaveBeenCalled()
  })

  it('emits a correlated fold lifecycle only for foldScroll recording', () => {
    const { body } = foldDom()
    startTraceDiagnostics(options({ foldScroll: true, visual: false }))

    traceFoldStart(body, foldDetails)
    traceFoldFrame(body, { ...foldDetails, writtenHeight: 40 })
    traceFoldEnd(body, 'settled', { ...foldDetails, writtenHeight: 100 })

    const events = traceDiagnosticsSnapshot().events
    expect(events.map((event) => event.name)).toEqual(['fold-start', 'fold-frame', 'fold-settled'])
    expect(events.map((event) => event.args.foldId)).toEqual(['fold-1', 'fold-1', 'fold-1'])
    expect(events.every((event) => event.track === 'fold')).toBe(true)
    expect(events[1]?.args).toMatchObject({ open: true, kind: 'fold', writtenHeight: 40, rowId: 'group-row' })
    expect(traceFoldIdFor(body)).toBe('fold-1')
  })

  it('uses fold correlation for visual-only anchors without emitting fold events', () => {
    const { body, next } = foldDom()
    next.getBoundingClientRect = vi.fn()
      .mockReturnValueOnce({ top: 100 })
      .mockReturnValueOnce({ top: 120 })
    startTraceDiagnostics(options({ foldScroll: false, visual: true }))

    traceFoldStart(body, foldDetails)
    traceFoldFrame(body, { ...foldDetails, writtenHeight: 40 })

    const events = traceDiagnosticsSnapshot().events
    expect(events.map((event) => event.track)).toEqual(['visual', 'visual'])
    expect(events.map((event) => event.name)).toEqual(['visual-anchor', 'visual-anchor'])
    expect(events[0]?.args).toMatchObject({ foldId: 'fold-1', rowId: 'next-row', top: 100, delta: 0 })
    expect(events[1]?.args).toMatchObject({ foldId: 'fold-1', rowId: 'next-row', top: 120, delta: 20 })
  })

  it('gates scroll diagnostics to foldScroll recording', () => {
    recordScrollDiagnostic('pin', { before: 1 })
    expect(traceDiagnosticsSnapshot().events).toEqual([])

    startTraceDiagnostics(options({ foldScroll: true, visual: false }))
    recordScrollDiagnostic('pin', { before: 1 })

    expect(traceDiagnosticsSnapshot().events).toHaveLength(1)
    expect(traceDiagnosticsSnapshot().events[0]).toMatchObject({ track: 'scroll', name: 'pin', args: { before: 1 } })
  })

  it('does not shift the whole event array after the diagnostic ring saturates', () => {
    startTraceDiagnostics(options({ foldScroll: true, visual: false }))
    for (let i = 0; i < 20_000; i++) recordScrollDiagnostic('sample', { i })
    const shift = vi.spyOn(Array.prototype, 'shift')

    recordScrollDiagnostic('overflow', { i: 20_000 })
    shift.mockRestore()

    expect(shift).not.toHaveBeenCalled()
    expect(traceDiagnosticsSnapshot().events).toHaveLength(20_000)
    expect(traceDiagnosticsSnapshot().events.at(-1)?.name).toBe('overflow')
  })
})

describe('layout-shift recording', () => {
  class MockPerformanceObserver {
    static instances: MockPerformanceObserver[] = []
    disconnected = false
    pending: unknown[] = []
    constructor(readonly callback: (list: { getEntries: () => unknown[] }) => void) {
      MockPerformanceObserver.instances.push(this)
    }
    observe = vi.fn()
    takeRecords = vi.fn(() => this.pending)
    disconnect = vi.fn(() => { this.disconnected = true })
    emit(entries: unknown[]) {
      this.callback({ getEntries: () => entries })
    }
  }

  it('records source rows and rects, then disconnects on stop without clearing events', () => {
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver)
    const { next } = foldDom()
    startTraceDiagnostics(options({ foldScroll: false, visual: true }))
    const observer = MockPerformanceObserver.instances.at(-1)!
    expect(observer.observe).toHaveBeenCalledWith({ type: 'layout-shift', buffered: false })

    observer.emit([{
      startTime: 12,
      value: 0.125,
      hadRecentInput: true,
      sources: [{
        node: next,
        previousRect: { x: 1, y: 10, width: 200, height: 40 },
        currentRect: { x: 1, y: 30, width: 200, height: 40 },
      }],
    }])

    expect(traceDiagnosticsSnapshot().events[0]).toMatchObject({
      track: 'layout',
      name: 'layout-shift',
      args: {
        value: 0.125,
        hadRecentInput: true,
        sources: [{
          rowId: 'next-row',
          previousRect: { x: 1, y: 10, width: 200, height: 40 },
          currentRect: { x: 1, y: 30, width: 200, height: 40 },
        }],
      },
    })

    stopTraceDiagnostics()
    expect(observer.disconnected).toBe(true)
    expect(traceDiagnosticsSnapshot().events).toHaveLength(1)
    observer.emit([])
    expect(traceDiagnosticsSnapshot().events).toHaveLength(1)
  })

  it('drains queued layout shifts before stopping', () => {
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver)
    const { next } = foldDom()
    startTraceDiagnostics(options({ foldScroll: false, visual: true }))
    const observer = MockPerformanceObserver.instances.at(-1)!
    observer.pending = [{
      startTime: 20,
      value: 0.25,
      hadRecentInput: true,
      sources: [{
        node: next,
        previousRect: { x: 0, y: 10, width: 100, height: 20 },
        currentRect: { x: 0, y: 30, width: 100, height: 20 },
      }],
    }]

    stopTraceDiagnostics()

    expect(observer.takeRecords).toHaveBeenCalledOnce()
    expect(traceDiagnosticsSnapshot().events).toHaveLength(1)
    expect(traceDiagnosticsSnapshot().events[0]?.args).toMatchObject({ value: 0.25, hadRecentInput: true })
  })

  it('keeps Record usable when layout-shift observation is unsupported', () => {
    class UnsupportedObserver extends MockPerformanceObserver {
      observe = vi.fn(() => { throw new Error('unsupported entry type') })
    }
    vi.stubGlobal('PerformanceObserver', UnsupportedObserver)

    expect(() => startTraceDiagnostics(options({ foldScroll: true, visual: true }))).not.toThrow()
    expect(traceVisualActive()).toBe(true)
    expect(() => stopTraceDiagnostics()).not.toThrow()
  })
})
