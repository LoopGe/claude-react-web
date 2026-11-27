# Native Plan Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the native provider a plan mode with CLI-equivalent hard semantics — read-only exploration, a reviewed `ExitPlanMode` plan card, and approve→execute in the same turn — reusing the existing `PlanCard` with zero UI change.

**Architecture:** Borrow DSH's plan-mode architecture (entry signal + guidance + reviewed exit tool) but keep `plan` a permission-mode enum value. The broker gains a plan-enforcement branch that reads the manager's LIVE `session.permissionMode` (not the turn snapshot), so transitions take effect mid-turn. Plan guidance is appended per API round in the native `stream` wrapper from the live native mode. Model-driven entry (`EnterPlanMode`) routes through `SessionManager.setPermissionMode` via a host-bound tool callback so the manager field, the chip, and the native handle all update together.

**Tech Stack:** TypeScript, Node, Hono server, vitest (server tests run in Node), the native neutral vocabulary + host adapter seam.

**Spec:** `docs/superpowers/specs/2026-11-26-native-capability-fills-design.md` (G1)

## Global Constraints

- Tool names are PascalCase: `EnterPlanMode`, `ExitPlanMode` (match `PLAN_TOOL_NAMES` / `ENTER_PLAN_MODE_TOOL_NAME` in `src/constants/toolNames.ts`).
- Host stays SDK-shaped; native core stays neutral. `native/vocabulary/neutrality.test.ts` and `native/host-free.test.ts` must stay green — no SDK/host-frame imports in core production files.
- `plan` stays a permission-mode enum value; do NOT introduce an orthogonal plan state layer.
- The broker is the single enforcement point. The plan gate reads LIVE `session.permissionMode`, never the turn snapshot `ctx.permissionMode`.
- `src/components/tool-views/PlanCard.tsx` and the permission dialog are NOT modified.
- The claude provider and the SDK 0.3.311 / CLI 2.1.311 contract are NOT modified. The broker plan gate is unreachable for claude (the CLI enforces plan mode before `canUseTool`).
- Implementation isolates in a worktree; do NOT touch the parallel skill-parity files (`server/plugin-skills.ts`, `server/providers/native/skills.ts`, `skill-render.ts`).
- Verify commands: `npm run typecheck` (both tsconfigs), `npx vitest run <path>` (server tests), `npm run lint`.

## Review Focus

- **Approve→execute in the SAME turn.** After `ExitPlanMode` approval the next mutating tool must be allowed even though the turn started in `plan` (the turn snapshot still says `plan`). A reasonable user expects the approved plan to run immediately, not next turn.
- **Model-driven entry mid-turn.** A model `EnterPlanMode` call during a `default` turn must immediately deny subsequent mutating tools (live mode flips to `plan` while the snapshot stays `default`).
- **Read-only tools still work in plan mode.** `Read`/`Glob`/`Grep`/`LS`/`WebFetch`/`WebSearch`/`Skill` and read-only Bash pass; the model can still explore.
- **Plan gate precedence.** Entering plan from `acceptEdits`/`bypassPermissions` still denies mutating tools — the plan gate runs before those auto-allow paths.
- **Resume restores plan.** A session persisted in `plan` mode resumes with plan enforcement + guidance active.
- **Invalid plan rejected.** An `ExitPlanMode` plan without a leading `#` heading returns an error result so the model retries.

---

### Task 1: Neutral plan-mode tool definitions

**Files:**
- Create: `server/providers/native/tools/plan-mode.ts`
- Test: `server/providers/native/tools/plan-mode.test.ts`

**Interfaces:**
- Consumes: `ToolDef`, `ToolContext`, `ToolOutcome`, `ToolInputError` from `./types.js`.
- Produces:
  - `export const PLAN_MODE_GUIDANCE: string` — the plan-mode prompt section text ("You are in plan mode. Explore and design read-only; present the complete plan by calling ExitPlanMode. Do not execute changes.").
  - `export interface EnterPlanModeDeps { enterPlanMode(): Promise<void> }`
  - `export function createEnterPlanModeTool(deps: EnterPlanModeDeps): ToolDef` — name `EnterPlanMode`, empty object schema, `run` awaits `deps.enterPlanMode()` then returns `{ text: 'Entered plan mode.' }`.
  - `export function createExitPlanModeTool(): ToolDef` — name `ExitPlanMode`, schema `{ type:'object', properties:{ plan:{ type:'string' } }, required:['plan'] }`, `run` returns `{ text: <plan>, isError:true }` when `plan` is not a string starting with a `#` heading (after trim), else `{ text: <plan> }`.

