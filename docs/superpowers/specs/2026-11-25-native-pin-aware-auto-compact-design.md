# Native provider pin-aware auto-compact window — design

Date: 2026-11-25
Status: proposed

## Problem

The New session form's **Auto-compact window (tokens)** input promises CLI
window semantics — the label says "Auto-compact window", the code comment
says "official token semantics", and the value is clamped to the CLI's
100k–1M range (`src/components/session-list/NewSessionDialog.tsx:484-494,918`).
The manager persists it as `SessionMeta.autoCompactWindow` and re-injects it
into `providerExtras.sdkOptions.settings.autoCompactWindow` on every spawn
(create / resume / fork / side-chat / clear;
`server/session-manager.ts:3384-3387,12584-12587,12611-12614`).

The two providers consume that pin differently, and the native provider's
context reporting does not reflect it at all:

- **claude** — the pin rides `Options.settings.autoCompactWindow` into the
  CLI, which treats it as a *window*: the resolved denominator becomes
  `min(modelWindow, pin)` and the trigger is derived below it
  (`threshold = window − min(maxOutputTokens, 20000) − 13000`). Live-verified
  against the pinned SDK 0.3.311 / CLI 2.1.311: a 150000 pin reports
  `rawMaxTokens == maxTokens == 150000`, `autoCompactThreshold == 117000`,
  `autocompactSource == "settings"`
  (`docs/research/2026-11-25-claude-cli-auto-compact.md` §4.2.1).
- **native** — `NativeSession.getContextUsage()` ignores the pin entirely
  (`server/providers/native/native-session.ts:1948-1977`): it reports
  `maxTokens = contextWindow` (the raw resolved model window) and
  `autoCompactThreshold = min(floor(contextWindow × nativeAutoCompactRatio),
  contextWindow − DEFAULT_MAX_TOKENS)`. The pin lives only in the manager's
  compaction decision, which uses it **directly as the threshold**
  (`server/session-manager.ts:6172-6174`,
  `s.autoCompactWindow ?? usage.autoCompactThreshold ?? floor(maxTokens × ratio)`).

Two defects follow:

1. **Display ≠ decision on pinned native sessions.** The Context tab's
   composition table derives `Autocompact buffer = maxTokens −
   autoCompactThreshold` and `Free space = maxTokens − totalTokens − buffer`
   from the lite fields (`native-session.ts:2016-2017`). Because those fields
   ignore the pin, the buffer/free rows describe the *unpinned* ratio
   threshold while compaction actually fires at the pin. The used rows sum
   to the real `totalTokens` (the residual guarantee holds), but the buffer
   row misstates when compaction will happen.
2. **One number, two meanings.** The same form input is a *window* for claude
   (trigger 117000 at pin 150000) and a *trigger point* for native (trigger
   150000 at pin 150000). The pump's claude fallback derivation already
   treats the pin as a window (`server/session-pump.ts:2742-2747`), so CRW
   itself is internally split; the UI promises the window meaning.

This is a semantics/reporting gap, not a regression in the composition work
(2026-11-25, landed): the composition assembly is correct given its inputs;
its inputs are wrong on pinned native sessions.

## Reference: the CLI discipline (live-verified)

`docs/research/2026-11-25-claude-cli-auto-compact.md` establishes, against
the pinned CLI binary and a live probe:

- The auto-compact window is a **policy ceiling clamped under the model
  window** — every resolution layer applies `Math.min(modelWindow,
  configured)`; the setting can only shrink the effective window, never
  raise the model's capacity (§2.1).
- The reported threshold is derived from the **effective** window, and the
  CLI's own `getContextUsage` denominator is that effective window (§4.2.1).
- The runtime `applyFlagSettings({autoCompactWindow})` channel is **inert**
  in SDK mode on 2.1.311 despite a static merge branch in the binary
  (§4.2.1) — spawn-time `Options.settings` is the only live channel for the
  claude provider. The native provider has no such contract gap (it is CRW
  code), but a live setter is out of scope here (see Non-goals).

We borrow the *discipline* — report the effective policy, derive the trigger
from the effective window, single writer — not the CLI's fixed buffer
formula. Native keeps its own ratio policy.

