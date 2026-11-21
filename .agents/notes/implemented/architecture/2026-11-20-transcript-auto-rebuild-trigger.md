# Agent Note: Live transcript anomaly auto-rebuild trigger

Status: implemented

## Problem

The ordered-reconcile design (spec
`docs/superpowers/specs/2026-11-16-transcript-ordered-reconcile-design.md` §8.1,
referenced as plain text while that design doc is untracked) rebuilds a transcript
projection when a result/completion frame belongs before the published tail (a
chronology inversion) or revises a same-uuid result.
Before this feature the rebuild only ran on an explicit user Retry or a passive
resume reconcile; a live inversion stayed suppressed with admission closed and no
automatic path to a committed generation. A long-term quiesce blocker (a running
background task, an accepted plugin invocation) could keep a pending rebuild
waiting indefinitely with no actionable UI — an infinite load.

## Decision

The trigger is a live detection → durable admission → event-driven scheduler →
drain-preserve-replay executor chain, all in `SessionManager`:

- **Detection** (`detectLiveRebuildTrigger`, pure `detectRebuildTrigger`) runs on
  each renderable result/completion before the ring append. An anomaly persists a
  `rebuild-pending` recovery row (`beginTranscriptRebuild`, single-flight) and
  closes `rebuildAdmissionPending`; the triggering frame is suppressed (never
  head-appended). A closed-anchor guard excludes routine interrupt/error results.
- **Scheduler** (`schedulePendingRebuilds` / `canAutoFire`) is event-driven, not a
  polling loop. It re-evaluates on every lifecycle event that can clear a quiesce
  blocker: turn settling, background-task terminal, in-flight send settle,
  subscriber capability change (attach/detach), plugin-invocation settle, process
  recovery, and resume. It fires `quiesceAndRebuild(id, {preserveQueued:true})`
  when the holder flag is set, the session is live and `quiesceEligible`, and every
  subscriber is ordered-rebase capable (vacuously true with zero subscribers — an
  unwatched quiesced session auto-heals). An in-flight run guard makes it
  idempotent; the durable authority (`readPendingRebuilds` over the sidecar) is
  re-read before firing so a compact-superseded pending never fires stale.
- **`quiesceEligible`** rejects executing turn/tool/send/exec work, the
  clearing/handoff windows, active/waiting background work (subagents AND shells
  AND workflows via `backgroundWorkCount`), and accepted plugin invocations
  (`pluginInvocationProbe`, wired to `AppPluginManager.hasInFlightInvocation` in
  bootstrap). Broker-blocked (pending permission/elicitation/dialog) is eligible —
  the executor settles the broker first. It is deliberately not `phaseOf === idle`.
- **Executor** (`quiesceAndRebuild`) drains the live input queues to durable
  `drained-to-pending` rows, interrupts without withdrawing queued input, tears
  down the provider, forces the ordered rebuild that resolves the pending op
  include-once, then resumes; `resume()` replays the durable drained bucket in
  `dispatchOrdinal` order on every successful resume (so a crash between drain and
  replay, or a later Retry, never strands preserved input). Explicit Retry keeps
  the visible-Stop withdrawal semantics (`preserveQueued:false`).

### rebuild-waiting status

`WsRebuildWaiting {blockers, pendingOperationCount}` rides the PRIMARY message queue
(like `transcript-rebased`), never the history ring. "Long-term blocked" is reported
event-driven: each scheduler re-evaluation that finds admission armed but
`canAutoFire` false emits the current blockers (`rebuildBlockersOf`, the reportable
mirror of `quiesceEligible`). There is no timer threshold — the status persists
across lifecycle re-evaluations for as long as the blocker remains, which is what
"no infinite loading" requires. An empty `blockers` array clears the status; it is
emitted when the rebuild fires, is deferred/aborted, or its payload enters a
committed generation (every `setRebuildAdmissionPending(false)` routes through the
clear, tracked by `rebuildWaitingEmitted` so a session that never waited does not
spam clear frames on each /clear or compact). The client mirrors it into
`ServerMirror.rebuildWaiting` and the Composer renders task-stop / Retry / defer
actions; every mirror reset (rebase/clear/bump/resync) drops it (the generation
guard).

