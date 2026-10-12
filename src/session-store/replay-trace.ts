// ── TEMPORARY instrumentation — remove after the reorder investigation ─────
//
// Ring-buffer trace for the WS replay pipeline (client side). Collects every
// burst-boundary event so the "last mile" of the transcript-reorder bug can
// be reconstructed from one dump instead of scrolling the console:
//
//     __crwReplayLog()        // dump all entries (newest last)
//     __crwReplayLog(40)      // last 40 entries
//     __crwReplayLogClear()
//
// Entries also go to console.debug('[replay-trace]', …) for live watching.
// The two smoking-gun events are prefixed '!!' and use console.warn:
//   - '!!STALE-BUFFER'   — a replay frame arrived for a NEW burst while this
//                          listener was still buffering an older burst
//                          (the superseded burst's replay-done never came).
//   - '!!OLD-AS-NEWER'   — splitReplayAgainstCache classified a payload with
//                          NO uuid overlap as entirely `newer`, and its first
//                          message is chronologically OLDER than the cache
//                          tail (the append-at-tail disorder).

export interface ReplayTraceEntry {
  t: number
  sid: string
  /** Listener instance id (per effect closure). */
  lst: number
  ev: string
  [k: string]: unknown
}

const CAP = 800
const buf: ReplayTraceEntry[] = []
let listenerCounter = 0

export function nextListenerId(): number {
  return ++listenerCounter
}

export function replayTrace(
  sid: string,
  lst: number,
  ev: string,
  data: Record<string, unknown> = {},
): void {
  const entry: ReplayTraceEntry = { t: Date.now(), sid, lst, ev, ...data }
  buf.push(entry)
  if (buf.length > CAP) buf.shift()
  const line = `[replay-trace] #${buf.length} ${ev}`
  if (ev.startsWith('!!')) console.warn(line, entry)
  else console.debug(line, entry)
}

export function replayTraceDump(n?: number): ReplayTraceEntry[] {
  return n != null && n > 0 ? buf.slice(-n) : [...buf]
}

export function replayTraceClear(): void {
  buf.length = 0
}

/** Best-effort time of a message for ordering comparisons: receivedAt
 *  (disk-restored + live pump stamps) else ISO timestamp else null. */
export function msgTime(m: unknown): number | null {
  const o = m as { receivedAt?: unknown; timestamp?: unknown } | null | undefined
  if (!o) return null
  if (typeof o.receivedAt === 'number' && Number.isFinite(o.receivedAt)) return o.receivedAt
  if (typeof o.timestamp === 'string') {
    const t = Date.parse(o.timestamp)
    if (Number.isFinite(t)) return t
  }
  return null
}

/** Compact identity of a message for trace lines — uuid prefix + best-effort
 *  time. Shared by the reducer and useChatStream trace points so the trace
 *  format has a single definition. */
export function msgTag(m: unknown): { u?: string; t?: number } {
  const o = m as { uuid?: unknown } | null | undefined
  if (!o) return {}
  return {
    u: typeof o.uuid === 'string' ? o.uuid.slice(0, 8) : undefined,
    t: msgTime(m) ?? undefined,
  }
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { __crwReplayLog?: (n?: number) => ReplayTraceEntry[] }).__crwReplayLog =
    replayTraceDump
  ;(window as unknown as { __crwReplayLogClear?: () => void }).__crwReplayLogClear =
    replayTraceClear
}
