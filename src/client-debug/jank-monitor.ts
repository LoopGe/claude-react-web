// Dev-only client jank monitor: answers "is scrolling ACTUALLY dropping
// frames, how often, and around when" without needing a probe re-installed
// from the console every session (the ad-hoc dom_eval probes used during the
// scroll-jitter investigation died with every reload — three times in one
// investigation).
//
// Installed once at boot (src/main.tsx, inside the DEV gate next to
// installConsoleCapture). Production bundles ship nothing of this module —
// the install call is inside `import.meta.env.DEV`, same cost discipline as
// the console ring.
//
// What it tracks, per frame / per task:
//   - FRAME GAPS: one rAF callback per frame measures the interval since the
//     previous one. A gap over FRAME_GAP_MS means the compositor starved —
//     either main-thread work ate a frame or the event loop stalled. This is
//     the primary signal; it catches drops the longtask observer misses
//     (tasks < 50ms can still cost a 16.7ms frame).
//   - LONGTASKS: PerformanceObserver('longtask') for tasks > 50ms, with the
//     browser's coarse attribution (containerType/containerName) when present.
//     Correlates a frame gap with "the main thread was busy" vs "nothing ran
//     but the frame still didn't paint" (e.g. a huge style/layout pass —
//     force-layout from a measurement read — which produces a gap but no
//     longtask).
//
// The two streams are deliberately KEPT SEPARATE: a frame gap WITHOUT a
// longtask is the signature of layout/style thrash; a longtask WITHOUT a gap
// means the task fit inside a frame. That distinction was exactly how the
// scroll-jitter investigation split "position bounce" from "render jank".
//
// Reading side: `__crwDumpJank()` (console + return value — the appdebug
// dom_eval bridge can read the returned object directly) and
// `__crwJankMark(label)` to stamp a repro window so events can be correlated
// with the user's action after the fact.

const FRAME_GAP_MS = 32
// > 2 frames at 60Hz (~33ms), ~4 at 120Hz — a real compositor stall on any
// display, not single-frame noise on a ProMotion screen.

/** Longer gaps are tab suspension/background time, not a dropped frame. The
 *  first rAF tick after a resume can run before the visibilitychange listener
 *  (both orderings are observed), so `document.hidden` alone cannot filter it;
 *  a multi-second gap would otherwise dominate every trace as a fake stall. */
const MAX_PLAUSIBLE_GAP_MS = 5000

// Caps sized so a full 60s window survives at realistic rates: a 120Hz
// display can produce 7200 frame gaps, and React can emit tens of thousands
// of component measures. The export reports its actual coverage so a cap that
// does bind is visible in the file instead of silently shortening it.
const GAP_RING_CAP = 8000
const LONGTASK_RING_CAP = 2000
const LOAF_RING_CAP = 2000
const MEASURE_RING_CAP = 20_000
const EVENT_TIMING_RING_CAP = 4000
const MARK_RING_CAP = 50

/** Hard horizon for every ring: a long-lived dev tab keeps at most the last
 *  minute, regardless of how many events land. Exported so the record button's
 *  cap and the trace window cannot drift apart. */
export const TRACE_WINDOW_MS = 60_000

/** React 19 dev emits one measure per component render; sub-millisecond
 *  renders are dropped so the ring stays a useful size. */
const MEASURE_MIN_MS = 1

/** React 19 prefixes its component measures with U+200B (zero-width space).
 *  Built from the code point rather than a literal so the source carries no
 *  irregular whitespace. */
const ZWSP_PREFIX = new RegExp('^' + String.fromCharCode(0x200b) + '+')

/** The synthetic tracks a trace export places events on. Chrome Trace Event
 *  Format has no thread semantics of its own; these ids only group related
 *  slices so Perfetto renders them as separate rows. */
export const TRACE_THREADS = {
  main: 1,
  frames: 2,
  loaf: 3,
  scripts: 4,
  react: 5,
  input: 6,
  marks: 7,
} as const

