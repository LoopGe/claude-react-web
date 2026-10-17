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

const GAP_RING_CAP = 200
const LONGTASK_RING_CAP = 200
const MARK_RING_CAP = 50

interface FrameGapEvent { kind: 'frame-gap'; t: number; gapMs: number }
interface LongTaskEvent {
  kind: 'longtask'
  t: number
  durMs: number
  /** Coarse PerformanceObserver attribution, when the browser provides it. */
  attribution: string | null
}
export type JankEvent = FrameGapEvent | LongTaskEvent
export interface JankMark { kind: 'mark'; t: number; label: string }

const gaps: FrameGapEvent[] = []
const longTasks: LongTaskEvent[] = []
const marks: JankMark[] = []

function pushGap(event: FrameGapEvent): void {
  gaps.push(event)
  if (gaps.length > GAP_RING_CAP) gaps.shift()
}
function pushLongTask(event: LongTaskEvent): void {
  longTasks.push(event)
  if (longTasks.length > LONGTASK_RING_CAP) longTasks.shift()
}

let installed = false
let lastRaf = 0

function tick(now: number): void {
  const gap = now - lastRaf
  lastRaf = now
  // A huge gap right after the tab becomes visible again is the rAF pause
  // while hidden, not jank — visibilitychange resets lastRaf; this check
  // covers the tick that raced ahead of the visibilitychange handler.
  if (gap > FRAME_GAP_MS && !document.hidden) pushGap({ kind: 'frame-gap', t: now, gapMs: Math.round(gap) })
  requestAnimationFrame(tick)
}

export function installJankMonitor(): void {
  if (installed) return
  if (typeof window === 'undefined' || typeof requestAnimationFrame !== 'function') return
  installed = true

  lastRaf = performance.now()
  requestAnimationFrame(tick)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) lastRaf = performance.now()
  })

  // Measured on the user's Safari: the longtask entry type is ACCEPTED at
  // observe() time but no entries are delivered, even for a synthetic 120ms
  // busy loop (probe: entryTypes registration succeeds, longTasks stays 0).
  // So the frame-gap stream is the primary signal everywhere; where longtask
  // entries DO arrive (Chromium), they add the "main thread was busy" vs
  // "layout/style pass" distinction.
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration <= 0) continue
          // TaskAttributionTiming — coarse (which container/host) but enough
          // to split "app task" from "extension/other". Fine-grained
          // attribution stays a job for a manual DevTools trace. Cast: the
          // TS DOM lib does not model the longtask attribution array.
          const attr = (entry as PerformanceEntry & {
            attribution?: Array<{ containerType?: string; containerName?: string; containerSrc?: string }>
          }).attribution?.[0]
          const attribution =
            attr?.containerType || attr?.containerName || attr?.containerSrc || null
          pushLongTask({ kind: 'longtask', t: entry.startTime, durMs: Math.round(entry.duration), attribution })
        }
      }).observe({ entryTypes: ['longtask'] })
    } catch {
      // Unsupported entry type — frame gaps remain.
    }
  }
}

/** Stamp the current moment so a dump can correlate jank events with the
 *  action that triggered them ("user started scrolling NOW"). */
export function markJank(label: string): void {
  marks.push({ kind: 'mark', t: performance.now(), label })
  if (marks.length > MARK_RING_CAP) marks.shift()
}

export interface JankSummary {
  /** Wall-clock ms since install. */
  uptimeMs: number
  /** Event counts in the LAST 60s (the actionable window) and all time. */
  last60s: { frameGaps: number; longTasks: number }
  total: { frameGaps: number; longTasks: number; marks: number }
  maxGapMs: number
  /** Seconds since the most recent jank event (null if none). */
  secondsSinceLast: number | null
}

export function getJankSummary(): JankSummary {
  const now = performance.now()
  const windowStart = now - 60_000
  const countIn = <T extends { t: number }>(list: T[]): number =>
    list.filter((e) => e.t >= windowStart).length
  const lastJankT = Math.max(
    gaps.length > 0 ? gaps[gaps.length - 1].t : -1,
    longTasks.length > 0 ? longTasks[longTasks.length - 1].t : -1,
  )
  return {
    uptimeMs: Math.round(now),
    last60s: { frameGaps: countIn(gaps), longTasks: countIn(longTasks) },
    total: { frameGaps: gaps.length, longTasks: longTasks.length, marks: marks.length },
    maxGapMs: gaps.reduce((m, g) => Math.max(m, g.gapMs), 0),
    secondsSinceLast: lastJankT >= 0 ? Math.round((now - lastJankT) / 1000) : null,
  }
}

export function getRecentJankEvents(): { marks: JankMark[]; gaps: FrameGapEvent[]; longTasks: LongTaskEvent[] } {
  return { marks: [...marks], gaps: [...gaps], longTasks: [...longTasks] }
}

/** Test-only: reset all rings and the installed flag. */
export function resetJankMonitorForTests(): void {
  gaps.length = 0
  longTasks.length = 0
  marks.length = 0
  installed = false
}

if (typeof window !== 'undefined') {
  ;(window as unknown as {
    __crwDumpJank?: () => JankSummary & ReturnType<typeof getRecentJankEvents>
  }).__crwDumpJank = () => {
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
}
