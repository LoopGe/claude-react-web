# Agent Note: Per-caller deadlines for the compact summarisation leg

Status: implemented

## Problem

`/handoff` summarises the whole conversation via an auxiliary LLM before it
clears X and seeds Y. Two independent 30-second ceilings sat on that leg: the
browser's default HTTP request timeout (`webRequest` `DEFAULT_TIMEOUT_MS`) and
`callAnthropicMessages`' text-only `AbortSignal.timeout(30_000)` default. A long
conversation on a slow aux gateway hit both — observed as a single
`anthropic_api_ms:caller=compact-summary` sample aborted at 30016 ms and the
toast `Couldn't handoff session: Request timed out after 30s`. The summariser
legitimately needs minutes; the auxiliary 30s default is sized for small
recap/commit-message calls, not a whole-transcript hand-off.

## Decision

The deadline is per-caller, owned by the call site that knows who is waiting:

- **Interactive `/handoff`** (`SessionManager.compact(id, { handoff: true })`)
  creates one `AbortController` stored on the session as `handoffAbort`. A
  `setTimeout` of `COMPACT_SUMMARY_TIMEOUT_MS` (10 minutes,
  `shared/compact-deadline.ts`) aborts it with a 504; the cancel endpoint
  aborts it with a 409. One controller owns both the deadline and the cancel
  handle, and its PRESENCE is the busy marker: `phaseOf` maps it to 'working'
  and `requireSendable` 409s sends ("session is handing off"), so input cannot
  race the seeded clear. The marker is released before `doClear` — the
  clear/spawn tail is not cancellable. The client's `/handoff` POST uses
  `HANDOFF_POST_TIMEOUT_MS` = the deadline + 60 s of headroom for that tail,
  so the server's result/error wins the race instead of the browser cutting
  the POST off mid-summarize and orphaning the late X→Y swap. Both constants
  live in the shared module so the headroom invariant is structural.
- **Cancel surface**: the center "Handing off…" veil pill carries a Cancel
  button (the veil is `pointer-events: none`; the button re-enables events
  for itself only). It POSTs `/sessions/:id/handoff/cancel`, which answers
  `{ cancelled: true }` when the summarize window was aborted — the handoff
  POST then rejects with the 409 carried as the abort reason and X survives
  untouched — and `{ cancelled: false }` outside the window (idempotent
  no-op; the client keeps waiting for the handoff POST's own outcome). The
  button disables while the cancel POST is in flight and after success, and
  re-enables on failure so the user can retry. App recognizes the deliberate
  cancel by the rejection's IDENTITY (409 + 'handoff cancelled',
  `isDeliberateHandoffCancel`) and skips the error toast — an optimistic
  client flag could eat a genuine failure racing the cancel response.
  `unload()` (sleep/delete/shutdown) aborts the marker with 'session closed'
  on the same lifecycle bound as `execAbort`, so a torn-down session's aux
  call does not keep burning tokens.
- **Every other compact caller keeps the auxiliary 30s default** (no caller
  signal): the send-blocking native auto-compact (`runAutoCompact`) is fail-open
  and a user's send awaits it, and the idle-compact plugin's automatic compact
  rides the plugin runtime's 60 s host-RPC cap (`CALL_HOST_TIMEOUT_MS`).
- **Streaming (native-media) summaries** keep `StreamIdleDeadline`'s 60 s
  no-data idle cap; the 10-minute signal is their total bound only. The idle
  cap is a dead-connection guard, a different kind of deadline.

## Alternatives considered

**One long deadline inside `summarizeForCompact` for all callers.** Rejected:
it leaks into the send-blocking auto-compact — a slow aux model would stall a
user's send server-side for up to 10 minutes while the client's send POST still
times out at 30 s, dispatching a ghost turn minutes later — and into the plugin
path, whose 60 s RPC cap would report failure while the host keeps going and
swaps the session anyway.

**Client `timeoutMs: 0` for `/handoff` (the permanent-clear pattern).**
Rejected: the server signal owns only the summarize leg. A wedged clear/spawn
tail (the condition session-health GC exists for) or a half-open connection
would lock the blurred panel forever with no error path. A bounded client cap
just above the server deadline preserves the escape hatch; permanent-clear
keeps `timeoutMs: 0` because its process-exit wait is inherently unbounded.

**Raising the plugin runtime's `CALL_HOST_TIMEOUT_MS`.** Rejected: a global RPC
guard should not bend for one slow method. The automatic plugin path has no
human waiting on it, so the short fail-open default is the right shape there.

**Extending the streaming 60 s no-data idle cap.** Not done: the observed
defect is the text-only total deadline. A gateway silent for 60 s mid-stream is
the dead-connection case the idle cap exists for; loosening it is a separate
product decision.

**`AbortSignal.any([cancel, AbortSignal.timeout(...)])`.** Rejected: the
package's engine floor is Node 20.0.0 and `AbortSignal.any` only exists from
20.3. A plain `setTimeout` aborting the one controller works on every supported
Node and yields a clearer 504 message than the DOMException timeout reason.

## Consequences

- A handoff can wait up to 10 minutes with the panel blurred and the composer
  locked; the veil's Cancel button is the escape hatch, and it only reaches
  the summarize leg — once the clear/spawn tail starts, the swap completes.
- Sends during the handoff summarize window (other tabs, scheduled sends)
  409 early at `requireSendable` instead of racing the seeded clear after the
  full aux round-trip. A scheduled send firing mid-window is marked failed.
  The `doClear` seeded guard remains as the backstop for activity the send
  gate cannot stop (CLI-driven continuation flipping the phase mid-await).
- The client and server deadlines cannot drift apart silently: both derive
  from `shared/compact-deadline.ts`.
- The veil + composer lockout are App-local to the initiating panel. Other
  tabs open on the same session see it as idle (`working` derives from
  `pendingTurns`, and no frame fires on marker transitions); their sends
  409 with the explicit 'handing off' message. Multi-tab handoff visibility
  would need a SessionInfo surface + broadcast — separate work.

## Testing

`compact-summary.test.ts` pins caller-signal pass-through and the no-signal
default; `anthropic-api.test.ts` pins the 30 s default itself, caller-signal
precedence over it, and external-abort propagation through the streaming idle
deadline; `session-manager.test.ts` pins the long deadline for
`compact({ handoff })`, the short default for both the plugin-style
`compact()` and the send-blocking auto-compact, the busy marker (working
phase + send 409 during the window, released on success and failure), the
cancel abort (409 'handoff cancelled', X survives, sendable again), the 504
deadline callback, and the no-op cancel outside the window;
`sessions-handoff.test.ts` pins the cancel route's response shape and 404;
`reset-completion.test.ts` pins `isDeliberateHandoffCancel`'s error-identity
match; `ResetOverlay.test.tsx` pins the Cancel button's single-fire +
disable-on-success and re-enable-on-failure behavior. The same overlay is now
shared by every reset wait (`/clear`, `/clear-permanent`, `/discard`, `/handoff`);
Cancel stays /handoff-only because the clear-family POSTs have no cancellable
leg (the clear/spawn tail is not cancellable, and a permanent clear's deletion
cannot be safely aborted), while the clear-family flows show the same pill with
just spinner + label + elapsed.
