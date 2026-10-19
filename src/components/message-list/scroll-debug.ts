// TEMPORARY diagnostic module (investigation in progress).
//
// Opt-in diagnostic logging for the transcript scroll behaviour, re-added to
// hunt the remaining "lands short with no observer firing" case. Turn it on
// from the browser DevTools console:
//
//     localStorage.setItem('crw:debug:scroll', '1'); location.reload()
//
// and off with localStorage.removeItem('crw:debug:scroll') + reload.
//
// Payloads are THUNKS: these call sites run per frame (and the geometry ones
// force a layout read), so with the flag off nothing may be computed. Mirrors
// src/session-store/debug.ts, with that module's "callers guard the payload"
// contract made structural.
const FLAG_KEY = 'crw:debug:scroll'

function readFlag(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(FLAG_KEY) === '1'
  } catch {
    return false
  }
}

const enabled = readFlag()

/** True when transcript-scroll diagnostics are on. */
export function scrollDebugEnabled(): boolean {
  return enabled
}

/** TEMPORARY in-page mirror of every diagnostic event, so an occurrence can
 *  be diagnosed after the fact — the DevTools console ring rolls over and a
 *  reload wipes it. Inspect from the console: `__scrollLogV2`. Best-effort,
 *  diagnostics only. */
type ScrollLogEntry = { t: number; ev: string; d: unknown }

/** Log a scroll-lifecycle event. No-op (and no payload built) unless the flag
 *  is set, so the cost when off is one cached boolean read. */
export function scrollDebug(event: string, buildPayload: () => Record<string, unknown>): void {
  if (!enabled) return
  const payload = buildPayload()
  console.debug(`[scroll] ${event}`, payload)
  // The only importer runs in the browser bundle and jsdom client tests —
  // `window` always exists where this executes.
  const w = window as unknown as { __scrollLogV2?: ScrollLogEntry[] }
  w.__scrollLogV2 ??= []
  w.__scrollLogV2.push({ t: Date.now(), ev: event, d: payload })
  if (w.__scrollLogV2.length > 20000) w.__scrollLogV2.splice(0, 5000)
}