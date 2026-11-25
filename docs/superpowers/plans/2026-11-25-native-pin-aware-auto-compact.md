# Native Pin-Aware Auto-Compact Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the native provider report a pin-aware auto-compact threshold so the Context tab matches the real compaction trigger, and give the spawn pin one meaning (a policy window) across providers via a single-writer decision.

**Architecture:** The host adapter (`native-provider.ts`) reads the spawn pin from `providerExtras.sdkOptions.settings` and passes a neutral number into `NativeSession`. `getContextUsage()` derives the threshold from `effectiveWindow = min(modelWindow, pin)` using the existing ratio policy; `maxTokens` stays the model window and the composition assembly is untouched. The manager drops its divergent `s.autoCompactWindow ??` prefix and consumes the provider's threshold directly.

**Tech Stack:** TypeScript, vitest (Node env for server tests), existing native provider fixtures (`providerWithStreamer`, `resolverOf`, `pricedTurn`, `makeNativePorts`).

**Spec:** `docs/superpowers/specs/2026-11-25-native-pin-aware-auto-compact-design.md`

## Global Constraints

- Neutrality: the pin is a `number` on `NativeSession` opts; reading the SDK-shaped `settings` object stays in `native-provider.ts` (host adapter). `native/vocabulary/neutrality.test.ts` and `native/host-free.test.ts` must stay green. No SDK/host-frame import in native core.
- Unpinned byte-identity: with no pin, the lite fields and composition are identical to today; existing unpinned tests pass unchanged.
- `maxTokens` stays the resolved model window (the bar convention, `session-pump.ts:2744-2746`); the pin's effect rides `autoCompactThreshold`, not the denominator.
- The composition assembly (`contextComposition`, `native-session.ts:1991-2048`), the estimator, the client, the claude provider, the pump's claude fallback/drift path, and persistence coerce are NOT modified.
- No new per-turn work: changes live inside `getContextUsage()` (a lazy probe) and the manager's existing compaction read.
- Native threshold math (for test values): `DEFAULT_MAX_TOKENS = 16384` (`native-session.ts:115`), ratio `0.8`. For pin `P`, `threshold = min(floor(0.8·P), P − 16384)` when `P − 16384 > 0`, else `0`. The reserve arm binds for `P ≤ 81920`: `P = 16385 → threshold 1`; `P = 66384 → threshold 50000`; `P = 150000 → threshold 120000` (ratio arm).
- Diagnostics through `createLogger(scope)`, never bare `console.*`.
- Review before commit (CLAUDE.md): each task's diff reviewed before its commit; a whole-branch `code-review` skill run precedes declaring done.
- Commit messages end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- Verify commands: `npm run typecheck` (both tsconfigs), `npm run test`, `npm run lint`, `npm run verify:agent-notes`. Single file: `npx vitest run <path>`.
- The working tree is a SHARED dirty tree with unrelated uncommitted/untracked files. Before Task 1, create a feature branch from current HEAD (`git checkout -b fix/native-pin-aware-auto-compact`). Every commit stages ONLY the files its task lists — never the unrelated files.

## Review Focus

1. **Tiny pin (`P ≤ 16384`)** — threshold 0, compaction disabled, buffer row absent, free space never negative. A user pinning a window below the output reserve must not get a phantom buffer or negative math. → Task 1 tiny-pin test.
2. **Pin above the model window** — clamp is a no-op; the pin can never raise capacity. → Task 1 clamp test.
3. **Model down-switch with a pin** — `effectiveWindow = min(newWindow, pin)` recomputes; no stale threshold from the old window. → Task 1 down-switch test.
4. **Pinned native composition honesty** — buffer/free rows match the pin-derived threshold (the core defect: display ≠ decision). → Task 1 composition-under-pin test.
5. **Pump authority on a pinned native session** — the provider's pin-aware threshold is not overwritten by the claude-formula replica (`session-pump.ts:2338-2346`). → Task 3 pump test.

---