interface FrameGapEvent {
  kind: 'frame-gap'
  t: number
  gapMs: number
}
interface LongTaskEvent {
  kind: 'longtask'
  t: number
  durMs: number
  /** Coarse PerformanceObserver attribution, when the browser provides it. */
  attribution: string | null
}
export type JankEvent = FrameGapEvent | LongTaskEvent
export interface JankMark {
  kind: 'mark'
  t: number
  label: string
}

/** One script slice inside a long animation frame. Every time value is
 *  page-relative (the same origin as performance.now()) — verified against a
 *  live Chrome trace, not assumed from the spec wording. */
export interface LoafScriptEvent {
  startTime: number
  duration: number
  sourceURL: string
  sourceFunctionName: string
  invoker: string
  invokerType: string
  forcedStyleAndLayoutDuration: number
  pauseDuration: number
}
export interface LoafEvent {
  kind: 'loaf'
  t: number
  durMs: number
  blockingMs: number
  renderStart: number
  styleLayoutStart: number
  scripts: LoafScriptEvent[]
}
export interface MeasureEvent {
  kind: 'measure'
  t: number
  durMs: number
  name: string
}
export interface EventTimingEvent {
  kind: 'event-timing'
  t: number
  durMs: number
  name: string
  processingStart: number
  processingEnd: number
  interactionId: number
}

/** Event Timing also reports hover events (pointerenter/leave/over/out,
 *  mouseover/out) with interactionId 0. They carry no interaction and only
 *  add "time until next paint" noise — in a real scroll trace they were
 *  1291 of 1294 entries. Keep real interactions only. */
export function isInteractionTiming(entry: { interactionId: number }): boolean {
  return entry.interactionId > 0
}

/** Fixed-capacity event ring with O(1) amortized push. The naive
 *  shift/splice version moved the whole array on every push once at capacity —
 *  measurable inside the `measure` observer exactly when frames are tight. */
class EventRing<T extends { t: number }> {
  private buf: T[] = []
  private head = 0
  /** Page-relative time of the newest event the CAP evicted (0 = never).
   *  Horizon trims do not count: the 60s window is the documented contract. */
  private capDroppedAt = 0
  /** `keepPastWindow` opts out of the horizon (marks only: a repro can outlive
   *  the window and the start mark is the one thing the workflow must not
   *  lose). */
  constructor(
    private readonly cap: number,
    private readonly keepPastWindow = false,
  ) {}

  push(event: T): void {
    this.buf.push(event)
    if (!this.keepPastWindow) {
      const cutoff = event.t - TRACE_WINDOW_MS
      while (this.head < this.buf.length && this.buf[this.head].t < cutoff) this.head++
    }
    const live = this.buf.length - this.head
    if (live > this.cap) {
      const overflow = live - this.cap
      this.capDroppedAt = this.buf[this.head + overflow - 1].t
      this.head += overflow
    }
    // Reclaim the dead prefix in one move once it is worth the copy.
    if (this.head > this.cap) {
      this.buf = this.buf.slice(this.head)
      this.head = 0
    }
  }

  /** 0 when the cap has never evicted an event. */
  get capDroppedAtTime(): number {
    return this.capDroppedAt
  }

  /** Read-side trim: a ring that stopped receiving events would otherwise keep
   *  stale entries past the horizon forever (an idle tab with one 10-minute-old
   *  long task must not report it as retained). */
  private headAt(now: number): number {
    if (this.keepPastWindow) return this.head
    const cutoff = now - TRACE_WINDOW_MS
    let start = this.head
    while (start < this.buf.length && this.buf[start].t < cutoff) start++
    return start
  }

  sizeAt(now = performance.now()): number {
    return this.buf.length - this.headAt(now)
  }

  toArray(now = performance.now()): T[] {
    return this.buf.slice(this.headAt(now))
  }

  clear(): void {
    this.buf = []
    this.head = 0
    this.capDroppedAt = 0
  }
}

