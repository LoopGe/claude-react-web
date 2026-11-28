# Agent Note: Profile switch applies pin + model at the spawn boundary, never via a live setModel

Status: implemented

## Problem

Field report (2026-11-27): switching a session's provider profile in Settings
and clicking **Restart now** did nothing — no restart, no error, no visible
reaction. The server log told the whole story:

```
[session] model switching failed: Error: API error: 429 You have exceeded the
          5-hour usage quota. … · model not changed
[http] [POST] /api/sessions/64054dc5…/profile → 502 (144ms)
```

Three defects stacked:

1. **`setProfile` validated the NEW profile's model against the OLD profile's
   endpoint.** It live-applied the profile default model via the `setModel`
   SDK control request *before* restarting. That request runs inside the
   still-live CLI subprocess, whose env (`ANTHROPIC_AUTH_TOKEN` /
   `ANTHROPIC_BASE_URL`) still points at the old profile — env only changes at
   a spawn boundary. So the old endpoint had to accept the new model id for
   the switch to proceed: a quota-exhausted endpoint answered 429 (the field
   case), a cross-provider switch answered `Model 'qwen4-max' not found`
   (same session, minutes later, via the model chip). Either failure aborted
   `setProfile` with a 502 *before* `persist` and *before* `restart` — the
   restart that swaps credentials could never run. The feature blocked its
   own escape path: you cannot restart away from a dead provider because
   restarting first requires the dead provider to bless the new model. The
   abort also left the session half-switched: `s.profileId` was mutated in
   memory before the throwing await while the persist never ran, and the
   next respawn (observed: a `/clear` minutes later) read the mutated pin —
   new profile's baseUrl under the old profile's model.
2. **The client swallowed the failure.** `SessionProfileSelect.choose()` had
   no try/catch; `onClick={() => void choose(…)}` discarded the rejection, so
   the 502 surfaced as literally nothing. Every sibling control in
   SettingsPanel toasts errors through `useToast` — this one deviated.
3. **`respawnInPlace` never re-stamped `spawnProfileId`.** The field's
   contract (session-types.ts) is "the profile this session's subprocess was
   actually spawned with", and `auxTargetFor` resolves recap / commit-message
   endpoints from it. The stamp was written only in the `spawn()` funnel, so
   even a *successful* in-place restart under a new pin kept routing aux LLM
   calls to the old profile's endpoint — one profile's model id on another's
   URL, the exact misroute the field exists to prevent.

## Decision

The pin (`profileId`) and the profile's default model are **spawn-boundary
state**, owned together, applied together:

- `SessionManager.setProfile` no longer issues any live control request. It
  sets `s.profileId` and `s.model = profileDefaultModel(profile)`, refreshes
  the model-derived capability fields through `applyModelDerivedState` (the
  new single writer shared with `setModel`, so the two refresh sets can't
  drift), persists, and — for `apply: 'now'` — nests `restart()`. The
  respawn feeds `profile: effectiveProfileFor(s.profileId)` +
  `model: s.model` to `createSession`, so the new subprocess comes up under
  the new credentials and model with zero cooperation from the old process.
  This matches the philosophy `auxTargetFor` already documented: "activating
  another profile does not re-resolve a running session's model or
  credentials, only a restart does."
- `syncEffectiveSettings` is deliberately NOT called on the pin path: it
  reads the OLD handle's effective settings and would overwrite the new
  model. `setModel` keeps it (there the live switch just succeeded, so the
  handle is authoritative).
- `respawnInPlace` hoists the resolved profile and stamps
  `session.spawnProfileId = spawnProfile.id` after `createSession` succeeds.
  One stamp covers all three in-place callers (restart, auto-resume, crash
  recovery); the `spawn()`-based paths already stamped in the funnel.