### deferRebuild

`POST /sessions/:id/transcript/defer-rebuild` → `deferRebuild` calls
`abortTranscriptRebuild('cancelled')` (restores provider/admission, releases
deferred old-generation commits in order), adds the session to the in-memory
`rebuildDeferred` set, and retains the durable pending payload with a warning.
`canAutoFire` respects the pause. The pause is honored across the holder lifecycle:
the recovery re-arm in `ensureTranscriptReconciled` seeds the writer's pending list
but leaves admission OPEN when the session is deferred (the user chose to keep
working on the old projection). A new anomaly (`beginTranscriptRebuild`) or an
explicit Retry (`retryTranscriptReconcile`) clears the pause and resumes scheduling.
The pause is in-memory only: a process restart loses it, so crash recovery re-arms
admission and auto-fires the durable payload (§9).

### Plugin-invocation settle hook

`AppPluginManager.executeCommand`'s `finally` calls
`sm.schedulePendingRebuilds(sessionId)` when the invocation settles (success or
failure). An idle session whose only blocker was a plugin command auto-fires
promptly on completion instead of waiting for the next unrelated lifecycle event.

## Alternatives considered

- **A timer threshold for "long-term" rebuild-waiting.** A polling timer would
  introduce a new mechanism the event-driven scheduler avoids, and the actionable
  status is needed as soon as a blocker persists, not after an arbitrary delay.
  Reporting on each blocked re-evaluation gives the same user-visible guarantee
  (no infinite load) with no timer.
- **Persisting the defer pause.** Defer is a transient UX choice over the current
  live admission window; persisting it would suppress crash recovery's §9 auto-heal
  after a restart. Keeping it in-memory means a restart resumes the rebuild, which
  is the lossless default.
- **Re-closing admission on the recovery re-arm even when deferred.** That would
  strand a deferred session in closed-admission with no waiting banner after an
  unload/resume cycle. Honoring the defer (admission stays open, payload retained)
  keeps the session usable until a new anomaly or Retry resolves the payload.
- **Pushing the rebase envelope to old subscribers on the auto path.** The auto
  executor quiesces via teardown (unload ends the old subscriber queues before
  publication), so the envelope reaches no live queue; clients re-anchor to the new
  generation via the attached handshake after resume. The envelope-before-new-frames
  FIFO is preserved on the in-place publication path (see
  [ordered rebuild wire/disk twin dedup](../bug-fix/2026-11-20-ordered-rebuild-wire-disk-twin-dedup.md)
  and the §8.3 publication tests). Building the full hub-held pending-subscribe
  ownership migration (spec §8.1 step 1) is a separate subsystem, deferred.

## Consequences

A live inversion self-heals without user action once the session quiesces; the
payload enters a committed generation include-once and admission reopens. A
long-term blocker surfaces an actionable banner rather than an infinite load, and
defer lets the user keep working with the payload retained. The cost: the auto path
re-anchors clients via the attached handshake rather than a live envelope (the
teardown trade-off above), and the defer pause does not survive a restart (crash
recovery auto-fires). The integration regression pins the full chain (live anomaly →
auto REBUILD_REQUIRED → quiesce → rebuild → rebase generation record → resume
replay) and the crash-after-pending variant (restart recovers the payload and fires
the rebuild exactly once, payload include-once in the projection).

## Related

- [Ordered rebuild aligns wire/disk twins by uuid+frameKind](../bug-fix/2026-11-20-ordered-rebuild-wire-disk-twin-dedup.md)
  — the occurrence-identity alignment the forced rebuild relies on for include-once.
- [Sidecar crash recovery](2026-11-19-sidecar-crash-recovery.md) — the durable
  commit/truncation protocol the rebuild-pending recovery rows survive.