const gaps = new EventRing<FrameGapEvent>(GAP_RING_CAP)
const longTasks = new EventRing<LongTaskEvent>(LONGTASK_RING_CAP)
const loafEvents = new EventRing<LoafEvent>(LOAF_RING_CAP)
const measures = new EventRing<MeasureEvent>(MEASURE_RING_CAP)
const eventTimings = new EventRing<EventTimingEvent>(EVENT_TIMING_RING_CAP)
const marks = new EventRing<JankMark>(MARK_RING_CAP, true)

/** Last jank event time, kept outside the rings so `secondsSinceLast` can
 *  still answer after the event itself ages past the 60s horizon. */
let lastJankAt = 0

function pushGap(event: FrameGapEvent): void {
  gaps.push(event)
  lastJankAt = event.t
}
function pushLongTask(event: LongTaskEvent): void {
  longTasks.push(event)
  lastJankAt = event.t
}
function pushLoaf(event: LoafEvent): void {
  loafEvents.push(event)
}
function pushMeasure(event: MeasureEvent): void {
  measures.push(event)
}
function pushEventTiming(event: EventTimingEvent): void {
  eventTimings.push(event)
}

let installed = false
let lastRaf = 0
let rafId: number | null = null
/** Page-relative time the page was hidden (0 = visible). The first rAF after
 *  a resume can run BEFORE the visibilitychange listener: `document.hidden` is
 *  already false, but the HIDE handler has set this flag, so the hidden
 *  interval is never recorded as a frame stall. */
let hiddenSince = 0
const observers: PerformanceObserver[] = []
let visibilityHandler: (() => void) | null = null

function tick(now: number): void {
  const gap = now - lastRaf
  lastRaf = now
  if (gap > FRAME_GAP_MS && gap <= MAX_PLAUSIBLE_GAP_MS && !document.hidden && hiddenSince === 0) {
    pushGap({ kind: 'frame-gap', t: now, gapMs: Math.round(gap) })
  }
  rafId = requestAnimationFrame(tick)
}

/** The DOM lib in this repo's TypeScript version does not model the LoAF
 *  entry (or its script children), so the recorder reads the shape it needs
 *  through a local view. */
interface LoafEntryLike {
  startTime: number
  duration: number
  blockingDuration: number
  renderStart: number
  styleAndLayoutStart: number
  scripts: Array<{
    startTime: number
    duration: number
    sourceURL: string
    sourceFunctionName: string
    invoker: string
    invokerType: string
    forcedStyleAndLayoutDuration: number
    pauseDuration: number
  }>
}
interface EventTimingEntryLike {
  startTime: number
  duration: number
  name: string
  processingStart: number
  processingEnd: number
  interactionId: number
}

/** Install one entry-type observer. `observe()` throws when this browser
 *  doesn't support the type (the longtask note below records the Safari
 *  case); the remaining streams keep working. */
function observeType(
  // `durationThreshold` is part of the Event Timing init but missing from this
  // TS DOM lib's PerformanceObserverInit.
  init: PerformanceObserverInit & { durationThreshold?: number },
  onEntries: (entries: PerformanceEntry[]) => void,
): void {
  if (typeof PerformanceObserver === 'undefined') return
  try {
    const observer = new PerformanceObserver((list) => onEntries(list.getEntries()))
    observer.observe(init)
    observers.push(observer)
  } catch {
    // Unsupported entry type in this browser.
  }
}

