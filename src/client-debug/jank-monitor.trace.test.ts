// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  DEFAULT_TRACE_RECORD_OPTIONS,
  recordScrollDiagnostic,
  resetTraceDiagnosticsForTests,
  startTraceDiagnostics,
} from './trace-diagnostics'
import {
  buildTrace,
  exportTrace,
  installJankMonitor,
  markJank,
  resetJankMonitorForTests,
  TRACE_THREADS,
  TRACE_WINDOW_MS,
  type TraceBuildInput,
  type TraceEvent,
} from './jank-monitor'

beforeEach(() => {
  resetJankMonitorForTests()
  resetTraceDiagnosticsForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const META: TraceBuildInput['meta'] = {
  url: 'http://localhost:5174/',
  userAgent: 'test-ua',
  timeOrigin: 1_000,
  generatedAt: 2_000,
}

function makeInput(overrides: Partial<TraceBuildInput> = {}): TraceBuildInput {
  return {
    now: 10_000,
    windowMs: 5_000,
    gaps: [],
    longTasks: [],
    loaf: [],
    measures: [],
    eventTimings: [],
    diagnostics: [],
    marks: [],
    meta: META,
    ...overrides,
  }
}

/** Data events only (metadata `M` rows are process/thread registration). */
function dataEvents(trace: ReturnType<typeof buildTrace>): TraceEvent[] {
  return trace.traceEvents.filter((e) => e.ph !== 'M')
}

function byCat(trace: ReturnType<typeof buildTrace>, cat: string): TraceEvent[] {
  return dataEvents(trace).filter((e) => e.cat === cat)
}

describe('buildTrace', () => {
  it('drops events that fall outside the requested window', () => {
    const trace = buildTrace(
      makeInput({
        gaps: [
          { kind: 'frame-gap', t: 4_000, gapMs: 40 }, // window starts at 5_000
          { kind: 'frame-gap', t: 6_000, gapMs: 80 },
        ],
      }),
    )
    const frames = byCat(trace, 'crw.frame')
    expect(frames).toHaveLength(1)
    // The gap covers [t - gapMs, t]; both edges are converted to microseconds.
    expect(frames[0]).toMatchObject({ ph: 'X', ts: 5_920_000, dur: 80_000, tid: TRACE_THREADS.frames })
  })

  it('converts long tasks from milliseconds to microseconds', () => {
    const trace = buildTrace(
      makeInput({
        longTasks: [{ kind: 'longtask', t: 7_000, durMs: 120, attribution: 'window' }],
      }),
    )
    const [task] = byCat(trace, 'crw.longtask')
    expect(task).toMatchObject({ ph: 'X', ts: 7_000_000, dur: 120_000, tid: TRACE_THREADS.main })
  })

  it('emits a LoAF frame plus one slice per script on a separate track', () => {
    const trace = buildTrace(
      makeInput({
        loaf: [
          {
            kind: 'loaf',
            t: 7_000,
            durMs: 118.5,
            blockingMs: 11.2,
            renderStart: 7_100,
            styleLayoutStart: 7_102,
            scripts: [
              {
                startTime: 7_000.6,
                duration: 48,
                sourceURL: 'http://localhost:5174/src/transport/web.ts',
                sourceFunctionName: '',
                invoker: 'DOMWebSocket.onmessage',
                invokerType: 'event-listener',
                forcedStyleAndLayoutDuration: 3.6,
                pauseDuration: 0,
              },
            ],
          },
        ],
      }),
    )

    const [frame] = byCat(trace, 'crw.loaf')
    expect(frame).toMatchObject({
      ph: 'X',
      ts: 7_000_000,
      dur: 118_500,
      tid: TRACE_THREADS.loaf,
      args: expect.objectContaining({ blockingMs: 11.2 }),
    })

    const [script] = byCat(trace, 'crw.script')
    expect(script).toMatchObject({
      ph: 'X',
      name: 'DOMWebSocket.onmessage',
      ts: 7_000_600,
      dur: 48_000,
      tid: TRACE_THREADS.scripts,
      args: expect.objectContaining({ sourceURL: 'http://localhost:5174/src/transport/web.ts' }),
    })
  })

  it('renders marks as instant events', () => {
    const trace = buildTrace(makeInput({ marks: [{ kind: 'mark', t: 8_000, label: 'scroll start' }] }))
    const [mark] = byCat(trace, 'crw.mark')
    expect(mark).toMatchObject({ ph: 'i', s: 't', name: 'mark: scroll start', ts: 8_000_000 })
  })

  it('strips React 19 component-measure zero-width-space prefixes', () => {
    const trace = buildTrace(
      makeInput({ measures: [{ kind: 'measure', t: 8_000, durMs: 2, name: '​MessageList' }] }),
    )
    const [measure] = byCat(trace, 'crw.react')
    expect(measure).toMatchObject({
      name: 'MessageList',
      ts: 8_000_000,
      dur: 2_000,
      tid: TRACE_THREADS.react,
    })
  })

  it('carries input-latency breakdown into event args', () => {
    const trace = buildTrace(
      makeInput({
        eventTimings: [
          {
            kind: 'event-timing',
            t: 6_000,
            durMs: 120,
            name: 'pointerdown',
            processingStart: 6_010,
            processingEnd: 6_020,
            interactionId: 5,
          },
        ],
      }),
    )
    const [input] = byCat(trace, 'crw.input')
    expect(input).toMatchObject({
      name: 'input: pointerdown',
      ts: 6_000_000,
      dur: 120_000,
      tid: TRACE_THREADS.input,
      args: { processingStart: 6_010, processingEnd: 6_020, interactionId: 5 },
    })
  })

  it('reads the live rings and carries browser metadata through exportTrace', () => {
    // Seed a real ring entry so a wrong ring→field mapping cannot pass.
    markJank('wiring probe')
    const trace = exportTrace({ windowMs: 1_000, now: 5_000 })
    expect(trace.crwRaw.meta.url).toBe(location.href)
    expect(trace.crwRaw.meta.userAgent).toBe(navigator.userAgent)
    expect(trace.crwRaw.now).toBe(5_000)
    expect(trace.crwRaw.marks.map((m) => m.label)).toContain('wiring probe')
    expect(byCat(trace, 'crw.mark').length).toBe(1)
    // The rings cannot reach past their horizon; a larger request is clamped
    // rather than silently exporting only its tail.
    expect(exportTrace({ windowMs: 120_000, now: 5_000 }).crwRaw.windowMs).toBe(TRACE_WINDOW_MS)
  })

  it('reports how much of the requested window the rings actually cover', () => {
    const partial = buildTrace(
      makeInput({
        now: 10_000,
        windowMs: 10_000,
        gaps: [{ kind: 'frame-gap', t: 7_000, gapMs: 40 }],
      }),
    )
    expect(partial.crwRaw.coverageMs).toBe(3_000)
    // Short but complete: nothing was evicted, so this is not "truncated".
    expect(partial.crwRaw.truncatedStreams).toEqual([])
    expect(partial.crwRaw.coversFullWindow).toBe(true)

    const full = buildTrace(
      makeInput({
        now: 10_000,
        windowMs: 10_000,
        gaps: [{ kind: 'frame-gap', t: 0, gapMs: 40 }],
      }),
    )
    expect(full.crwRaw.coverageMs).toBe(10_000)
    expect(full.crwRaw.coversFullWindow).toBe(true)
  })

  it('keeps marks that predate the window (the repro-start anchor)', () => {
    const trace = buildTrace(
      makeInput({
        now: 10_000,
        windowMs: 1_000,
        marks: [{ kind: 'mark', t: 2_000, label: 'repro start' }],
      }),
    )
    expect(byCat(trace, 'crw.mark')).toHaveLength(1)
    expect(trace.crwRaw.marks).toHaveLength(1)
  })

  it('reports the streams whose cap evicted events inside the window', () => {
    const trace = buildTrace(
      makeInput({
        now: 10_000,
        windowMs: 10_000,
        truncatedStreams: ['gaps'],
        gaps: [{ kind: 'frame-gap', t: 7_000, gapMs: 40 }],
      }),
    )
    expect(trace.crwRaw.truncatedStreams).toEqual(['gaps'])
    expect(trace.crwRaw.coversFullWindow).toBe(false)
  })

  it('registers process/thread metadata and keeps the raw source arrays', () => {
    const trace = buildTrace(makeInput())
    const meta = trace.traceEvents.filter((e) => e.ph === 'M')
    expect(meta.length).toBeGreaterThanOrEqual(8) // process + 7 tracks
    expect(meta).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'process_name', pid: 1 }),
        expect.objectContaining({ name: 'thread_name', tid: TRACE_THREADS.react }),
      ]),
    )
    expect(dataEvents(trace)).toHaveLength(0)
    expect(trace.displayTimeUnit).toBe('ms')
    expect(trace.crwRaw.meta).toEqual(META)
    expect(trace.crwRaw.now).toBe(10_000)
    expect(trace.crwRaw.windowMs).toBe(5_000)
  })

  it('serializes diagnostic events with their tracks and args', () => {
    const trace = buildTrace(makeInput({
      diagnostics: [
        { kind: 'diagnostic', t: 7_000, track: 'fold', name: 'fold-start', args: { foldId: 'fold-1' } },
        { kind: 'diagnostic', t: 7_100, track: 'layout', name: 'layout-shift', args: { value: 0.2 } },
      ],
    }))

    expect(byCat(trace, 'crw.fold')[0]).toMatchObject({
      ph: 'i', name: 'fold-start', ts: 7_000_000, tid: TRACE_THREADS.fold, args: { foldId: 'fold-1' },
    })
    expect(byCat(trace, 'crw.layout')[0]).toMatchObject({
      ph: 'i', name: 'layout-shift', ts: 7_100_000, tid: TRACE_THREADS.layout, args: { value: 0.2 },
    })
    expect(trace.crwRaw.diagnostics).toHaveLength(2)
    expect(trace.crwRaw.recordOptions).toBeNull()
  })

  it('filters base streams for Record and keeps diagnostics out of Capture', () => {
    const observers: Array<{ init: PerformanceObserverInit; emit: (entries: unknown[]) => void }> = []
    class MockPerformanceObserver {
      constructor(readonly callback: (list: { getEntries: () => unknown[] }) => void) {}
      observe(init: PerformanceObserverInit) {
        observers.push({ init, emit: (entries) => this.callback({ getEntries: () => entries }) })
      }
      disconnect() {}
    }
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver)
    installJankMonitor()
    for (const observer of observers) {
      if (observer.init.entryTypes?.includes('longtask')) {
        observer.emit([{ startTime: 1_000, duration: 80, attribution: [] }])
      }
      if (observer.init.type === 'measure') {
        observer.emit([{ startTime: 1_000, duration: 2, name: 'MessageList' }])
      }
      if (observer.init.type === 'event') {
        observer.emit([{ startTime: 1_000, duration: 20, name: 'click', processingStart: 1_001, processingEnd: 1_002, interactionId: 9 }])
      }
    }
    startTraceDiagnostics({ ...DEFAULT_TRACE_RECORD_OPTIONS, performance: false, reactInput: false, visual: false })
    recordScrollDiagnostic('pin', { before: 10 })

    const record = exportTrace({
      windowMs: 5_000,
      now: 5_000,
      recordOptions: { ...DEFAULT_TRACE_RECORD_OPTIONS, performance: false, reactInput: false, visual: false },
    })
    expect(record.crwRaw.longTasks).toEqual([])
    expect(record.crwRaw.measures).toEqual([])
    expect(record.crwRaw.eventTimings).toEqual([])
    expect(record.crwRaw.diagnostics).toHaveLength(1)
    expect(record.crwRaw.recordOptions).toMatchObject({ performance: false, reactInput: false, visual: false })

    const capture = exportTrace({ windowMs: 5_000, now: 5_000 })
    expect(capture.crwRaw.longTasks).toHaveLength(1)
    expect(capture.crwRaw.measures).toHaveLength(1)
    expect(capture.crwRaw.eventTimings).toHaveLength(1)
    expect(capture.crwRaw.diagnostics).toEqual([])
    expect(capture.crwRaw.recordOptions).toBeNull()
  })

  it('does not report truncation for streams excluded from Record', () => {
    const observers: Array<{ init: PerformanceObserverInit; emit: (entries: unknown[]) => void }> = []
    class MockPerformanceObserver {
      constructor(readonly callback: (list: { getEntries: () => unknown[] }) => void) {}
      observe(init: PerformanceObserverInit) {
        observers.push({ init, emit: (entries) => this.callback({ getEntries: () => entries }) })
      }
      disconnect() {}
    }
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver)
    installJankMonitor()
    const longtask = observers.find((observer) => observer.init.entryTypes?.includes('longtask'))!
    longtask.emit(Array.from({ length: 2_001 }, (_, i) => ({ startTime: i + 1, duration: 80, attribution: [] })))
    const recordOptions = { ...DEFAULT_TRACE_RECORD_OPTIONS, performance: false, reactInput: false, visual: false }
    startTraceDiagnostics(recordOptions)

    const trace = exportTrace({ windowMs: 5_000, now: 5_000, recordOptions })

    expect(trace.crwRaw.longTasks).toEqual([])
    expect(trace.crwRaw.truncatedStreams).not.toContain('longTasks')
    expect(trace.crwRaw.coversFullWindow).toBe(true)
  })

  it('reports diagnostic ring eviction as a truncated stream', () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => ++now)
    startTraceDiagnostics({ ...DEFAULT_TRACE_RECORD_OPTIONS, visual: false })
    for (let i = 0; i < 20_001; i++) recordScrollDiagnostic('sample', { i })

    const trace = exportTrace({
      windowMs: 60_000,
      now: 60_000,
      recordOptions: { ...DEFAULT_TRACE_RECORD_OPTIONS, visual: false },
    })
    expect(trace.crwRaw.diagnostics).toHaveLength(20_000)
    expect(trace.crwRaw.truncatedStreams).toContain('diagnostics')
    expect(trace.crwRaw.coversFullWindow).toBe(false)
  })
})
