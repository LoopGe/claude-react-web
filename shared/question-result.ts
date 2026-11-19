// AskUserQuestion answer marker, shared by the host permission broker (which
// stamps it onto a denial) and the native loop (which checks it). Neutral and
// host-free: the symbol identity comes from Symbol.for, so both sides agree
// even if this module is reached through different import paths.

/** Host-internal marker on a broker denial that carries the user's ANSWER to
 *  an AskUserQuestion (answer / clarify / malformed) rather than a permission
 *  failure. Symbol-keyed, so JSON serialization onto the SDK's control-response
 *  wire drops it: this is not part of the wire protocol and the Claude
 *  provider's behavior is unchanged. The native loop is the only consumer. */
export const QUESTION_RESULT: unique symbol = Symbol.for('claude-react-web.question-result')

/** True when a broker result carries an AskUserQuestion ANSWER rather than a
 *  permission failure. Interrupt/abort, `denyAll`, missing-handler and
 *  ordinary permission denials never set the marker. */
export function isQuestionResult(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as Record<PropertyKey, unknown>)[QUESTION_RESULT] === true
  )
}