- [ ] **Step 1: Write the failing tests**

```ts
// plan-mode.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createEnterPlanModeTool, createExitPlanModeTool, PLAN_MODE_GUIDANCE } from './plan-mode.js'

const ctx = { cwd: '/tmp', signal: new AbortController().signal }

describe('createEnterPlanModeTool', () => {
  it('is named EnterPlanMode with an empty object schema', () => {
    const tool = createEnterPlanModeTool({ enterPlanMode: async () => {} })
    expect(tool.name).toBe('EnterPlanMode')
    expect(tool.schema).toEqual({ type: 'object', properties: {} })
  })
  it('invokes the enterPlanMode callback on run', async () => {
    const enterPlanMode = vi.fn(async () => {})
    const tool = createEnterPlanModeTool({ enterPlanMode })
    const out = await tool.run({}, ctx)
    expect(enterPlanMode).toHaveBeenCalledOnce()
    expect(out.isError).toBeFalsy()
  })
})

describe('createExitPlanModeTool', () => {
  it('is named ExitPlanMode requiring a plan string', () => {
    const tool = createExitPlanModeTool()
    expect(tool.name).toBe('ExitPlanMode')
    expect(tool.schema.required).toEqual(['plan'])
  })
  it('accepts a plan starting with a # heading', async () => {
    const out = await createExitPlanModeTool().run({ plan: '# Title\n\n- step' }, ctx)
    expect(out.isError).toBeFalsy()
    expect(out.text).toContain('# Title')
  })
  it('rejects a plan without a leading # heading', async () => {
    const out = await createExitPlanModeTool().run({ plan: 'no heading here' }, ctx)
    expect(out.isError).toBe(true)
  })
})

it('exports non-empty plan guidance', () => {
  expect(PLAN_MODE_GUIDANCE.length).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/tools/plan-mode.test.ts`
Expected: FAIL — cannot resolve `./plan-mode.js`.

- [ ] **Step 3: Implement `plan-mode.ts`**

Follow the `ToolDef` shape in `tools/types.ts` and the pattern of `tools/skill.ts`. `EnterPlanMode.run` awaits the callback; `ExitPlanMode.run` validates `/^#/.test(plan.trim())`. Set `promptOrder` consistent with sibling tools; `guidance` is a one-sentence DSH-style section per tool. Keep the module neutral (only `./types.js` imports).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/providers/native/tools/plan-mode.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/tools/plan-mode.ts server/providers/native/tools/plan-mode.test.ts
git commit -m "feat(native): plan-mode tool definitions (EnterPlanMode/ExitPlanMode)"
```

---

### Task 2: Broker plan-mode hard enforcement (live mode)

**Files:**
- Modify: `server/permission-broker.ts` (insert after the `ExitPlanMode` branch ending ~line 338, before the `acceptEdits` branch ~line 347)
- Test: `server/permission-broker.test.ts`

**Interfaces:**
- Consumes: the broker's `session.permissionMode` (manager live field), existing edit/bash classifiers (`isInScopeEditTool`, `isAutoApprovableEditBash`) and read-only tool sets (`READONLY_TOOL_NAMES`, `SAFE_AUTO_TOOLS`).
- Produces: a plan-enforcement branch. When `session.permissionMode === 'plan'`, mutating tools (`Edit`, `Write`, `NotebookEdit`, and non-read-only `Bash`) resolve `{ behavior:'deny', message:'plan mode is active — present a plan via ExitPlanMode before making changes', interrupt:false }`; read-only tools fall through to the normal pipeline. The branch reads `session.permissionMode` (LIVE), not the snapshot `mode`.

- [ ] **Step 1: Write the failing tests**

Add to `permission-broker.test.ts` (reuse its existing broker/session harness):

```ts
describe('plan-mode enforcement', () => {
  it('denies Edit when the live session mode is plan even if the call snapshot is default', async () => {
    // session.permissionMode = 'plan'; ctx.permissionMode = 'default' (turn snapshot)
    const decision = await callBroker({ toolName: 'Edit', sessionMode: 'plan', ctxMode: 'default' })
    expect(decision.behavior).toBe('deny')
    expect(decision.message).toMatch(/plan mode/i)
  })
  it('allows Edit when the live mode left plan even if the turn snapshot is plan', async () => {
    // session.permissionMode = 'default'; ctx.permissionMode = 'plan'
    const decision = await callBroker({ toolName: 'Edit', sessionMode: 'default', ctxMode: 'plan' })
    expect(decision.behavior).not.toBe('deny') // falls through to normal default pipeline (prompt)
  })
  it('allows Read in plan mode', async () => {
    const decision = await callBroker({ toolName: 'Read', sessionMode: 'plan', ctxMode: 'plan' })
    expect(decision.behavior).not.toBe('deny')
  })
  it('denies mutating Bash in plan mode', async () => {
    const decision = await callBroker({ toolName: 'Bash', input: { command: 'rm -rf x' }, sessionMode: 'plan', ctxMode: 'plan' })
    expect(decision.behavior).toBe('deny')
  })
  it('plan gate precedes acceptEdits auto-allow', async () => {
    // live plan, snapshot acceptEdits: Edit must still deny
    const decision = await callBroker({ toolName: 'Edit', sessionMode: 'plan', ctxMode: 'acceptEdits' })
    expect(decision.behavior).toBe('deny')
  })
})
```

`callBroker` is a test helper wrapping the existing harness: build a session with `permissionMode = sessionMode`, invoke `canUseTool(toolName, input, { permissionMode: ctxMode, ... })`. Adapt to the harness's actual construction (read the existing tests first).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/permission-broker.test.ts -t "plan-mode enforcement"`
Expected: FAIL — Edit allowed (no plan branch yet).