export function installJankMonitor(): void {
  if (installed) return
  if (typeof window === 'undefined' || typeof requestAnimationFrame !== 'function') return
  installed = true

  lastRaf = performance.now()
  // The tab may already be hidden at install (background tab, restored
  // desktop window); no hide event will fire, so seed the flag here.
  hiddenSince = document.hidden ? performance.now() : 0
  rafId = requestAnimationFrame(tick)
  visibilityHandler = () => {
    if (document.hidden) {
      hiddenSince = performance.now()
    } else {
      lastRaf = performance.now()
      hiddenSince = 0
    }
  }
  document.addEventListener('visibilitychange', visibilityHandler)

  // Measured on the user's Safari: the longtask entry type is ACCEPTED at
  // observe() time but no entries are delivered, even for a synthetic 120ms
  // busy loop (probe: entryTypes registration succeeds, longTasks stays 0).
  // So the frame-gap stream is the primary signal everywhere; where longtask
  // entries DO arrive (Chromium), they add the "main thread was busy" vs
  // "layout/style pass" distinction.
  observeType({ entryTypes: ['longtask'] }, (entries) => {
    for (const entry of entries) {
      if (entry.duration <= 0) continue
      // TaskAttributionTiming — coarse (which container/host) but enough
      // to split "app task" from "extension/other". Fine-grained
      // attribution stays a job for a manual DevTools trace. Cast: the
      // TS DOM lib does not model the longtask attribution array.
      const attr = (
        entry as PerformanceEntry & {
          attribution?: Array<{ containerType?: string; containerName?: string; containerSrc?: string }>
        }
      ).attribution?.[0]
      const attribution = attr?.containerType || attr?.containerName || attr?.containerSrc || null
      pushLongTask({ kind: 'longtask', t: entry.startTime, durMs: Math.round(entry.duration), attribution })
    }
  })

  // Long animation frames: per-frame script attribution. Chromium-only, and
  // the single most useful signal for "which callback blocked this frame".
  observeType({ type: 'long-animation-frame' }, (entries) => {
    for (const entry of entries) {
      const e = entry as unknown as LoafEntryLike
      pushLoaf({
        kind: 'loaf',
        t: e.startTime,
        durMs: e.duration,
        blockingMs: e.blockingDuration,
        renderStart: e.renderStart,
        styleLayoutStart: e.styleAndLayoutStart,
        scripts: e.scripts.map((s) => ({
          startTime: s.startTime,
          duration: s.duration,
          sourceURL: s.sourceURL,
          sourceFunctionName: s.sourceFunctionName,
          invoker: s.invoker,
          invokerType: s.invokerType,
          forcedStyleAndLayoutDuration: s.forcedStyleAndLayoutDuration,
          pauseDuration: s.pauseDuration,
        })),
      })
    }
  })

  // React 19 dev publishes one measure per component render. Store plain
  // fields only — retaining PerformanceMeasure objects in a long-lived dev
  // tab is exactly the Blink/Oilpan growth main.tsx trims every 30s.
  observeType({ type: 'measure' }, (entries) => {
    for (const entry of entries) {
      if (entry.duration < MEASURE_MIN_MS) continue
      pushMeasure({ kind: 'measure', t: entry.startTime, durMs: entry.duration, name: entry.name })
    }
  })

  // Input latency: the event-timing breakdown behind INP.
  observeType({ type: 'event', durationThreshold: 16 }, (entries) => {
    for (const entry of entries) {
      const e = entry as unknown as EventTimingEntryLike
      if (!isInteractionTiming(e)) continue
      pushEventTiming({
        kind: 'event-timing',
        t: e.startTime,
        durMs: e.duration,
        name: e.name,
        processingStart: e.processingStart,
        processingEnd: e.processingEnd,
        interactionId: e.interactionId,
      })
    }
  })
}

/** Stamp the current moment so a dump can correlate jank events with the
 *  action that triggered them ("user started scrolling NOW"). */
export function markJank(label: string): void {
  marks.push({ kind: 'mark', t: performance.now(), label })
}

export interface JankSummary {
  /** Wall-clock ms since install. */
  uptimeMs: number
  /** Event counts in the LAST 60s (the actionable window). */
  last60s: { frameGaps: number; longTasks: number }
  /** Counts in the retained rings (≤60s; caps can shorten it further). */
  retained: { frameGaps: number; longTasks: number; marks: number }
  maxGapMs: number
  /** Seconds since the most recent jank event (null if none). */
  secondsSinceLast: number | null
}

