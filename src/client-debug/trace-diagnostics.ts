// Recording-scoped fold/scroll/visual diagnostics. All expensive geometry reads
// are gated by an explicit manual Record session; normal app activity only hits
// a boolean check at the instrumentation call sites.

export interface TraceRecordOptions {
  performance: boolean
  reactInput: boolean
  foldScroll: boolean
  visual: boolean
}

export const DEFAULT_TRACE_RECORD_OPTIONS: TraceRecordOptions = {
  performance: true,
  reactInput: true,
  foldScroll: true,
  visual: true,
}

export interface TraceDiagnosticEvent {
  kind: 'diagnostic'
  t: number
  track: 'fold' | 'scroll' | 'visual' | 'layout'
  name: string
  args: Record<string, unknown>
}

export interface TraceFoldDetails {
  open: boolean
  kind: 'fold' | 'resize'
  from: number
  to: number
  writtenHeight: number
}

const DIAGNOSTIC_CAP = 20_000

let activeOptions: TraceRecordOptions | null = null
let events: TraceDiagnosticEvent[] = []
let eventHead = 0
let capDroppedAtTime = 0
let nextFoldId = 1
let foldIds = new WeakMap<HTMLElement, string>()
const anchorBaselines = new Map<string, number>()
let layoutShiftObserver: PerformanceObserver | null = null

export function traceFoldScrollActive(): boolean {
  return activeOptions?.foldScroll === true
}

export function traceVisualActive(): boolean {
  return activeOptions?.visual === true
}

function push(track: TraceDiagnosticEvent['track'], name: string, t: number, args: Record<string, unknown>): void {
  if (events.length - eventHead >= DIAGNOSTIC_CAP) {
    capDroppedAtTime = events[eventHead]?.t ?? t
    eventHead++
  }
  events.push({ kind: 'diagnostic', t, track, name, args })
  if (eventHead > DIAGNOSTIC_CAP) {
    events = events.slice(eventHead)
    eventHead = 0
  }
}

function rowIdFor(el: Element | null): string | null {
  return el?.getAttribute('data-crw-row-id') ?? null
}

function foldArgs(body: HTMLElement, foldId: string, details: TraceFoldDetails): Record<string, unknown> {
  const content = body.querySelector<HTMLElement>('.animated-collapse-content')
  return {
    ...details,
    foldId,
    rowId: rowIdFor(body.closest('[data-crw-row-id]')),
    bodyUsedHeight: body.offsetHeight,
    contentHeight: content?.offsetHeight ?? null,
  }
}

function recordVisualAnchor(body: HTMLElement, foldId: string): void {
  if (!traceVisualActive()) return
  const row = body.closest('[data-crw-row-id]')
  const next = row?.nextElementSibling ?? null
  if (!next) return
  const top = next.getBoundingClientRect().top
  const previous = anchorBaselines.get(foldId)
  anchorBaselines.set(foldId, top)
  push('visual', 'visual-anchor', performance.now(), {
    foldId,
    rowId: rowIdFor(next),
    top,
    delta: previous == null ? 0 : top - previous,
  })
}

function foldId(body: HTMLElement): string | null {
  return foldIds.get(body) ?? null
}

export function traceFoldIdFor(body: HTMLElement): string | undefined {
  return foldIds.get(body)
}

export function traceFoldStart(body: HTMLElement, details: TraceFoldDetails): void {
  if (!traceFoldScrollActive() && !traceVisualActive()) return
  const id = `fold-${nextFoldId++}`
  foldIds.set(body, id)
  if (traceFoldScrollActive()) push('fold', 'fold-start', performance.now(), foldArgs(body, id, details))
  recordVisualAnchor(body, id)
}

export function traceFoldFrame(body: HTMLElement, details: TraceFoldDetails): void {
  if (!traceFoldScrollActive() && !traceVisualActive()) return
  const id = foldId(body)
  if (!id) return
  if (traceFoldScrollActive()) push('fold', 'fold-frame', performance.now(), foldArgs(body, id, details))
  recordVisualAnchor(body, id)
}

export function traceFoldEnd(body: HTMLElement, phase: 'settled' | 'cancelled', details: TraceFoldDetails): void {
  if (!traceFoldScrollActive() && !traceVisualActive()) return
  const id = foldId(body)
  if (!id) return
  if (traceFoldScrollActive()) push('fold', `fold-${phase}`, performance.now(), foldArgs(body, id, details))
  recordVisualAnchor(body, id)
  anchorBaselines.delete(id)
}

export function recordScrollDiagnostic(name: string, args: Record<string, unknown>): void {
  if (!traceFoldScrollActive()) return
  push('scroll', name, performance.now(), args)
}

interface RectLike {
  x: number
  y: number
  width: number
  height: number
}

interface LayoutShiftLike extends PerformanceEntry {
  value: number
  hadRecentInput: boolean
  sources?: Array<{
    node: Node
    previousRect: RectLike
    currentRect: RectLike
  }>
}

function rectArgs(rect: RectLike): Record<string, number> {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

function recordLayoutShifts(entries: PerformanceEntry[]): void {
  if (!traceVisualActive()) return
  for (const raw of entries) {
    const entry = raw as LayoutShiftLike
    push('layout', 'layout-shift', entry.startTime, {
      value: entry.value,
      hadRecentInput: entry.hadRecentInput,
      sources: (entry.sources ?? []).map((source) => ({
        rowId: rowIdFor(source.node instanceof Element ? source.node.closest('[data-crw-row-id]') : null),
        previousRect: rectArgs(source.previousRect),
        currentRect: rectArgs(source.currentRect),
      })),
    })
  }
}

function installLayoutShiftObserver(): void {
  if (typeof PerformanceObserver === 'undefined') return
  const observer = new PerformanceObserver((list) => recordLayoutShifts(list.getEntries()))
  try {
    observer.observe({ type: 'layout-shift', buffered: false })
    layoutShiftObserver = observer
  } catch {
    // Unsupported entry type: visual anchors and the rest of Record still work.
    observer.disconnect()
  }
}

export function startTraceDiagnostics(options: TraceRecordOptions): void {
  stopTraceDiagnostics()
  events = []
  eventHead = 0
  capDroppedAtTime = 0
  nextFoldId = 1
  foldIds = new WeakMap<HTMLElement, string>()
  anchorBaselines.clear()
  activeOptions = { ...options }
  if (options.visual) installLayoutShiftObserver()
}

export function stopTraceDiagnostics(): void {
  const observer = layoutShiftObserver
  layoutShiftObserver = null
  if (observer) recordLayoutShifts(observer.takeRecords())
  activeOptions = null
  observer?.disconnect()
}

export function traceDiagnosticsSnapshot(): { events: TraceDiagnosticEvent[]; capDroppedAtTime: number } {
  return { events: events.slice(eventHead), capDroppedAtTime }
}

export function resetTraceDiagnosticsForTests(): void {
  stopTraceDiagnostics()
  events = []
  eventHead = 0
  capDroppedAtTime = 0
  nextFoldId = 1
  foldIds = new WeakMap<HTMLElement, string>()
  anchorBaselines.clear()
}