- [ ] **Step 3: Implement the plan gate**

Insert immediately after the `ExitPlanMode` branch (so it precedes `acceptEdits` at ~347 and `bypassPermissions` at ~397). Read `session.permissionMode`. Deny the mutating name set `{Edit, Write, NotebookEdit}` outright; for `Bash`, deny unless the command is provably read-only (reuse the broker's existing read-only bash classification; fail closed). Read-only tools return nothing (fall through). Do not change the snapshot `mode` used by other branches.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/permission-broker.test.ts`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add server/permission-broker.ts server/permission-broker.test.ts
git commit -m "feat(broker): plan-mode hard enforcement reading live session mode"
```

---

### Task 3: Host mode-change callback + manager wiring

**Files:**
- Modify: `server/providers/types.ts` (`CreateSessionOptions`)
- Modify: `server/providers/native/native-provider.ts` (thread the callback into the session)
- Modify: `server/providers/native-host-frame-adapter.ts` (bind the callback)
- Modify: `server/session-manager.ts` (pass the bound callback at native spawn)
- Test: `server/providers/native/native-session.test.ts`

**Interfaces:**
- Consumes: `SessionManager.setPermissionMode(id, mode)` (updates manager `s.permissionMode` + chip + forwards to the native handle).
- Produces: `CreateSessionOptions.requestPermissionModeChange?: (mode: string) => Promise<void>`. The manager binds `(mode) => this.setPermissionMode(id, mode)` for native sessions; the native session exposes it to the `EnterPlanMode` tool deps. Calling it updates the manager live field (so the Task 2 gate sees it) AND the native handle mode (persistence + guidance).

- [ ] **Step 1: Write the failing test**

```ts
it('EnterPlanMode tool callback routes through requestPermissionModeChange', async () => {
  const requestPermissionModeChange = vi.fn(async () => {})
  const session = createNativeSession({ /* existing harness opts */, requestPermissionModeChange })
  // drive the EnterPlanMode tool body
  await session.runToolForTest('EnterPlanMode', {})
  expect(requestPermissionModeChange).toHaveBeenCalledWith('plan')
})
```

Use the existing native-session test harness's tool-invocation path (read how `e2e-tools.test.ts` drives a tool). If no direct tool-run helper exists, assert via the deps callback the session wires (Step 3 exposes it).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/providers/native/native-session.test.ts -t "EnterPlanMode tool callback"`
Expected: FAIL — callback not wired / tool absent.

- [ ] **Step 3: Implement the callback seam**

Add `requestPermissionModeChange?` to `CreateSessionOptions`. Thread it through `NativeProvider.createSession` → `NativeSession` opts. The manager's native spawn funnel passes `(mode) => this.setPermissionMode(id, mode)`. (Tool registration itself is Task 4; this task only establishes the callback reaching the session and a test-visible hook.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/providers/native/native-session.test.ts -t "EnterPlanMode tool callback"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/types.ts server/providers/native/native-provider.ts server/providers/native-host-frame-adapter.ts server/session-manager.ts server/providers/native/native-session.test.ts
git commit -m "feat(native): host-bound permission-mode change callback for tool-driven entry"
```

---

### Task 4: Native registration + EnterPlanMode ownership + per-round guidance

**Files:**
- Modify: `server/providers/native/native-session.ts` (tool registration ~`rebuildTools`/`nestedTools`; `stream` wrapper ~1719; `EnterPlanMode` deps)
- Test: `server/providers/native/e2e-plan-mode.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 `createEnterPlanModeTool`/`createExitPlanModeTool`/`PLAN_MODE_GUIDANCE`; Task 3 `opts.requestPermissionModeChange`.
- Produces: plan tools present in the native tool surface; `EnterPlanMode` deps bound to `() => opts.requestPermissionModeChange?.('plan')`; the `stream` wrapper appends `PLAN_MODE_GUIDANCE` to `req.system` per round iff live `this.permissionMode === 'plan'` (guidance is NOT baked into `turnSystem`).

- [ ] **Step 1: Write the failing tests**

```ts
// e2e-plan-mode.test.ts — use the existing native e2e harness (scripted provider)
it('registers EnterPlanMode and ExitPlanMode in the tool surface', async () => {
  const { session } = await startNativeSession()
  expect(toolNames(session)).toContain('EnterPlanMode')
  expect(toolNames(session)).toContain('ExitPlanMode')
})
it('appends plan guidance to the request system only while live mode is plan', async () => {
  const { session, requests } = await startNativeSession()
  await sendTurn(session, 'hi') // default mode
  expect(requests.at(-1).system).not.toContain(PLAN_MODE_GUIDANCE)
  await session.setPermissionMode('plan')
  await sendTurn(session, 'hi again')
  expect(requests.at(-1).system).toContain(PLAN_MODE_GUIDANCE)
})
it('EnterPlanMode engages plan mode via the host callback', async () => {
  const { session, modeChanges } = await startNativeSessionWithCallback()
  await driveTool(session, 'EnterPlanMode', {})
  expect(modeChanges).toContain('plan')
})
```

Adapt helpers to the existing e2e harness (`e2e-tools.test.ts`, `e2e-skills.test.ts` show the scripted-provider pattern).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/e2e-plan-mode.test.ts`
Expected: FAIL — tools absent / guidance not appended.

- [ ] **Step 3: Implement registration + guidance + ownership**

Register both plan tools alongside the other builtins (include them in `rebuildTools` output and `nestedTools` so subagents inherit plan enforcement). Bind `createEnterPlanModeTool({ enterPlanMode: () => this.opts.requestPermissionModeChange?.('plan') ?? Promise.resolve() })`. In the `stream` wrapper (~1719), compute `system = this.permissionMode === 'plan' ? `${req.system}\n\n${PLAN_MODE_GUIDANCE}` : req.system` and pass it to `streamFor`. Do not add plan guidance to `turnSystem`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/providers/native/e2e-plan-mode.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/native-session.ts server/providers/native/e2e-plan-mode.test.ts
git commit -m "feat(native): register plan tools, tool-driven entry, per-round plan guidance"
```

---

### Task 5: Plan-mode persistence + resume restore

**Files:**
- Modify: `server/providers/native/native-session.ts` (`setPermissionMode` ~2140 rides `updateAgentBase`; resume rebuild)
- Test: `server/providers/native/e2e-plan-mode.test.ts`

**Interfaces:**
- Consumes: `updateAgentBase({ permissionMode })` (~772) appending a `session/agent` base event; the resume rebuild that folds base events into `basePermissionMode`/`permissionMode`.
- Produces: a mode switch to/from `plan` persists via the existing base-event mechanism; a resumed session whose last base mode is `plan` starts with `permissionMode === 'plan'` and active guidance.

- [ ] **Step 1: Write the failing test**

```ts
it('persists plan mode and restores it on resume', async () => {
  const { session, log } = await startNativeSession()
  await session.setPermissionMode('plan')
  await session.flush()
  const resumed = await resumeNativeSession(log)
  expect(resumed.permissionModeForTest).toBe('plan')
})
```

Use the harness's resume path (see `native-session.test.ts` resume tests). If `setPermissionMode('plan')` already rides `updateAgentBase`, this test may pass immediately — then add the assertion that guidance is active on the resumed first turn.

- [ ] **Step 2: Run test to verify it fails (or confirms current behavior)**

Run: `npx vitest run server/providers/native/e2e-plan-mode.test.ts -t "persists plan mode"`
Expected: FAIL if plan mode is not persisted; if it passes, verify the resume guidance assertion still fails.

- [ ] **Step 3: Implement persistence/restore**

Ensure `setPermissionMode` persists the mode through `updateAgentBase({ permissionMode: mode })` (the existing path at ~2140) so `plan` is recorded like any mode. Verify the resume rebuild reads it back into `basePermissionMode` and the live `permissionMode`. No new event type — plan rides the existing base event (per spec).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/providers/native/e2e-plan-mode.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/native-session.ts server/providers/native/e2e-plan-mode.test.ts
git commit -m "feat(native): persist and restore plan mode across resume"
```

---

### Task 6: End-to-end approve→execute same turn + entry paths

**Files:**
- Modify: `server/session-manager.ts` (only if the plan-approval path needs a native-specific adjustment; the existing `decide`→`setPermissionMode` at ~8183 should already work)
- Test: `server/providers/native/e2e-plan-mode.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5; the manager `decide` plan-approval path (`isPlanApproval` → `setPermissionMode(sid, planTargetMode)`).
- Produces: a full native plan flow test proving the Review Focus behaviors end-to-end.

- [ ] **Step 1: Write the failing tests**

```ts
it('approving ExitPlanMode lets the next Edit run in the SAME turn', async () => {
  const { session, requests } = await startNativeSession({ permissionMode: 'plan' })
  // scripted model: ExitPlanMode call, then (after approval) an Edit call
  const turn = sendTurn(session, 'make a plan then edit')
  await approvePendingPlan(session, { planTargetMode: 'acceptEdits' })
  await turn
  expect(editAllowedInSameTurn(requests)).toBe(true) // Edit not denied by plan gate post-approval
})
it('model EnterPlanMode mid-turn denies a following Edit', async () => {
  const { session } = await startNativeSession({ permissionMode: 'default' })
  // scripted model: EnterPlanMode, then Edit
  const result = await sendTurn(session, 'enter plan then edit')
  expect(editDeniedAfterEntry(result)).toBe(true)
})
it('user mode-chip entry to plan denies Edit', async () => {
  const { session } = await startNativeSession()
  await session.setPermissionMode('plan') // chip path
  const result = await sendTurn(session, 'edit something')
  expect(editDenied(result)).toBe(true)
})
```

Use the scripted-provider harness to emit tool calls and auto/approve pendings. Read `e2e-tools.test.ts` for the permission-approval driving pattern.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/providers/native/e2e-plan-mode.test.ts -t "SAME turn"`
Expected: FAIL if the mid-turn refresh is incomplete (Edit denied post-approval).

- [ ] **Step 3: Fix any mid-turn gap**

If the same-turn Edit is denied, confirm the Task 2 gate reads live `session.permissionMode` and that `decide`→`setPermissionMode` updates it before the next tool call. Confirm the Task 4 guidance refresh removes plan guidance post-approval. Adjust only the seam, not the turn snapshot for non-plan fields.

- [ ] **Step 4: Run the full native + broker suites**

Run: `npx vitest run server/providers/native/e2e-plan-mode.test.ts server/permission-broker.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint + neutrality pins**

Run: `npm run typecheck && npm run lint && npx vitest run server/providers/native/vocabulary/neutrality.test.ts server/providers/native/host-free.test.ts`
Expected: PASS (no neutrality regressions).

- [ ] **Step 6: Commit**

```bash
git add server/providers/native/e2e-plan-mode.test.ts server/session-manager.ts
git commit -m "test(native): end-to-end plan mode approve→execute same turn and entry paths"
```

---

## Self-Review

**Spec coverage:** G1 tools (Task 1), broker hard enforcement reading live mode (Task 2), EnterPlanMode ownership via host callback (Tasks 3–4), per-round guidance refresh (Task 4), persistence/resume (Task 5), mid-turn approve→execute + entry paths (Task 6), plan card zero change (Global Constraints + no PlanCard task). `allowedPrompts` absent — no task needed (card hides the row). All G1 spec bullets map to a task.

**Review Focus coverage:** same-turn approve→execute (Task 6), model entry mid-turn (Tasks 2, 6), read-only tools pass (Task 2), gate precedence (Task 2), resume restore (Task 5), invalid plan rejected (Task 1). Each has a test.

**Type consistency:** `EnterPlanModeDeps.enterPlanMode`, `createEnterPlanModeTool`, `createExitPlanModeTool`, `PLAN_MODE_GUIDANCE`, `requestPermissionModeChange` used consistently across Tasks 1/3/4. Broker gate reads `session.permissionMode` consistently (Tasks 2/6).

**Proportion:** code blocks are test assertions and signatures only; bodies left to the implementer. No transcript.