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
  passes `AbortSignal.timeout(COMPACT_SUMMARY_TIMEOUT_MS)` — 10 minutes — into
  `summarizeForCompact` → `callAnthropicMessages`. The client's `/handoff` POST
  uses `HANDOFF_POST_TIMEOUT_MS` = that deadline + 60 s of headroom for the
  clear/spawn tail, so the server's result/error wins the race instead of the
  browser cutting the POST off mid-summarize and orphaning the late X→Y swap.
  Both constants live in `shared/compact-deadline.ts` so the headroom invariant
  is structural, not two unlinked magic numbers.
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

## Consequences

- A handoff can now wait up to 10 minutes with the panel blurred and the
  composer locked. There is no cancel affordance yet (the veil is
  informational, and no server endpoint aborts an in-flight compact); at this
  wait length that is a real usability gap, tracked as follow-up work together
  with a busy/compacting marker for the summarize window.
- The summarize window leaves the session idle and sendable. A scheduled send
  or another-tab send landing mid-window makes the seeded clear 409 after the
  full aux round-trip — a pre-existing race the longer window amplifies. The
  409 guard keeps it safe (no input is destroyed); the cost is wasted aux work.
- The client and server deadlines cannot drift apart silently: both derive
  from `shared/compact-deadline.ts`.

## Testing

`compact-summary.test.ts` pins caller-signal pass-through and the no-signal
default; `anthropic-api.test.ts` pins the 30 s default itself, caller-signal
precedence over it, and external-abort propagation through the streaming idle
deadline; `session-manager.test.ts` pins the long deadline for
`compact({ handoff })` and the short default for both the plugin-style
`compact()` and the send-blocking auto-compact.