- `SessionProfileSelect` wraps the POST in try/catch with
  `toast.error(…, apiErrorToastOpts(e))` and a `busy` latch that disables the
  select and both action buttons while the switch is in flight ('now' drives
  a server-side respawn, so the POST can take seconds; a mid-flight
  re-selection would be reverted by the resolve's `setValue`).

## Alternatives considered

**Keep the live `setModel` but demote it to best-effort (catch and continue
to the restart).** Rejected: it preserves a control call whose only effect
is validating a model against an endpoint that is about to be replaced —
in the deferred case it would switch the live model under OLD credentials
(a surprising half-apply contradicting the button's label), and the
try/catch-around-everything shape is exactly the branch accumulation
CLAUDE.md warns against.

**Leave `s.model` untouched and derive the model from the pin at respawn
when `spawnProfileId !== profileId`.** Rejected: the derivation would have
to be replicated in every respawn builder (`buildResumeOpts`, `spawn()`'s
resume path, fork seeds), each needing the same "pin not yet applied"
inference from a RAM-only field that a server restart clears. One state
rule — a pin change moves `(profileId, model)` together, persisted — keeps
a single writer and survives process restarts.

**Expose `spawnProfileId` on `SessionInfo` so the client can show "process
still on old profile" and offer a retry.** Rejected for this change: it is
a protocol addition serving a transient window; the session-update
broadcasts and the next respawn already converge the state.

**Make `apply: 'now'` reject (409) while a turn is in flight instead of
silently deferring.** Rejected: `restart()`'s mid-turn deferral is
long-standing documented behavior, and the global profile-activation flow
(`POST /profiles/activate` with `restartSessions`) already established the
"busy session is skipped, never fatal" convention. Diverging here would make
the two profile-switch doors behave differently under the same condition.

## Consequences

Bought: Restart now works exactly when it matters most — escaping a
quota-exhausted, unreachable, or cross-provider endpoint requires zero
cooperation from that endpoint. The half-switched-state leak is gone (pin +
model persist atomically before the restart). Aux LLM calls follow the
respawned subprocess. Failed switches are visible and retryable (toast,
controls re-enable).

Given up / known edges:

- **Transient display divergence.** For `deferred` (and for `now` clicked
  mid-turn), the model chip and capability chips immediately show the NEW
  pin's derived state while the live process still runs the old model under
  the old credentials, until the next respawn. The divergence window is
  inherent to spawn-boundary semantics; pre-fix the same case ended in a
  502 with nothing applied at all.
- **A mid-turn 'now' silently defers** to the next respawn (idle-exit
  auto-resume, crash recovery, sleep/resume, clear). The action row hides
  once the pin broadcasts, and the same-pin early return means re-selecting
  the same profile cannot re-trigger the restart — recovery rides the next
  respawn boundary, matching the global-activation flow's skip semantics.
- **A profile with an empty `modelList` pins `s.model = ''`** and respawns
  with it (empty `ANTHROPIC_DEFAULT_*_MODEL` env). This matches the
  pre-existing `create()` path (`opts.model ?? profileDefaultModel(profile)`
  yields the same `''`), so setProfile is now consistent with create rather
  than uniquely guarded; the empty-modelList configuration itself remains
  unhandled everywhere by design (no proven failure).
- The model chip's live `setModel` still validates against the session's
  current endpoint — cross-provider model ids it doesn't serve are refused
  (`Model 'x' not found`, 502). That is correct behavior for a live switch;
  the escape hatch is the profile pin + restart, which this change unblocked.

## Testing

- `server/session-manager.test.ts` → `restart()` describe →
  `setProfile restart semantics`: restart under the new profile with the old
  handle's `setModel` rigged to reject 429 (asserts no control call, pin +
  model persisted, respawn env/model from the new profile);
  `spawnProfileId` re-stamp via `auxTargetFor` routing; deferred pins
  without touching the live process (aux still mirrors the OLD endpoint).
- `src/components/SessionProfileSelect.test.tsx`: failed switch surfaces as
  an error toast (not silence) and releases the busy latch; both actions and
  the select disable while in flight.
