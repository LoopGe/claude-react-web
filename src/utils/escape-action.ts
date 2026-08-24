/** Escape is context-sensitive by turn state (decided here as a pure
 *  function so the semantics are unit-testable — App.tsx wires it into the
 *  keyboard dispatcher):
 *
 *    working → 'interrupt'  (the caller fires the interrupt and stamps
 *                            lastInterruptedAt)
 *    idle    → 'resume'     (a single clean press opens the resume picker;
 *                            the old double-tap semantics collided with the
 *                            interrupt path — an impatient second press
 *                            right after interrupting landed on the picker)
 *    idle, but within POST_INTERRUPT_SUPPRESS_MS of a just-fired interrupt
 *           → 'none'        (the trailing press of a double-tap must not
 *                            immediately pop the picker: once the interrupt
 *                            lands the session is idle, and idle Esc means
 *                            "resume")
 *
 *  "Clean" (no overlay open) is guaranteed upstream — every overlay is
 *  registered in the escape stack (window CAPTURE + stopPropagation), so a
 *  press that closes an overlay never reaches the caller. */
export function escapeAction(opts: {
  working: boolean
  now: number
  lastInterruptedAt: number
}): 'interrupt' | 'resume' | 'none' {
  if (opts.working) return 'interrupt'
  if (opts.now - opts.lastInterruptedAt < POST_INTERRUPT_SUPPRESS_MS) return 'none'
  return 'resume'
}

/** Suppression window after an interrupt fires. See escapeAction. */
export const POST_INTERRUPT_SUPPRESS_MS = 500
