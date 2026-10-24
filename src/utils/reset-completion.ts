/** How `resetSession`'s POST continuation (/clear and /handoff) completes the
 *  server-side X→Y swap on the client.
 *
 *  Three outcomes, deliberately distinguished — the pre-fix `else` branch
 *  treated "server short-circuit" and "panel closed mid-wait" identically
 *  (both no-ops), which left X as a sidebar ghost and Y hidden forever when
 *  the panel closed during /handoff's long summarize wait:
 *
 *  - `swap`     — server spawned Y (`newId !== oldId`) and X still hosts an
 *                 open panel. `swapSession` places Y in X's slot.
 *  - `teardown` — server spawned Y but the panel is closed (no slot to swap
 *                 into). The clearingIds guard has already swallowed
 *                 session-removed(X) — X is still in `sessions` — and Y sits
 *                 behind an evicting pending marker only `swapSession`
 *                 consumes. `teardownRemovedSession` is the shared path that
 *                 evicts X and lets Y surface.
 *  - `noop`     — server short-circuited (`newId === oldId`: another clear is
 *                 in flight, or the `clearing` flag is stuck). X is still the
 *                 live session; leave it alone. */
export function resetCompletion(args: {
  oldId: string
  newId: string
  panelOpen: boolean
}): 'swap' | 'teardown' | 'noop' {
  if (args.newId === args.oldId) return 'noop'
  return args.panelOpen ? 'swap' : 'teardown'
}