export function getJankSummary(): JankSummary {
  const now = performance.now()
  // toArray(now) already applies the TRACE_WINDOW_MS horizon, so these are
  // the last-60s lists; no second filter is needed.
  const gapList = gaps.toArray(now)
  const taskList = longTasks.toArray(now)
  return {
    uptimeMs: Math.round(now),
    last60s: { frameGaps: gapList.length, longTasks: taskList.length },
    retained: { frameGaps: gapList.length, longTasks: taskList.length, marks: marks.sizeAt(now) },
    maxGapMs: gapList.reduce((m, g) => Math.max(m, g.gapMs), 0),
    secondsSinceLast: lastJankAt > 0 ? Math.round((now - lastJankAt) / 1000) : null,
  }
}

export function getRecentJankEvents(): {
  marks: JankMark[]
  gaps: FrameGapEvent[]
  longTasks: LongTaskEvent[]
} {
  return { marks: marks.toArray(), gaps: gaps.toArray(), longTasks: longTasks.toArray() }
}

/** Chrome Trace Event Format (the dialect Perfetto reads). `ts`/`dur` are
 *  microseconds; `ph: 'M'` registers the synthetic process/threads. */
export interface TraceEvent {
  ph: 'M' | 'X' | 'i'
  name: string
  cat?: string
  ts: number
  dur?: number
  pid: number
  /** Absent on process-level `M` rows. */
  tid?: number
  s?: 't'
  args?: Record<string, unknown>
}

/** The time-windowed sampled streams. Marks are excluded: they are manual
 *  anchors retained past the window on purpose. */
export type TraceStream = 'gaps' | 'longTasks' | 'loaf' | 'measures' | 'eventTimings'

export interface TraceBuildInput {
  now: number
  windowMs: number
  gaps: FrameGapEvent[]
  longTasks: LongTaskEvent[]
  loaf: LoafEvent[]
  measures: MeasureEvent[]
  eventTimings: EventTimingEvent[]
  marks: JankMark[]
  /** Streams whose ring cap evicted events inside this window. Computed by
   *  exportTrace from the ring's own eviction record, not inferred from the
   *  array length. */
  truncatedStreams?: TraceStream[]
  meta: { url: string; userAgent: string; timeOrigin: number; generatedAt: number }
}

export interface TraceFile {
  traceEvents: TraceEvent[]
  displayTimeUnit: 'ms'
  /** The unfiltered-by-format source rows for the window, for script analysis;
   *  Perfetto ignores this top-level key. */
  crwRaw: {
    now: number
    windowMs: number
    /** Time span actually represented by the retained events (≤ windowMs). */
    coverageMs: number
    /** False only when a stream's cap evicted events inside the window (see
     *  `truncatedStreams`). A short-but-complete timeline is described by
     *  `coverageMs`, not by this flag. */
    coversFullWindow: boolean
    /** Streams whose cap evicted events inside the window, so older events in
     *  that stream are missing from the file. */
    truncatedStreams: TraceStream[]
    gaps: FrameGapEvent[]
    longTasks: LongTaskEvent[]
    loaf: LoafEvent[]
    measures: MeasureEvent[]
    eventTimings: EventTimingEvent[]
    marks: JankMark[]
    meta: TraceBuildInput['meta']
  }
}

const us = (ms: number): number => Math.round(ms * 1000)

function inWindow<T extends { t: number }>(events: T[], since: number): T[] {
  return events.filter((e) => e.t >= since)
}

/** Pure builder: filter to the window, then emit one trace event per signal.
 *  Frame gaps cover [t - gapMs, t]; LoAF script times are already absolute. */