### Task 1: Pin plumbing + pin-aware `getContextUsage`

**Files:**
- Modify: `server/providers/native/native-provider.ts:245` (sdkOptions extraction), `:283-297` (NativeSession ctor pass-through)
- Modify: `server/providers/native/native-session.ts:288-290` (opts field), `:1948-1977` (getContextUsage)
- Test: `server/providers/native/native-session.test.ts` (extend near the getContextUsage cases at `:674-776`)

**Interfaces:**
- Consumes: `opts.providerExtras?.sdkOptions` (already extracted at `native-provider.ts:245`); `this.opts.ports.config.nativeAutoCompactRatio`; `DEFAULT_MAX_TOKENS` (`native-session.ts:115`); the existing `modelContext.resolve` generation-retry loop.
- Produces: `NativeSession` opts field `autoCompactWindow?: number` (neutral). `getContextUsage()` returns the same four lite fields with `autoCompactThreshold` derived from `min(contextWindow, pin)`; `maxTokens` unchanged. Task 2 relies on the provider reporting a pin-aware threshold.

- [ ] **Step 1: Write the failing tests** (append to `native-session.test.ts`, matching the fixture pattern at `:674-776`: `tempDir`, `providerWithStreamer([pricedTurn('ok', 100_000)], dir)` or `resolverOf` + `_testStream` for a custom window, drain `session.messages`, `enqueueUserMessage(userMsg('hi') as never)`, `vi.waitFor` on a result frame, `await session.getContextUsage?.() as NativeContextUsage`, `destroy` in finally). The pin rides `provider.createSession({ id, cwd, providerExtras: { sdkOptions: { settings: { autoCompactWindow: P } } } })`.

```ts
it('derives the threshold from min(window, pin) on a pinned session', async () => {
  // default 200K window, pin 150000 → effectiveWindow 150000 → threshold 120000
  const usage = await pinnedUsage(150_000) // helper: create with the pin, run pricedTurn('ok', 100_000)
  expect(usage.maxTokens).toBe(200_000)            // denominator stays the model window
  expect(usage.autoCompactThreshold).toBe(120_000) // min(floor(150000×0.8)=120000, 150000−16384=133616)
})

it('leaves an unpinned session byte-identical', async () => {
  const usage = await pinnedUsage(undefined)
  expect(usage.maxTokens).toBe(200_000)
  expect(usage.autoCompactThreshold).toBe(160_000) // today's value
})

it('clamps a pin above the model window to a no-op', async () => {
  const usage = await pinnedUsage(300_000) // ≥ 200K window
  expect(usage.autoCompactThreshold).toBe(160_000)
})

it('disables compaction and omits the buffer row for a tiny pin', async () => {
  const usage = await pinnedUsage(16_000) // ≤ DEFAULT_MAX_TOKENS → reserve non-positive
  expect(usage.autoCompactThreshold).toBe(0)
  expect(usage.categories!.some((c) => c.kind === 'buffer')).toBe(false)
  expect(usage.categories!.every((c) => c.tokens >= 0)).toBe(true)
})

it('makes the composition buffer/free rows honest under a pin', async () => {
  const usage = await pinnedUsage(150_000) // threshold 120000, totalTokens 100000
  expect(usage.categories!.find((c) => c.kind === 'buffer')!.tokens).toBe(80_000) // 200000 − 120000
  expect(usage.categories!.find((c) => c.kind === 'free')!.tokens).toBe(20_000)   // 200000 − 100000 − 80000
})

it('recomputes min(newWindow, pin) on a model down-switch', async () => {
  // resolverOf returns 200K then 100K across a modelGeneration bump; pin 150000.
  // After the switch: effectiveWindow = min(100000, 150000) = 100000 → threshold min(80000, 83616) = 80000.
  // Follow the existing generation-retry test at :961-995 for the resolve-mocking idiom.
  expect(usage.autoCompactThreshold).toBe(80_000)
})
```