## Goals

- A pinned native session's `getContextUsage()` reports an
  `autoCompactThreshold` derived from the **effective window**
  `min(modelWindow, pin)`, so the composition table's buffer/free rows match
  the point where compaction actually fires.
- The pin has **one meaning across providers**: a policy window clamped
  under the model window, with each provider deriving its trigger from that
  window by its own policy.
- **Single writer** for the native compaction trigger: the provider reports
  the effective threshold; the manager consumes it instead of holding a
  second, divergent pin-as-threshold rule.
- Unpinned native sessions are **byte-identical** to today (lite fields and
  composition unchanged).
- The neutral core stays neutral: the pin is a plain number on
  `NativeSession` opts; reading the SDK-shaped `settings` object happens in
  the host adapter (`native-provider.ts`), not in core.

## Non-goals

- **Live window adjustment.** Adding `autoCompactWindow` to the native
  `applyFlagSettings` allowlist (`native-session.ts:2157`) is a small,
  natural follow-up once the pin is a session field, but it is a separate
  feature (a live control surface, client wiring, capability advertisement).
  This spec is spawn-time only, matching the claude provider's live channel.
- **The CLI's fixed threshold formula** (`− min(maxOutput,20000) − 13000`)
  as native's policy. Native keeps `nativeAutoCompactRatio` + the
  `DEFAULT_MAX_TOKENS` output reserve. Aligning the two providers' *policies*
  is a different decision; this spec aligns their *semantics* (pin = window).
