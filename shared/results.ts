// Classification of `result` frames shared by the server pump and the client
// transcript model.
//
// SDK 0.3.274 changed queued background-task completions to share one model
// call: each completion still gets its own `result`, but all but the last are
// empty (`num_turns: 0`, empty `result` text). Those frames are not real
// turns — rendering one result footer per completion (and persisting them to
// the result-frame sidecar) floods the transcript with duplicate "ok" rows.
// The spawn/restart warm-up result has the same shape, so it is covered too.

/** True when a `result` frame carries no user-visible turn outcome and should
 *  therefore not produce a transcript footer or a persisted result record.
 *
 *  Keyed on the TURN OUTCOME (turn count, text, terminal reason) — never on
 *  `total_cost_usd`: that field is the SESSION-CUMULATIVE tally on every
 *  result frame (verified against session 07790d71's wire, where the real
 *  result and the placeholder carried the identical 18.0777), so a positive
 *  value carries no information about THIS frame's turn. The queued-
 *  completion placeholder inherits the cumulative cost/usage/duration from
 *  the session, which is exactly why an earlier "cost money is kept" guard
 *  let the placeholder through once the session's running total left 0.
 *  Still deliberately conservative: anything that is an error, has a
 *  non-success subtype, reports a non-zero turn count, carries result text,
 *  or ended other than cleanly is kept. A zero-turn success with no text
 *  describes no turn outcome — an older producer that omits `num_turns` is
 *  never treated as empty. */
export function isEmptyResultFrame(msg: {
  type?: string
  subtype?: string
  is_error?: boolean
  num_turns?: number
  result?: unknown
  /** Session-CUMULATIVE on every real frame — deliberately NOT read by the
   *  classifier (see the doc above). Present here only so callers can pass
   *  the raw wire frame without casting. */
  total_cost_usd?: number
  /** Cumulative wire fields the placeholder inherits from the session —
   *  also deliberately unread. */
  duration_api_ms?: number
  usage?: unknown
  result_index?: unknown
  terminal_reason?: string
}): boolean {
  if (msg.type !== 'result') return false
  if (msg.is_error === true) return false
  if (msg.subtype !== undefined && msg.subtype !== 'success') return false
  if (msg.num_turns !== 0) return false
  // A non-'completed' terminal reason is a real outcome the transcript must
  // keep: an interrupt before the first model round-trip can land as a
  // zero-turn success, and its footer is where the "turn interrupted" marker
  // comes from (MessageView reads terminal_reason off this frame).
  if (msg.terminal_reason !== undefined && msg.terminal_reason !== 'completed') return false
  const text = typeof msg.result === 'string' ? msg.result.trim() : ''
  if (text.length > 0) return false
  return true
}
