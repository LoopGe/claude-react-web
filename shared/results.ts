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
 *  Deliberately conservative: anything that is an error, has a non-success
 *  subtype, reports a non-zero turn count, carries result text, or cost money
 *  is kept. Only a success with zero turns, no text and no cost is considered
 *  empty — an older producer that omits `num_turns` is never treated as empty. */
export function isEmptyResultFrame(msg: {
  type?: string
  subtype?: string
  is_error?: boolean
  num_turns?: number
  result?: unknown
  total_cost_usd?: number
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
  if (typeof msg.total_cost_usd === 'number' && msg.total_cost_usd > 0) return false
  return true
}
