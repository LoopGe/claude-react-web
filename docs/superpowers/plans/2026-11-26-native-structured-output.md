# Native Structured Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the native provider schema-constrained structured output via a DSH-style terminal tool, usable both by the `Agent`/`Task` tool (`outputSchema` on a subagent) and by a one-shot `NativeProvider.runStructured` — the capability lands this phase; the live `StructuredPanel` routes to it only after the block-3 default flip.

**Architecture:** Borrow DSH `packages/subagent/subagent/src/structured.ts`: a `StructuredOutput` terminal tool whose parameter schema IS the caller's schema, a guidance instruction demanding the run finish by calling it, strict arg validation with in-turn retry, and a terminal guard that closes the run after a successful capture. One neutral structured-runtime module serves both entries. The subagent entry attaches it to the nested run; the app entry runs a one-shot native loop with it attached.

**Tech Stack:** TypeScript, Node, the native neutral vocabulary + loop (`runTurn`), vitest (server tests in Node), the provider `_testStream` scripted seam.

**Spec:** `docs/superpowers/specs/2026-11-26-native-capability-fills-design.md` (G2)

## Global Constraints

- Tool name PascalCase: `StructuredOutput` (DSH's `structured_output` is its vocabulary, not borrowed).
- Native core stays neutral: the structured-runtime module imports only neutral siblings (`./tools/types.js`, vocabulary) — no SDK/agent-message/host-frame imports. `neutrality.test.ts` / `host-free.test.ts` green.
- **Provider-only this phase (user-decided):** `StructuredPanel` is NOT modified and does NOT route to native now (`SessionManager.runStructured` delegates to `defaultProvider`, still claude until block 3). Acceptance is provider-side: tests construct a native-default manager. No provider-selection mechanism added.
- The claude provider and SDK 0.3.311 / CLI 2.1.311 contract are NOT modified.
- `StructuredRunResult` wire shape is fixed by `shared/structured.ts` (`coerceStructuredOutput`); the native backend returns that shape.
- Implementation isolates in a worktree branched from current `main`; do not touch parallel plugin-skill files.
- Verify: `npm run typecheck` (all configs), `npx vitest run <path>`, `npm run lint`.

## Review Focus

- **Schema conformance with retry.** A `StructuredOutput` call whose args violate the schema returns an error result so the model retries within the turn; a conforming call captures the value. A reasonable caller expects the returned `structuredOutput` to actually match the schema.
- **Terminal closure.** After a successful capture the run is complete — further tool calls are denied/ignored, and a second `StructuredOutput` call cannot reopen or overwrite the captured value.
- **Subagent result projection.** An `Agent`/`Task` call with `outputSchema` returns the captured structured value to the parent (not merely the last assistant text); without `outputSchema` the existing text-report behavior is unchanged.
- **One-shot terminal outcomes.** `runStructured` returns `ok:true` with the captured value on success; `ok:false` with a recognized `errorSubtype` on max-turns / execution error / no valid capture. Abort signal tears the run down.
- **No-capture failure.** A run that ends without a valid `StructuredOutput` capture is a failure (`ok:false`), not a silent empty success.
- **Backward compatibility.** Existing `Agent`/`Task` calls (no `outputSchema`) and the claude provider are unaffected.

---

### Task 1: Neutral structured-runtime module

**Files:**
- Create: `server/providers/native/structured.ts`
- Test: `server/providers/native/structured.test.ts`

**Interfaces:**
- Consumes: `ToolDef`, `ToolContext`, `ToolOutcome` from `./tools/types.js`.
- Produces:
  - `export interface StructuredAttachment { tool: ToolDef; captured(): { value: unknown } | undefined; isClosed(): boolean }`
  - `export function attachStructuredRuntime(schema: Record<string, unknown>): StructuredAttachment` — builds the `StructuredOutput` tool (parameter schema = `schema`, guidance instruction "finish by calling StructuredOutput; plain text does not count"), validates args against `schema` on run (violation → `{ text, isError: true }` for in-turn retry), captures the value on a valid call, and closes the run (subsequent tool calls / a second capture are blocked).
  - `export const STRUCTURED_OUTPUT_GUIDANCE: string`
  - A bounded JSON-schema arg validator (see Step 3 decision).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { attachStructuredRuntime } from './structured.js'

const schema = { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] }
const ctx = { cwd: '/tmp', signal: new AbortController().signal }