Write a local `pinnedUsage(pin)` helper factoring the shared create→turn→probe→destroy flow (mirror `:696-719`). The down-switch test mocks `resolverOf` with a mutable resolution and bumps the model generation per the existing idiom at `:961-995`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/providers/native/native-session.test.ts -t 'pin'`
Expected: FAIL — the pinned threshold is still 160000 (pin ignored).

- [ ] **Step 3: Add the neutral opts field** (`native-session.ts:288-290`)

Add next to `modelContext?`:
```ts
/** Spawn auto-compact policy window (absolute tokens), read by the host
 *  adapter from Options.settings. Clamped under the resolved model window
 *  in getContextUsage; undefined = no pin. */
autoCompactWindow?: number
```

- [ ] **Step 4: Read the pin in the host adapter** (`native-provider.ts:245,283-297`)

Extend the `sdkOptions` cast at `:245` with `settings?: { autoCompactWindow?: unknown }`. Coerce at this SDK-shaped boundary (matching `persistence.ts:275-277`): `typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined`. Pass `autoCompactWindow: <coerced>` into the `new NativeSession({…})` object at `:283-297` (alongside `skills`).

- [ ] **Step 5: Derive the threshold from the effective window** (`native-session.ts:1948-1977`)

Inside the generation-retry loop, after `contextWindow` resolves:
```ts
const pin = this.opts.autoCompactWindow
const effectiveWindow = pin !== undefined && pin > 0 ? Math.min(contextWindow, pin) : contextWindow
const outputReservedWindow = effectiveWindow - DEFAULT_MAX_TOKENS
const autoCompactThreshold = outputReservedWindow > 0
  ? Math.min(Math.floor(effectiveWindow * this.opts.ports.config.nativeAutoCompactRatio), outputReservedWindow)
  : 0
```
Return `maxTokens: contextWindow` (unchanged) and the new `autoCompactThreshold`; pass `autoCompactThreshold` into `contextComposition(totalTokens, contextWindow, autoCompactThreshold)` unchanged. The `totalTokens` formula, generation check, and `detail: 'summary'` gate stay exactly as they are.

- [ ] **Step 6: Run to verify pass + unpinned identity**

Run: `npx vitest run server/providers/native/native-session.test.ts`
Expected: PASS — new pin cases AND all existing getContextUsage/composition cases (unpinned byte-identical).

- [ ] **Step 7: Neutrality + typecheck**

Run: `npx vitest run server/providers/native/vocabulary/neutrality.test.ts server/providers/native/host-free.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Self-review the diff, then commit**

```bash
git add server/providers/native/native-provider.ts server/providers/native/native-session.ts server/providers/native/native-session.test.ts
git commit -m "feat(native): derive auto-compact threshold from the pinned effective window

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Single-writer compaction decision + test migration

**Files:**
- Modify: `server/session-manager.ts:6172-6174` (threshold), `:6126-6128` (comment)
- Test: `server/session-manager.test.ts:3309-3318` (rewrite)
- Test: `server/providers/native/e2e-persistence.test.ts:330,376,413-414`
- Test: `server/providers/native/e2e-skill-invocation.test.ts:679`
- Test: `server/providers/native/e2e-attachment-fidelity.test.ts:197-204` (source create), `:520,542` (remove live mutations), trigger turn

**Interfaces:**
- Consumes: Task 1's pin-aware `getContextUsage()` (the provider now reports the effective threshold). `cachedUsage` fixture (`session-manager.test.ts:3045`, defaults `totalTokens: 90, maxTokens: 100`).
- Produces: the manager reads `usage.autoCompactThreshold ?? floor(usage.maxTokens × ratio)` — no pin prefix. `s.autoCompactWindow` remains for persistence/spawn-re-injection/SessionInfo only.

- [ ] **Step 1: Rewrite the manager unit test to the single-writer contract** (`session-manager.test.ts:3309-3318`)

The old test asserts pin 80 beats provider threshold 100. Replace with: the provider threshold wins regardless of the spawn pin.
```ts
it('consumes the provider threshold without a pin prefix', async () => {
  const info = await sm.create({ settings: { autoCompactWindow: 80 } } as unknown as Parameters<typeof sm.create>[0])
  const live = liveSession(info.id)
  live.handle.compactInPlace = vi.fn(async () => {})
  // Provider reports 100; totalTokens 90 < 100 → no compaction, even though the
  // spawn pin is 80 (the manager no longer treats the pin as a threshold).
  live.lastContextUsage = cachedUsage({ autoCompactThreshold: 100 })
  await callAutoCompact(live)
  expect(live.handle.compactInPlace).not.toHaveBeenCalled()
})
```
Keep the neighboring tests (`:3297` provider-threshold-before-ratio, `:3320` ratio-fallback-only-when-absent) — they still hold.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/session-manager.test.ts -t 'consumes the provider threshold'`
Expected: FAIL — the manager still applies the pin 80 prefix and compacts.

