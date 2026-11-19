// Deadline policy for the app-side compact (/handoff) summarisation leg.
// Shared so the client's POST timeout stays structurally linked to the
// server's summarize deadline — raising one without the other would let the
// browser cut the POST off mid-summarize and orphan the late X→Y swap.

/** Server-side deadline for the interactive /handoff's summarisation leg: a
 *  long conversation on a slow aux model gets minutes, not
 *  callAnthropicMessages' 30s auxiliary default. Deliberately NOT applied to
 *  the other compact callers, which keep the short default: the send-blocking
 *  native auto-compact (runAutoCompact) is fail-open and a user's send awaits
 *  it, and the idle-compact plugin's automatic compact rides a 60s host-RPC
 *  cap (CALL_HOST_TIMEOUT_MS). Streaming (native-media) summaries additionally
 *  keep the 60s no-data idle cap — this deadline is their total bound only. */
export const COMPACT_SUMMARY_TIMEOUT_MS = 600_000

/** Client /handoff POST timeout: the summarize deadline plus headroom for the
 *  clear/spawn tail, so the server's result/error wins the race while a wedged
 *  tail still surfaces instead of locking the panel forever. */
export const HANDOFF_POST_TIMEOUT_MS = COMPACT_SUMMARY_TIMEOUT_MS + 60_000
