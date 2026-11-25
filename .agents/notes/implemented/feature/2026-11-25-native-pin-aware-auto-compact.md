# Agent Note: Native provider pin-aware auto-compact window

Status: implemented

## Problem

The New session form's "Auto-compact window (tokens)" input promises CLI
window semantics — the value is clamped to the CLI's 100k–1M range, persisted
as `SessionMeta.autoCompactWindow`, and re-injected into
`Options.settings.autoCompactWindow` on every spawn. The two providers consumed
that pin differently, and native's context reporting ignored it:

- **claude** hands the pin to the CLI, which treats it as a policy window: the
  resolved denominator becomes `min(modelWindow, pin)` and the trigger is
  derived below it (`window − min(maxOutputTokens, 20000) − 13000`). A 150000
  pin reports `rawMaxTokens == maxTokens == 150000`, threshold 117000,
  `autocompactSource == "settings"` (live-verified, research note §4.2.1).
- **native** reported `maxTokens = contextWindow` and a threshold derived from
  the raw model window, ignoring the pin. The pin lived only in the manager's
  compaction decision, which used it directly as the threshold
  (`s.autoCompactWindow ?? usage.autoCompactThreshold ?? ratio`).

Two defects followed. The Context tab's composition table derives
`Autocompact buffer = maxTokens − autoCompactThreshold` and free space from the
lite fields, so on a pinned native session the buffer/free rows described the
unpinned ratio threshold while compaction fired at the pin — display ≠
decision. And one number carried two meanings: a window for claude (trigger
117000 at pin 150000) and a trigger point for native (trigger 150000 at pin
150000). The pump's claude fallback already treated the pin as a window, so CRW
was internally split while the UI promised the window meaning. This is a
semantics/reporting gap, not a regression in the composition assembly: the
assembly is correct given its inputs; its inputs were wrong on pinned native
sessions.

## Decision

The pin is one thing across providers: a policy window clamped under the model
window, each provider deriving its trigger from that effective window by its
own policy.

**Pin plumbing.** The host adapter
(`server/providers/native/native-provider.ts`) reads
`providerExtras.sdkOptions.settings.autoCompactWindow` alongside `skills`,
coerces it to a positive finite number at the `unknown`-typed SDK boundary, and
passes it into `NativeSession` opts as a neutral `autoCompactWindow?: number`
(`native-session.ts`). The core receives a plain number; reading the SDK-shaped
`settings` object stays in the adapter, so the neutral core stays neutral.
`createSession` runs on every spawn and the manager re-injects the pin each
time, so resume / fork / clear / respawn re-capture it with no extra lifecycle
work — the `skills` pattern. The value is trusted as coerced upstream
(persistence keeps only finite positive integers; the form clamps the range);
core does no speculative re-validation.

**Pin-aware reporting.** `NativeSession.getContextUsage()` computes
`effectiveWindow = min(contextWindow, pin)` (the raw window when no pin), then
applies the unchanged ratio policy and output reserve to it:
`autoCompactThreshold = min(floor(effectiveWindow × nativeAutoCompactRatio),
effectiveWindow − DEFAULT_MAX_TOKENS)`, or `0` when the output reserve is
non-positive. `maxTokens` stays the resolved model window. The composition
assembly is unchanged — it already derives buffer/free from the lite fields, so
a pin-aware threshold makes those rows honest with no edit. Unpinned sessions
are byte-identical; a pin ≥ window is a no-op; a model down-switch re-resolves
`min(newWindow, pin)` per generation.

**Single writer.** The manager's `runAutoCompact` reads
`usage.autoCompactThreshold ?? floor(usage.maxTokens × ratio)` — the provider is
the sole writer of the effective threshold, and the ratio fallback applies only
when a provider reports none (native always reports one). `s.autoCompactWindow`
retains its persistence, spawn-re-injection and `SessionInfo` projection roles;
the compaction decision does not read it.