export function buildTrace(input: TraceBuildInput): TraceFile {
  const since = input.now - input.windowMs
  const pid = 1
  const windowGaps = inWindow(input.gaps, since)
  const windowLongTasks = inWindow(input.longTasks, since)
  const windowLoaf = inWindow(input.loaf, since)
  const windowMeasures = inWindow(input.measures, since)
  const windowEventTimings = inWindow(input.eventTimings, since)
  // Marks are retained past the window on purpose; a repro-start anchor must
  // survive even when the capture click happens minutes later.
  const windowMarks = input.marks

  // Coverage is informational (how much timeline the file represents); data
  // LOSS is the caller's eviction record, never inferred from array length.
  const truncatedStreams = input.truncatedStreams ?? []
  let oldestRetained = Infinity
  for (const list of [input.gaps, input.longTasks, input.loaf, input.measures, input.eventTimings]) {
    for (const event of list) oldestRetained = Math.min(oldestRetained, event.t)
  }
  const coverageMs = Number.isFinite(oldestRetained)
    ? Math.min(input.windowMs, Math.max(0, input.now - oldestRetained))
    : 0
  const coversFullWindow = truncatedStreams.length === 0

  const events: TraceEvent[] = [
    { ph: 'M', name: 'process_name', ts: 0, pid, args: { name: 'claude-react-web (dev)' } },
    ...Object.entries(TRACE_THREADS).map(([name, tid]) => ({
      ph: 'M' as const,
      name: 'thread_name',
      ts: 0,
      pid,
      tid,
      args: { name },
    })),
  ]
  const data: TraceEvent[] = []

  for (const g of windowGaps) {
    data.push({
      ph: 'X',
      name: 'frame gap',
      cat: 'crw.frame',
      ts: us(g.t - g.gapMs),
      dur: us(g.gapMs),
      pid,
      tid: TRACE_THREADS.frames,
    })
  }
  for (const t of windowLongTasks) {
    data.push({
      ph: 'X',
      name: 'long task',
      cat: 'crw.longtask',
      ts: us(t.t),
      dur: us(t.durMs),
      pid,
      tid: TRACE_THREADS.main,
      args: { attribution: t.attribution },
    })
  }
  for (const l of windowLoaf) {
    data.push({
      ph: 'X',
      name: 'long animation frame',
      cat: 'crw.loaf',
      ts: us(l.t),
      dur: us(l.durMs),
      pid,
      tid: TRACE_THREADS.loaf,
      args: { blockingMs: l.blockingMs, renderStart: l.renderStart, styleLayoutStart: l.styleLayoutStart },
    })
    for (const s of l.scripts) {
      data.push({
        ph: 'X',
        name: s.sourceFunctionName || s.invoker || 'script',
        cat: 'crw.script',
        ts: us(s.startTime),
        dur: us(s.duration),
        pid,
        tid: TRACE_THREADS.scripts,
        args: {
          invoker: s.invoker,
          invokerType: s.invokerType,
          sourceURL: s.sourceURL,
          sourceFunctionName: s.sourceFunctionName,
          forcedStyleAndLayoutDuration: s.forcedStyleAndLayoutDuration,
          pauseDuration: s.pauseDuration,
        },
      })
    }
  }
  for (const m of windowMeasures) {
    data.push({
      ph: 'X',
      name: m.name.replace(ZWSP_PREFIX, ''),
      cat: 'crw.react',
      ts: us(m.t),
      dur: us(m.durMs),
      pid,
      tid: TRACE_THREADS.react,
    })
  }
  for (const e of windowEventTimings) {
    data.push({
      ph: 'X',
      name: `input: ${e.name}`,
      cat: 'crw.input',
      ts: us(e.t),
      dur: us(e.durMs),
      pid,
      tid: TRACE_THREADS.input,
      args: {
        processingStart: e.processingStart,
        processingEnd: e.processingEnd,
        interactionId: e.interactionId,
      },
    })
  }
  for (const m of windowMarks) {
    data.push({
      ph: 'i',
      name: `mark: ${m.label}`,
      cat: 'crw.mark',
      ts: us(m.t),
      s: 't',
      pid,
      tid: TRACE_THREADS.marks,
    })
  }

  data.sort((a, b) => a.ts - b.ts)
  return {
    traceEvents: [...events, ...data],
    displayTimeUnit: 'ms',
    crwRaw: {
      now: input.now,
      windowMs: input.windowMs,
      coverageMs,
      coversFullWindow,
      truncatedStreams,
      gaps: windowGaps,
      longTasks: windowLongTasks,
      loaf: windowLoaf,
      measures: windowMeasures,
      eventTimings: windowEventTimings,
      marks: windowMarks,
      meta: input.meta,
    },
  }
}

