/**
 * Tracks consecutive and total classifier denials per session for auto mode.
 * When limits are hit, auto mode falls back to prompting the user instead
 * of repeatedly calling the classifier — prevents silent blocking while
 * the user is unaware.
 *
 * Mirrors SDK's denialTracking.ts: maxConsecutive=3, maxTotal=20.
 * Denial counts reset on session restart (the tracker is in-memory only).
 */

export class AutoDenialTracker {
  private consecutive = 0
  private total = 0

  /** Called when a tool is allowed (either by safe-list, acceptEdits fast
   *  path, or classifier approval). Resets the consecutive counter so a
   *  single denial amid many approvals doesn't trip the circuit breaker. */
  recordAllow(): void {
    this.consecutive = 0
  }

  /** Called when the classifier actively blocks an action. */
  recordDenial(): void {
    this.consecutive++
    this.total++
  }

  /** Should auto mode still use the classifier, or fall back to prompting?
   *  Returns false when consecutive denials reach 3 OR total denials reach 20. */
  get shouldUseClassifier(): boolean {
    return this.consecutive < 3 && this.total < 20
  }
}