describe('attachStructuredRuntime', () => {
  it('names the tool StructuredOutput with the caller schema as parameters', () => {
    const a = attachStructuredRuntime(schema)
    expect(a.tool.name).toBe('StructuredOutput')
    expect(a.tool.schema).toEqual(schema)
  })
  it('captures a conforming value', async () => {
    const a = attachStructuredRuntime(schema)
    const out = await a.tool.run({ result: 'ok' }, ctx)
    expect(out.isError).toBeFalsy()
    expect(a.captured()).toEqual({ value: { result: 'ok' } })
  })
  it('rejects a non-conforming value with an error result and does not capture', async () => {
    const a = attachStructuredRuntime(schema)
    const out = await a.tool.run({ result: 123 }, ctx)
    expect(out.isError).toBe(true)
    expect(a.captured()).toBeUndefined()
  })
  it('rejects a missing required property', async () => {
    const a = attachStructuredRuntime(schema)
    const out = await a.tool.run({}, ctx)
    expect(out.isError).toBe(true)
    expect(a.captured()).toBeUndefined()
  })
  it('closes after capture: a second call cannot overwrite', async () => {
    const a = attachStructuredRuntime(schema)
    await a.tool.run({ result: 'first' }, ctx)
    const second = await a.tool.run({ result: 'second' }, ctx)
    expect(second.isError).toBe(true)
    expect(a.captured()).toEqual({ value: { result: 'first' } })
    expect(a.isClosed()).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/structured.test.ts`
Expected: FAIL — cannot resolve `./structured.js`.

- [ ] **Step 3: Implement `structured.ts`**

Follow DSH `structured.ts` (terminal tool + guidance + validation-retry + monotonic terminal guard), simplified to native's tool pipeline: capture commits on a successful valid call (no separate two-phase `tools/result` notification — native's loop has no transformable waterfall). The `run` validates args, returns `{text, isError:true}` on violation (model retries), captures + closes on success.

**Validator decision (builder):** there is no JSON-schema validator in source. Check `package.json` for `ajv` as a DIRECT dependency — if present, use it; otherwise implement a bounded validator covering `type` (object/string/number/boolean/array), `properties`, `required`, `enum`, `items` sufficient for structured-output schemas. Fail closed on unsupported schema constructs (reject rather than silently accept). Keep the module neutral.

**Terminal-guard seam (builder):** `isClosed()` lets the loop/deny further tools after capture. How the loop consults it (a guard in `requestPermission`, or the tool concluding the turn) is settled in Task 2/3 where the loop is wired; this module exposes the flag and blocks a second capture itself.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/providers/native/structured.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/structured.ts server/providers/native/structured.test.ts
git commit -m "feat(native): structured-output terminal runtime (StructuredOutput tool + capture + guard)"
```

---

### Task 2: Agent/Task `outputSchema` integration

**Files:**
- Modify: `server/providers/native/subagent.ts` (`AgentToolInput` ~76, schema ~101, nested run ~208-261)
- Test: `server/providers/native/e2e-structured.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 `attachStructuredRuntime`, `STRUCTURED_OUTPUT_GUIDANCE`.
- Produces: `AgentToolInput.outputSchema?: Record<string, unknown>`; the `Agent`/`Task` schema gains an optional `outputSchema` property; when present, the nested run gets the `StructuredOutput` tool + guidance + terminal guard, and the tool result is the captured structured value (projected to the parent). Without it, behavior is unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
// e2e-structured.test.ts — scripted-provider harness (see e2e-plan-mode.test.ts / e2e-tools.test.ts)
it('Agent with outputSchema returns the captured structured value to the parent', async () => {
  // scripted subagent: call StructuredOutput({result:'done'}) then stop
  const { session } = await startNativeSession()
  const result = await driveAgent(session, { description: 'd', prompt: 'p', outputSchema: { type:'object', properties:{ result:{type:'string'} }, required:['result'] } })
  expect(result.structured).toEqual({ result: 'done' })
})
it('Agent without outputSchema keeps the text-report behavior', async () => {
  const { session } = await startNativeSession()
  const result = await driveAgent(session, { description: 'd', prompt: 'p' })
  expect(result.text).toBeTruthy()
  expect(result.structured).toBeUndefined()
})
it('subagent StructuredOutput arg violation retries within the turn', async () => {
  // scripted: StructuredOutput({result:123}) [invalid] → StructuredOutput({result:'ok'}) [valid]
  const { session } = await startNativeSession()
  const result = await driveAgent(session, { description:'d', prompt:'p', outputSchema: { type:'object', properties:{result:{type:'string'}}, required:['result'] } })
  expect(result.structured).toEqual({ result: 'ok' })
})
```

Adapt helpers to the existing scripted harness; the subagent result projection shape (`structured` vs `text`) is the builder's seam — pin that the captured value reaches the parent tool_result.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/e2e-structured.test.ts`
Expected: FAIL — `outputSchema` ignored / no structured result.

- [ ] **Step 3: Implement the integration**

Add `outputSchema` to `AgentToolInput` + the tool schema (optional object). In `createAgentTool.run`, when `outputSchema` is present: `const structured = attachStructuredRuntime(outputSchema)`; add `structured.tool` to `nestedTools`; append `STRUCTURED_OUTPUT_GUIDANCE` to `nestedSystem`; wire the terminal guard so post-capture tool calls are denied (consult `structured.isClosed()` in the nested `requestPermission`). After `runTurn`, if `structured.captured()` exists, return it as the structured result to the parent; else fall back to the existing text report (and treat no-capture as the run's outcome per Task 3 semantics). Validate `outputSchema` is an object (reject malformed loudly).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/providers/native/e2e-structured.test.ts server/providers/native/native-session.test.ts`
Expected: PASS (no regression to existing subagent tests).

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/subagent.ts server/providers/native/e2e-structured.test.ts
git commit -m "feat(native): Agent/Task outputSchema via structured terminal runtime"
```

---

### Task 3: `NativeProvider.runStructured` + capability flip

**Files:**
- Modify: `server/providers/native/native-provider.ts` (`supportsStructuredOutput` ~134; add `runStructured`)
- Test: `server/providers/native/e2e-structured.test.ts`

**Interfaces:**
- Consumes: Task 1 `attachStructuredRuntime`; `StructuredRunRequest` / `StructuredRunResult` / `coerceStructuredOutput` from `shared/structured.ts`; the native loop (`runTurn`) + `_testStream` seam.
- Produces: `NativeProvider.runStructured(req: StructuredRunRequest, signal?: AbortSignal): Promise<StructuredRunResult>` implementing the `AgentProvider.runStructured` seam (`providers/types.ts:434`); `supportsStructuredOutput: true`.

- [ ] **Step 1: Write the failing tests**

```ts
// construct a native-default manager (session-manager.test.ts pattern) + scripted _testStream
it('runStructured returns ok:true with the captured value', async () => {
  const provider = makeNativeProviderWithScript(/* StructuredOutput({result:'x'}) then stop */)
  const res = await provider.runStructured({ prompt: 'p', schema: { type:'object', properties:{result:{type:'string'} }, required:['result'] } })
  expect(res.ok).toBe(true)
  expect(res.structuredOutput).toEqual({ result: 'x' })
})
it('runStructured returns ok:false on max-turns without capture', async () => {
  const provider = makeNativeProviderWithScript(/* tool calls until maxTurns, no StructuredOutput */)
  const res = await provider.runStructured({ prompt: 'p', schema: {...}, maxTurns: 1 })
  expect(res.ok).toBe(false)
  expect(res.errorSubtype).toBe('error_max_turns')
})
it('runStructured returns ok:false when the run ends with no valid capture', async () => {
  const provider = makeNativeProviderWithScript(/* plain text answer, no StructuredOutput */)
  const res = await provider.runStructured({ prompt: 'p', schema: {...} })
  expect(res.ok).toBe(false)
})
it('runStructured aborts on signal', async () => {
  const controller = new AbortController()
  const provider = makeNativeProviderWithScript(/* long run */)
  const p = provider.runStructured({ prompt: 'p', schema: {...} }, controller.signal)
  controller.abort()
  const res = await p
  expect(res.ok).toBe(false)
})
it('supportsStructuredOutput is true', () => {
  expect(makeNativeProvider().capabilities.supportsStructuredOutput).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/e2e-structured.test.ts -t "runStructured"`
Expected: FAIL — `runStructured` absent / capability false.

- [ ] **Step 3: Implement `runStructured` + flip capability**

Construct a one-shot, non-persisted native run with the structured runtime attached (reuse `runTurn` with a transient context, or a minimal headless NativeSession — builder's choice; it must not write a durable session log). Attach `attachStructuredRuntime(req.schema)`; run to terminal under `req.maxTurns` / `req.permissionMode` / `req.model` / `req.cwd`; honor `signal`. Map the outcome to `StructuredRunResult`: captured value → `{ok:true, structuredOutput, numTurns, totalCostUsd?}`; max-turns → `error_max_turns`; execution error → `error_during_execution`; no valid capture → `ok:false`. Narrow through `coerceStructuredOutput` before returning. Flip `supportsStructuredOutput: true`. Do NOT modify `StructuredPanel` or add provider selection (provider-only phase).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/providers/native/e2e-structured.test.ts`
Expected: PASS.

- [ ] **Step 5: Final verification + commit**

Run: `npm run typecheck && npm run lint && npx vitest run server/providers/native/vocabulary/neutrality.test.ts server/providers/native/host-free.test.ts`
Expected: PASS.

```bash
git add server/providers/native/native-provider.ts server/providers/native/e2e-structured.test.ts
git commit -m "feat(native): one-shot runStructured + supportsStructuredOutput"
```

---

### Task 4: Owning agent note

**Files:**
- Create: `.agents/notes/implemented/feature/2026-11-26-native-structured-output.md`

**Interfaces:**
- Consumes: the decisions above; `.agents/notes/README.md` contract.
- Produces: a decision record capturing the DSH terminal-tool borrowing, the `StructuredOutput` naming, the simplified capture (no two-phase), the validator choice, the provider-only phase boundary (panel routes at block 3), and parked follow-ups (live panel routing; nested structured guidance parity if any).

- [ ] **Step 1: Write the note** per the README contract (Problem → Decision → Alternatives considered → Consequences; `Status: implemented`; relative links to the spec).

- [ ] **Step 2: Verify structure**

Run: `npm run verify:agent-notes`
Expected: OK.

- [ ] **Step 3: Commit**

```bash
git add .agents/notes/implemented/feature/2026-11-26-native-structured-output.md
git commit -m "docs(native): owning agent note for native structured output"
```

---

## Self-Review

**Spec coverage:** G2 terminal-tool mechanism (Task 1), Agent/Task `outputSchema` (Task 2), one-shot `runStructured` + capability flip (Task 3), provider-only boundary (Global Constraints + Task 3 no-panel-change), `StructuredOutput` naming (Task 1), agent note (Task 4). All G2 spec bullets map to a task.

**Review Focus coverage:** schema conformance/retry (Task 1/2), terminal closure (Task 1), subagent projection (Task 2), one-shot terminal outcomes + abort (Task 3), no-capture failure (Task 3), backward compat (Task 2 no-schema test + claude untouched).

**Type consistency:** `attachStructuredRuntime` / `StructuredAttachment` / `STRUCTURED_OUTPUT_GUIDANCE` / `StructuredOutput` / `outputSchema` / `runStructured` consistent across tasks; `StructuredRunResult` from `shared/structured.ts`.

**Proportion:** code blocks are test assertions + signatures; bodies (validator, loop seam, one-shot construction) left to the implementer with named decisions.