/** Snapshot the live rings into a trace file. The caller decides what to do
 *  with it (the dev button downloads it; `__crwTrace()` returns it). */
export function exportTrace(opts: { windowMs: number; now?: number }): TraceFile {
  const now = opts.now ?? performance.now()
  // The rings cannot reach past TRACE_WINDOW_MS; a larger request would
  // silently drop its first half while still claiming full coverage.
  const windowMs = Math.min(opts.windowMs, TRACE_WINDOW_MS)
  const since = now - windowMs
  // Truncation comes from each ring's own cap-eviction record. Only drops that
  // happened INSIDE this window matter; older drops are outside the file.
  const rings: Array<[TraceStream, { capDroppedAtTime: number }]> = [
    ['gaps', gaps],
    ['longTasks', longTasks],
    ['loaf', loafEvents],
    ['measures', measures],
    ['eventTimings', eventTimings],
  ]
  const truncatedStreams = rings
    .filter(([, ring]) => ring.capDroppedAtTime > 0 && ring.capDroppedAtTime >= since)
    .map(([name]) => name)

  return buildTrace({
    now,
    windowMs,
    gaps: gaps.toArray(),
    longTasks: longTasks.toArray(),
    loaf: loafEvents.toArray(),
    measures: measures.toArray(),
    eventTimings: eventTimings.toArray(),
    marks: marks.toArray(),
    truncatedStreams,
    meta: {
      url: location.href,
      userAgent: navigator.userAgent,
      timeOrigin: performance.timeOrigin,
      generatedAt: Date.now(),
    },
  })
}

/** One-line trace summary shared by `__crwTrace()` and the dev button, so the
 *  two diagnostics cannot drift. */
export function formatTraceSummary(trace: TraceFile): string {
  const coverage = `coverage ${Math.round(trace.crwRaw.coverageMs)} of ${Math.round(trace.crwRaw.windowMs)} ms`
  const loss = trace.crwRaw.truncatedStreams.length
    ? ` (missing older events: ${trace.crwRaw.truncatedStreams.join(', ')})`
    : ''
  return `${trace.traceEvents.length} events, ${coverage}${loss}`
}

/** Test-only: stop the previous install (rAF loop, visibility listener,
 *  observers) and clear every ring. Without the teardown, each reset+install
 *  cycle stacked another loop and another set of observers onto the shared
 *  module-level rings. */
export function resetJankMonitorForTests(): void {
  if (rafId != null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  for (const observer of observers) observer.disconnect()
  observers.length = 0
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler)
    visibilityHandler = null
  }
  hiddenSince = 0
  lastJankAt = 0
  gaps.clear()
  longTasks.clear()
  loafEvents.clear()
  measures.clear()
  eventTimings.clear()
  marks.clear()
  installed = false
}

// DEV gate on the window hooks: this top-level assignment is a side effect, so
// without it the whole module (trace builder included) survives production
// tree-shaking even though only the install call is DEV-gated.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(
    window as unknown as {
      __crwDumpJank?: () => JankSummary & ReturnType<typeof getRecentJankEvents>
    }
  ).__crwDumpJank = () => {
    const summary = getJankSummary()
    const events = getRecentJankEvents()
    // User-facing dump (same rationale as the other __crw* dumps). The full
    // event lists ride along so a reader can correlate per-event timestamps
    // with the marks — the summary alone hides "which gap was during the
    // scroll".
    console.log('[jank] summary', summary)
    return { ...summary, ...events }
  }
  ;(window as unknown as { __crwJankMark?: (label: string) => void }).__crwJankMark = (label: string) => {
    markJank(label)
  }
  ;(window as unknown as { __crwTrace?: (windowMs?: number) => TraceFile }).__crwTrace = (
    windowMs = 10_000,
  ) => {
    const trace = exportTrace({ windowMs })
    console.log('[trace]', formatTraceSummary(trace))
    return trace
  }
}