- **Changing the bar denominator.** `maxTokens` stays the resolved model
  window, matching the pump's deliberate bar convention
  (`session-pump.ts:2744-2746`, "the bar's maxTokens/percentage keep the
  model's real window"). The pin's effect is carried by the threshold marker,
  not the denominator. (The claude probe lens reports the policy window as
  its denominator; reconciling those two lenses is out of scope.)
- **The claude provider, the pump's claude fallback/drift path, persistence,
  and the client.** Untouched. `SessionMeta.autoCompactWindow` keeps its
  persistence + spawn-re-injection + `SessionInfo` projection roles; only the
  manager's compaction-decision read of it is removed.
- **Gateway model-window correction** for the claude provider (the CLI
  guesses 200K for unrecognized gateway models, §4.2.1) — a separate
  follow-up identified in the research note.

## Design

### Pin plumbing — host adapter reads, core receives a number

`native-provider.ts:245` already extracts
`opts.providerExtras?.sdkOptions` for `skills` and the tool profile. Read
the pin alongside them:

```ts
const sdkOptions = opts.providerExtras?.sdkOptions as
  ({ skills?: string[] | 'all'; settings?: { autoCompactWindow?: unknown } }
   & Record<string, unknown>) | undefined
```

Pass a coerced positive number (or `undefined`) into the `NativeSession`
opts as a new neutral field `autoCompactWindow?: number`, declared next to
`modelContext?` (`native-session.ts:288-290`). The value is already coerced
upstream — the manager persists only finite positive integers
(`server/persistence.ts:275-277`) and the form clamps to 100k–1M — so the
adapter forwards it without speculative re-validation (a non-number or
non-positive value reaching this point is a contract violation that should
surface, not be silently absorbed; coerce defensively only at the
SDK-shaped boundary where `unknown` is the declared type).

`createSession` runs on every spawn, and the manager re-injects the pin each
time, so resume / fork / clear / respawn re-capture it with no extra
lifecycle work — exactly the `skills` pattern.

### Pin-aware `getContextUsage()` — `native-session.ts:1948-1977`

Inside the existing generation-retry loop, after `contextWindow` resolves:

```ts
const pin = this.opts.autoCompactWindow
const effectiveWindow = pin !== undefined && pin > 0
  ? Math.min(contextWindow, pin)
  : contextWindow
const outputReservedWindow = effectiveWindow - DEFAULT_MAX_TOKENS
const autoCompactThreshold = outputReservedWindow > 0
  ? Math.min(Math.floor(effectiveWindow * this.opts.ports.config.nativeAutoCompactRatio), outputReservedWindow)
  : 0
return {
  totalTokens,
  maxTokens: contextWindow,          // unchanged: the resolved model window
  model,
  autoCompactThreshold,              // now derived from the effective window
  ...(opts?.detail === 'summary' ? {} : this.contextComposition(totalTokens, contextWindow, autoCompactThreshold)),
}
```

- `effectiveWindow` is the single place the pin enters the math; the ratio
  policy and the output-reserve clamp are unchanged, applied to the
  effective window instead of the raw window.
- `maxTokens` stays `contextWindow` (Non-goals). The composition assembly
  (`contextComposition`, `native-session.ts:1991-2048`) is **unchanged** — it
  already computes `buffer = maxTokens − autoCompactThreshold` and
  `free = max(0, maxTokens − totalTokens − buffer)` from the lite fields, so
  a pin-aware threshold makes those rows honest with no edit.
- The generation-retry loop, the `totalTokens` formula, and the
  `detail: 'summary'` gate stay exactly as they are.

Edge behavior (all follow from the formula, no special cases):

| pin | effectiveWindow | threshold | note |
|---|---|---|---|
| undefined | contextWindow | today's value | byte-identical |
| ≥ contextWindow | contextWindow | today's value | clamp is a no-op |
| 0 < pin < contextWindow | pin | `min(floor(pin×ratio), pin−16384)` | the fix |
| pin ≤ DEFAULT_MAX_TOKENS (16384) | pin | 0 | output reserve non-positive → compaction disabled, buffer row omitted (existing threshold-0 semantics) |

A model down-switch re-resolves `contextWindow` per generation;
`effectiveWindow = min(newWindow, pin)` recomputes, so the pin persists
across model switches (matching the claude session-override behavior).

### Single-writer compaction decision — `session-manager.ts:6172-6174`

```ts
const threshold = usage.autoCompactThreshold
  ?? Math.floor(usage.maxTokens * defaultConfig.nativeAutoCompactRatio)
```

The `s.autoCompactWindow ??` prefix is removed: the provider's reported
threshold is already pin-aware, so the manager consumes it directly. The
`?? ratio` fallback survives only for a provider that reports no threshold
(`undefined`); native always reports one, so the fallback is inert for
native and remains the legacy path for any future provider without a
threshold. The `threshold <= 0` disable guard and the
`usage.totalTokens < threshold` comparison are unchanged.

The doc comment at `session-manager.ts:6126-6128` ("Explicit
`autoCompactWindow` wins over the provider threshold…") is rewritten to the
single-writer contract: the provider reports the effective threshold
(pin-aware for native); the manager only falls back to the ratio when the
provider reports none.

`s.autoCompactWindow` remains on the manager `Session` for persistence,
spawn re-injection, and the `SessionInfo` projection
(`session-manager.ts:1817,5697,5777`); only the compaction-decision read is
removed. The pump's claude-path reads (`session-pump.ts:1751,2338`) are
untouched.

### Behavior change (accepted, product-visible)

A pinned native session's compaction trigger moves from `pin` to
`min(floor(pin × ratio), pin − DEFAULT_MAX_TOKENS)` — e.g. pin 150000 at
ratio 0.8 fires at **120000** instead of 150000. This is earlier, matches
the window semantics the form promises, and matches the claude side's shape
(trigger always below the window). Persisted pin values are unchanged; their
meaning shifts from "trigger point" to "policy window". This is the intended
unification, not a regression — but it is a real change for existing pinned
native sessions and is called out in the decision record.

### What does NOT change

- Composition assembly, the estimator, the skills/MCP payloads — none.
- Client (`ContextComposition.tsx`, `ContextBar`, `ContextUsage` type) — none.
- claude provider, pump claude fallback/drift math, persistence coerce,
  `SessionMeta`/`SessionInfo` shape — none.
- Wire protocol, history ring, pump lite formula — none.

## Constraints

- **Neutrality.** The pin is a `number` on `NativeSession` opts; the
  derivation uses only numbers + `ports.config`. Reading the SDK-shaped
  `settings` object stays in `native-provider.ts` (host adapter, SDK types
  allowed). `native/vocabulary/neutrality.test.ts` and
  `native/host-free.test.ts` must stay green (they auto-scan core production
  files; no new core import of SDK/host-frame vocabulary is introduced).
- **No new per-turn work.** The change is inside `getContextUsage()` (a lazy
  probe / tab-open pull) and the manager's existing compaction read. No
  history walk, no per-turn pricing.
- **Unpinned byte-identity.** With no pin, the lite fields and composition
  are identical to today; existing unpinned tests must pass unchanged.
- Diagnostics through `createLogger(scope)`; review before commit; the
  usual gates (`npm run typecheck` both tsconfigs, `npm run test`,
  `npm run lint`, `npm run verify:agent-notes`).

## Test plan

- `native-session.test.ts` (extend the `getContextUsage` cases):
  - pinned session reports `autoCompactThreshold ==
    min(floor(min(window,pin)×ratio), min(window,pin)−16384)`;
  - unpinned session byte-identical to the existing expectation;
  - `pin ≥ window` is a no-op;
  - `pin ≤ 16384` yields threshold 0 and omits the buffer row;
  - composition buffer/free rows under a pin match the reported threshold
    (the display-honesty pin);
  - model down-switch recomputes `min(newWindow, pin)`.
- `session-manager.test.ts`: rewrite the case at `:3309` ("uses an explicit
  autoCompactWindow before the provider threshold") to the single-writer
  contract — the provider threshold wins; the manager applies the ratio
  fallback only when the provider reports `undefined`. Add a case proving a
  pinned native session compacts at the provider's pin-derived threshold,
  not at the raw pin.
- **Forced-compaction idiom migration.** The e2e tests force compaction with
  `settings: { autoCompactWindow: 1 }`
  (`e2e-persistence.test.ts:330,376`, `e2e-skill-invocation.test.ts:679`);
  under window semantics `floor(1×0.8) == 0` disables compaction, so these
  move to a pin whose derived threshold the scripted usage exceeds (e.g.
  pin 100000 with scripted `totalTokens ≥ 80000`, or a test-config ratio).
  `e2e-attachment-fidelity.test.ts:520,542` sets
  `liveSession(...).autoCompactWindow` directly on the manager session; with
  the prefix removed that field no longer drives compaction, so those move
  the pin to spawn `settings` (the real channel).
- **Pump authority pin.** Add a case proving a pinned native session's
  authoritative probe threshold is not overwritten by the claude-formula
  fallback (`session-pump.ts:2338-2346`) — facts carrying a threshold win;
  the formula replica is claude-only.
- Gates: full native suite + neutrality + typecheck + lint + agent-notes.
  Manual: open a pinned native session's Context tab and confirm the buffer
  marker sits at the pin-derived threshold; compare with a claude session
  pinned to the same number.

## Decision record

On implementation, write
`.agents/notes/implemented/feature/2026-11-25-native-pin-aware-auto-compact.md`
covering: the single-writer choice (provider reports the effective
threshold; manager prefix removed) vs the conservative display-only variant
(threshold = pin, no behavior change, semantics stay split); the ratio-on-
effective-window policy vs importing the CLI fixed formula; `maxTokens`
staying the model window (bar convention) vs the CLI policy-window
denominator; the accepted trigger-point behavior change for existing pinned
native sessions; and the live-verification evidence that the claude runtime
channel is inert (so spawn-time is the shared channel). Link this spec and
`docs/research/2026-11-25-claude-cli-auto-compact.md` §4.2.1.

## Calls made by the builder (not user-decided)

1. **Ratio policy on the effective window**, not the CLI fixed formula —
   one policy across pinned/unpinned, the cleanest state model. (User chose
   the recommended option over the conservative display-only variant.)
2. **`maxTokens` stays the resolved model window**; the threshold marker
   carries the pin — matching the pump's bar convention rather than the CLI
   probe denominator.
3. **Full fix including manager prefix removal**, accepting the trigger-point
   behavior change for existing pinned native sessions.
4. **Live setter deferred** to a separate follow-up (the
   `applyFlagSettings` allowlist extension), keeping this spec spawn-time
   only and symmetric with the claude provider's live channel.
5. **Pin trusted as coerced upstream** (persistence + form); the adapter
   coerces only at the `unknown`-typed SDK boundary, no speculative
   re-validation in core.