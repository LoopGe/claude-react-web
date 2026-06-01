// Opt-in diagnostic logging for the session-store reducer.
//
// Disabled by default (zero console noise, near-zero CPU). Turn it on
// at runtime from the browser DevTools console:
//
//     localStorage.setItem('crw:debug:toolstatus', '1'); location.reload()
//
// and off again with:
//
//     localStorage.removeItem('crw:debug:toolstatus'); location.reload()
//
// It exists specifically to diagnose "tool card stuck on running" reports:
// it traces every toolStatus lifecycle transition so we can tell, from the
// console alone, WHICH failure mode is happening —
//   • tool_use seeded 'running' but no tool_result ever arrives
//   • tool_result arrives but its id doesn't match any seeded tool_use
//     (id-mismatch bug — logged as "ORPHAN result")
//   • a turn ends (`result`) with tools still 'running' (logged as
//     "SWEEP" — these are the entries the reducer flips to error)
//
// The flag is read once on module load and cached. Reading localStorage on
// every reducer call would be wasteful; flipping the flag requires a reload
// anyway (so the cache is always correct after a reload).

const FLAG_KEY = 'crw:debug:toolstatus'

function readFlag(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(FLAG_KEY) === '1'
  } catch {
    // localStorage can throw in private-mode / sandboxed iframes — treat
    // as "disabled" rather than crashing the reducer.
    return false
  }
}

const enabled = readFlag()

/** True when tool-status diagnostics are on. Cheap to read (cached bool). */
export function toolDebugEnabled(): boolean {
  return enabled
}

/** Log a tool-status lifecycle event. No-op unless the flag is set. The
 *  `data` arg is only constructed by callers when enabled() is true (they
 *  guard the call), so building the payload is also free when off. */
export function toolDebug(event: string, data: Record<string, unknown>): void {
  if (!enabled) return
  // console.debug so it's filterable in DevTools (Verbose level) and stays
  // out of the default console view for users who didn't ask for it.
  console.debug(`[toolStatus] ${event}`, data)
}