**Pump authority.** The pump keeps a provider-reported threshold over the
claude formula replica. `resolveAutoCompactThreshold` returns a matching-model
facts threshold unchanged; the replica (`shared/auto-compact.ts`) is the
fallback only when no facts carry a threshold, and the drift warning derives
against the same effective window the fallback uses. A pinned native session's
probe threshold (e.g. 120000) therefore survives the fold even though the
claude replica against the same pin would say 117000 — pinned by
`server/session-pump.test.ts`.

**Spawn-time only.** Both providers consume the pin at spawn. claude's runtime
`applyFlagSettings({autoCompactWindow})` channel is inert on the pinned SDK
0.3.311 / CLI 2.1.311 despite a static merge branch in the binary: a live probe
(research note §4.2.1) showed neither a numeric value nor `null` moved the
resolved window or threshold, in both an unpinned and a spawn-pinned session,
including after a real turn. Spawn-time `Options.settings` is the only live
claude channel. Native has no such contract gap (it is CRW code), but a live
setter is a separate follow-up (the `applyFlagSettings` allowlist extension plus
client wiring and capability advertisement), so this change is spawn-time only
and symmetric with claude's live channel.

## Alternatives considered

**Conservative display-only variant (threshold = pin, no behavior change).**
Report a pin-derived threshold for the composition table but leave the manager
firing at the raw pin. This keeps existing pinned native sessions' trigger
point unchanged, but leaves the semantics split — the form promises a window,
native keeps treating it as a trigger — and the display would describe a
threshold the manager does not use. The user chose the full unification: one
meaning across providers, accepting the trigger-point change.

**Import the CLI's fixed formula as native's policy.** Replace native's ratio
policy with `window − min(maxOutput, 20000) − 13000`. This aligns the two
providers' policies, but it is a different decision from aligning their
semantics: native keeps `nativeAutoCompactRatio` + the `DEFAULT_MAX_TOKENS`
output reserve as its own policy, applied to the effective window. Borrowing
the CLI's discipline (report the effective policy, derive from the effective
window, single writer) does not require borrowing its buffer constants.

**Switch the bar denominator to the policy window.** The claude probe lens
reports `rawMaxTokens == maxTokens == pin` (research note §4.2.1); native could
match it. Rejected: the pump's deliberate bar convention keeps
`maxTokens`/percentage on the model's real window, and changing the denominator
would silently shift every percentage the user reads. The pin's effect rides
the threshold marker, not the denominator. Reconciling the two lenses is out of
scope.

## Consequences

A pinned native session's compaction trigger moves from `pin` to
`min(floor(pin × ratio), pin − DEFAULT_MAX_TOKENS)` — e.g. pin 150000 at ratio
0.8 fires at 120000 instead of 150000. This is earlier, matches the window
semantics the form promises, and matches the claude side's shape (trigger
always below the window). Persisted pin values are unchanged; their meaning
shifts from "trigger point" to "policy window". This is a real, accepted,
product-visible change for existing pinned native sessions, not a regression.

The composition table's buffer/free rows on a pinned native session now match
the point where compaction fires. Unpinned native sessions, the claude provider,
the pump's claude fallback/drift math, persistence coerce, the client, the wire
protocol and the history ring are untouched. The neutral core gains only a
plain-number opts field; the neutrality and host-free pins stay green.

The single-writer contract supersedes the manager threshold order recorded in
[native model context resolution](../architecture/2026-11-14-native-model-context-resolution.md)
(explicit `autoCompactWindow` → provider threshold → ratio): the explicit-pin
prefix is gone and the provider threshold is pin-aware. That note's capacity
resolution and zero-threshold guarantees are unchanged.

## Related

- Design spec:
  `docs/superpowers/specs/2026-11-25-native-pin-aware-auto-compact-design.md`.
- CLI discipline + live inert-channel evidence:
  `docs/research/2026-11-25-claude-cli-auto-compact.md` §4.2.1.
- Composition table this makes honest on pinned sessions:
  [native context composition](2026-11-25-native-context-composition.md).
- Capacity resolution + the superseded manager threshold order:
  [native model context resolution](../architecture/2026-11-14-native-model-context-resolution.md).