- [ ] **Step 3: Remove the pin prefix** (`session-manager.ts:6172-6174`)

```ts
const threshold = usage.autoCompactThreshold
  ?? Math.floor(usage.maxTokens * defaultConfig.nativeAutoCompactRatio)
```
Rewrite the comment at `:6126-6128` to: the provider reports the effective threshold (pin-aware for native); the manager falls back to the ratio only when the provider reports none; zero disables. The `threshold <= 0` guard and `usage.totalTokens < threshold` comparison stay.

- [ ] **Step 4: Migrate the forced-compaction e2e tests**

The native threshold is now `min(floor(0.8·P), P−16384)`; `pin: 1` yields threshold 0 (compaction disabled), so the old force-compact idiom breaks. Two recipes:

**Recipe A — force every turn with tiny usage** (`pin: 1` → `pin: 16385`, threshold 1, fires for any usage ≥ 1, behaviorally identical to the old `pin: 1`):
- `e2e-persistence.test.ts:330` (first auto-compact test): `settings: { autoCompactWindow: 16385 }`; update the comment to explain the reserve-arm derivation.
- `e2e-skill-invocation.test.ts:679`: `settings: { autoCompactWindow: 16385 }`.

**Recipe B — force once, then stop** (pin 66384 → threshold 50000; script the trigger turn with `input_tokens: 100000` so it crosses, subsequent usage-10 turns stay below):
- `e2e-persistence.test.ts:376` (resume test): `settings: { autoCompactWindow: 66384 }`; arm the FIRST turn with a high-usage `textTurn` variant (`input_tokens: 100000`) so it compacts. The resumed post-compact turn (`armStream(second.provider, 'post-compact-reply')`, usage 10) stays below threshold 50000 → no re-compaction. **Remove** the inert live-field assignment at `:413-414` (`autoCompactWindow = Number.MAX_SAFE_INTEGER`) and its comment — it no longer drives compaction.
- `e2e-attachment-fidelity.test.ts`: pass `settings: { autoCompactWindow: 66384 }` through the source `createSession(fx, cwd, extra)` helper (`:197-204`) so the fork inherits it (the source's usage-10 turns never cross 50000). Replace the trigger turn `textTurn('AUTO TRIGGER DONE')` (`:526`) with a high-usage variant (`input_tokens: 100000`). **Remove** both live-field mutations (`:520` `= 1`, `:542` `= Number.MAX_SAFE_INTEGER`) — the trigger turn compacts, the subsequent usage-10 read turns do not.

Add a shared `highUsageTurn(text, inputTokens)` helper (a `textTurn` clone with configurable `input_tokens`) where Recipe B needs it.

- [ ] **Step 5: Run the migrated suites to verify pass**

Run: `npx vitest run server/session-manager.test.ts server/providers/native/e2e-persistence.test.ts server/providers/native/e2e-skill-invocation.test.ts server/providers/native/e2e-attachment-fidelity.test.ts`
Expected: PASS — single-writer contract + all forced-compaction assertions hold under spawn-time pins.

- [ ] **Step 6: Self-review the diff, then commit**

```bash
git add server/session-manager.ts server/session-manager.test.ts server/providers/native/e2e-persistence.test.ts server/providers/native/e2e-skill-invocation.test.ts server/providers/native/e2e-attachment-fidelity.test.ts
git commit -m "refactor(native): single-writer auto-compact threshold; migrate e2e pins to window semantics

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Pump authority pin, comment/doc sync, decision record, gates

**Files:**
- Test: `server/session-pump.test.ts` (extend near the pinned-window case at `:4356`)
- Modify: `server/session-types.ts:426-428`, `server/persistence.ts:81-85`, `src/types.ts:144-149`, `shared/auto-compact.ts:12-16` (comments)
- Create: `.agents/notes/implemented/feature/2026-11-25-native-pin-aware-auto-compact.md`

**Interfaces:**
- Consumes: Task 1+2's pin-aware native threshold and single-writer manager. `session-pump.ts:2338-2346` (facts-fold: a facts set carrying `threshold` keeps it; the formula replica is the fallback).
- Produces: durable decision record; green full gates.

- [ ] **Step 1: Write the pump authority test** (`session-pump.test.ts`)

Pin that a pinned native session's authoritative probe threshold survives the facts-fold: when `lastSdkAutoCompact` carries a `threshold` (the provider's pin-aware value) for the matching model, `resolveAutoCompactThreshold` keeps it and does NOT re-derive the claude formula against the pin. Follow the existing pinned-window fixture idiom at `:4356`. Assert the folded `autoCompactThreshold` equals the provider-reported value, not `pin − min(maxOutput,20000) − 13000`.

- [ ] **Step 2: Run to verify pass**

Run: `npx vitest run server/session-pump.test.ts`
Expected: PASS (this pins existing behavior; if it fails, the fold re-derives over a present threshold — fix the fold to keep a present facts threshold, which is the documented contract).

- [ ] **Step 3: Sync the spawn-channel comments**

- `server/session-types.ts:426-428`, `server/persistence.ts:81-85`, `src/types.ts:144-149`: note the native provider now consumes the pin at spawn (claude remains spawn-only because the runtime `applyFlagSettings` channel is inert — link `docs/research/2026-11-25-claude-cli-auto-compact.md` §4.2.1).
- `shared/auto-compact.ts:12-16`: clarify the formula replica is claude-only; native derives its threshold from the ratio policy on the effective window.

- [ ] **Step 4: Write the decision record**

`.agents/notes/implemented/feature/2026-11-25-native-pin-aware-auto-compact.md` per `.agents/notes/README.md` frontmatter. Cover: single-writer (provider reports the effective threshold; manager prefix removed) vs the conservative display-only variant; ratio-on-effective-window vs the CLI fixed formula; `maxTokens` staying the model window (bar convention) vs the CLI policy-window denominator; the accepted trigger-point behavior change for existing pinned native sessions (pin → ratio×pin); the live-verification evidence that the claude runtime channel is inert. Link the spec and the research note §4.2.1.

- [ ] **Step 5: Validate notes + full gates**

Run: `npm run verify:agent-notes && npm run typecheck && npm run test && npm run lint`
Expected: all PASS.

- [ ] **Step 6: Manual verification in the running app**

Open a pinned native session's Settings → Context tab: the Autocompact buffer marker sits at the pin-derived threshold (e.g. pin 150000 → 120000 on a 200K model), and free space matches. Compare with a claude session pinned to the same number (trigger 117000) — both markers below the window, each by its own policy.

- [ ] **Step 7: Whole-branch code-review, then commit**

Run the `code-review` skill on the full diff since the plan's first commit; verify and fix confirmed findings (re-review non-trivial fixes). Then:
```bash
git add server/session-pump.test.ts server/session-types.ts server/persistence.ts src/types.ts shared/auto-compact.ts .agents/notes/implemented/feature/2026-11-25-native-pin-aware-auto-compact.md
git commit -m "test(native): pin pump threshold authority + decision record

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
