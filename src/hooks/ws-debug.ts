// WebSocket lifecycle diagnostics — ALWAYS ON, persisted to localStorage.
//
// Why always on and why persisted: the failure this exists for is a silently
// wedged connection that the user "fixes" with a refresh the moment they see
// it — an in-memory ring (like scroll-debug.ts's __scrollLogV2) or a
// console-only log would be wiped by the very action users take first. The
// log survives that refresh, so the post-mortem is still possible:
//
//     JSON.parse(localStorage.getItem('crw:ws-log'))
//
// Multi-tab correctness: this app routinely runs several tabs, and a
// module-cached ring written wholesale would let tabs clobber each other's
// entries (the wedged tab's zombie record erased by the healthy tab's next
// event). Every write therefore READ-MERGES the stored log first — each
// event appends to whatever is currently there, so interleaved tabs only
// lose entries on a true simultaneous write (last-writer-wins on one event,
// not on the whole history).
//
// Volume is bounded: only lifecycle events are recorded (open / close /
// forced reconnect / zombie verdict), never per-frame work. All storage
// access is try/catch-guarded — private-mode Safari and quota errors must
// never crash the hub for diagnostics' sake.
const KEY = 'crw:ws-log'
const CAP = 100

type WsLogEntry = { t: number; ev: string; d?: Record<string, unknown> }

function loadStored(): WsLogEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) return parsed as WsLogEntry[]
    }
  } catch { /* corrupt or unavailable — start fresh */ }
  return []
}

/** Record one lifecycle event. Console.debug keeps it filterable in DevTools
 *  (Verbose) for live observation; localStorage makes it survive the refresh. */
export function wsLog(ev: string, data?: Record<string, unknown>): void {
  try {
    const log = loadStored()
    log.push({ t: Date.now(), ev, ...(data ? { d: data } : {}) })
    if (log.length > CAP) log.splice(0, log.length - CAP)
    localStorage.setItem(KEY, JSON.stringify(log))
  } catch { /* diagnostics only — never propagate */ }
  console.debug(`[wsHub] ${ev}`, data ?? '')
}
