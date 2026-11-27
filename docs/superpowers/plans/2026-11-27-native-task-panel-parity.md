# Native Provider TasksPanel Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the native provider's TasksPanel to claude parity — foreground subagents appear as running→terminal records, and running subagents carry live progress (a fork-generated one-line summary plus `last_tool_name`).

**Architecture:** The fold pipeline (pump `applyTaskEvent` → `session.tasks` → `tasks-snapshot` → client) is already provider-agnostic and needs zero change. All work is emission-side: add a neutral `task/progress` frame + `task/started.isBackgrounded`, project them in the host adapter, emit foreground-subagent lifecycle frames from `NativeTaskManager`, and add a per-subagent progress tracker that forks the subagent conversation (reusing its model + prompt cache, the `runSuggestion` pattern) to generate the summary.

**Tech Stack:** TypeScript (Node server), vitest, the neutral native vocabulary (`server/providers/native/vocabulary/`), the host frame adapter, the Anthropic Messages stream transport.

**Spec:** `docs/superpowers/specs/2026-11-27-native-task-panel-parity-design.md`

## Global Constraints

- Neutrality: core files import ONLY neutral `vocabulary/*`, `wire/*`, sibling core, `shared/*`, Node builtins. No SDK, no `native-host-frame-adapter`, no host-domain services. The adapter is the sole SDK boundary importer. Pins: `native/vocabulary/neutrality.test.ts`, `native/host-free.test.ts`, `native/vocabulary/live-frame.test.ts`.
- Task frames are envelope-less (no `session_id`/`uuid`/`parent`); the adapter projects `receivedAt` from `time`. Live-only (R6): never persisted, never the history ring. `task_notification` keeps the ring+broadcast path (existing pump behavior); `task/progress` is ephemeral like `task_started`.
- Scope = subagents only. Foreground shells emit nothing (claude parity, user-confirmed).
- The `usage` triple is emit-only wire parity — the pump fold drops it (claude too). Do NOT extend `shared/tasks.ts`, the pump, the reducer, or the UI. Zero client change.
- Summary fork reuses the subagent's own model + prompt cache; never a separate small-model call. Fork strips effort/fastMode and uses a small `maxTokens`.
- Cadence ~30 s. `agentProgressSummaries` default on (`opts.agentProgressSummaries ?? true`), gating ONLY the summary fork; `last_tool_name` progress always on.
- CSS: no hardcoded hex (n/a here — no client change). Diagnostics through `createLogger(scope)`, never bare `console.*`.
- Metrics labels are finite enums only — no session ids / uuids.
- Never commit unreviewed code; run `code-review` on the full diff before the final commit lands.

## Review Focus

The five failure modes the spec implies that most likely bite a user, each pinned to its owning task:

1. **Mid-round fork snapshot ends in unmatched `tool_use`** → the fork tail must carry synthetic `tool_result` blocks keyed by the real ids, or the API 400s and the silent-failure contract hides it (summaries never generate). → Task 4 test.
2. **Foreground subagent backgrounded mid-flight** → exactly one `task_notification` at settle; the SubagentCard must not double-settle against the tool_result. → Task 3 + Task 6 tests.
3. **Fork in flight when the subagent aborts/settles** → abort cleanly, no late frame into a dead session, no unhandled rejection, no mutation of the live `nestedHistory`. → Task 4 test.
4. **Always-on-thinking model (Opus/Sonnet 5.5)** → fork 400s on `thinking:disabled`; must silently skip the summary but STILL emit mechanical `last_tool_name` progress. → Task 4 test.
5. **Foreground shell** → emits no task frames at all (parity); a foreground Bash settle stays silent. → Task 3 test.

## File Structure

- `server/providers/native/vocabulary/live-frame.ts` — add `task/progress` OperationalFrame member; add `isBackgrounded: boolean` to `task/started`. (Task 1)
- `server/providers/native-host-frame-adapter.ts` — project `task/progress` → SDK `task_progress`; `task/started` reads `isBackgrounded`. (Task 1)
- `server/providers/native/native-session.ts` — `isOperationalFrame` discriminant; widen `streamFor`/`defaultStream` (`appendMessages`/`maxTokens`/`forkProfile`); thread `agentProgressSummaries` opt + the tracker dep into `AgentToolDeps`. (Tasks 2, 5)
- `server/providers/native/task-manager.ts` — foreground-subagent launch + settle emission. (Task 3)
- `server/providers/native/subagent-progress.ts` (new) — the per-subagent tracker: observe / timer / fork / normalize / emit. (Task 4)
- `server/providers/native/subagent.ts` — feed the tracker from the emit interceptor; start/stop it; widen `streamFor` signature. (Task 5)
- `server/providers/native/native-provider.ts` — pass `agentProgressSummaries` into `NativeSession`. (Task 5)
- Tests alongside each; e2e in `native/e2e-subagent.test.ts`; client reducer pin in the session-store tests. (Tasks 1–6)
- Decision record: `.agents/notes/implemented/feature/2026-11-27-native-task-panel-parity.md`. (Task 6)

---

### Task 1: Neutral `task/progress` frame + `task/started.isBackgrounded` + adapter projection

**Files:**
- Modify: `server/providers/native/vocabulary/live-frame.ts:58-95` (OperationalFrame union)
- Modify: `server/providers/native-host-frame-adapter.ts:282-305` (projection switch)
- Test: `server/providers/native/vocabulary/live-frame.test.ts` (purity pin), `server/providers/native-host-frame-adapter.test.ts` (projection)

**Interfaces:**
- Produces: neutral frame `{ type: 'task/progress'; taskId: string; toolUseId: string; description: string; subagentType?: string; usage: { totalTokens: number; toolUses: number; durationMs: number }; lastToolName?: string; summary?: string; time: number }`. `task/started` gains `isBackgrounded: boolean`.
- Produces: adapter `projectNativeEventToSdk(event)` returns the SDK `task_progress` shape for `task/progress`, and `is_backgrounded: event.isBackgrounded` for `task/started`.

- [ ] **Step 1: Write the failing adapter projection test**

In `native-host-frame-adapter.test.ts`, add a test asserting `projectNativeEventToSdk` of a `task/progress` frame returns exactly:

```ts
{
  type: 'system', subtype: 'task_progress',
  task_id: 'tu1', tool_use_id: 'tu1', description: 'analyze module',
  subagent_type: 'Explore',
  usage: { total_tokens: 1200, tool_uses: 4, duration_ms: 31000 },
  last_tool_name: 'Read', summary: 'Analyzing authentication module',
  receivedAt: 1700000000000,
}
```

and a `task/started` frame with `isBackgrounded: false` projects `is_backgrounded: false` (and `true` → `true`). Omit `subagent_type` / `last_tool_name` / `summary` from the input when absent and assert they are absent from the output.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/providers/native-host-frame-adapter.test.ts -t task_progress`
Expected: FAIL (no `task/progress` case; `is_backgrounded` hardcoded `true`).

- [ ] **Step 3: Add the vocabulary members**

In `live-frame.ts`, add `isBackgrounded: boolean` to the `task/started` member. Add a new envelope-less `task/progress` member to `OperationalFrame` with the exact fields in the Interfaces block (neutral names: `totalTokens`/`toolUses`/`durationMs`, `lastToolName`, `summary`, `time`). Keep the union CLOSED (consumers `assertNever`).

- [ ] **Step 4: Project them in the adapter**

In `native-host-frame-adapter.ts` `projectNativeEventToSdk`: change the `task/started` case to `is_backgrounded: event.isBackgrounded`. Add a `task/progress` case returning the SDK shape from Step 1, mapping `usage.totalTokens → total_tokens` etc., `lastToolName → last_tool_name`, `summary`, `receivedAt: event.time`; spread `subagent_type`/`last_tool_name`/`summary` only when present (mirror the existing `task/notification` conditional-spread idiom).

- [ ] **Step 5: Extend the purity/neutrality pins**

In `live-frame.test.ts` (and `neutrality.test.ts` if it enumerates task frames), add `task/progress` to the covered discriminants so the closed-union/purity assertions include it.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run server/providers/native-host-frame-adapter.test.ts server/providers/native/vocabulary/live-frame.test.ts server/providers/native/vocabulary/neutrality.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/providers/native/vocabulary/live-frame.ts server/providers/native-host-frame-adapter.ts server/providers/native/vocabulary/live-frame.test.ts server/providers/native/vocabulary/neutrality.test.ts server/providers/native-host-frame-adapter.test.ts
git commit -m "feat(native): neutral task/progress frame + task/started.isBackgrounded + SDK projection"
```

---

### Task 2: Session emission discriminant + transport seam widening

**Files:**
- Modify: `server/providers/native/native-session.ts:1420-1478` (`defaultStream`/`streamFor`), `:1655-1663` (`isOperationalFrame`)
- Test: `server/providers/native/native-session.test.ts`

**Interfaces:**
- Consumes: `task/progress` type (Task 1).
- Produces: widened `streamFor`/`defaultStream` request type gaining `appendMessages?: unknown[]`, `maxTokens?: number`, `forkProfile?: boolean`. `defaultStream` forwards `appendMessages` to `streamAnthropicMessages`, uses `req.maxTokens ?? DEFAULT_MAX_TOKENS`, and when `req.forkProfile === true` omits effort and fastMode (passes `undefined`). The test seam (`streamSupplier`) flattens `appendMessages` into `messages`. `isOperationalFrame` returns true for `task/progress`.

- [ ] **Step 1: Write the failing seam test**

In `native-session.test.ts`, add a test using the scripted `streamSupplier` seam: call the session's nested `streamFor` (via the AgentToolDeps producer or a direct seam) with `{ model, system, tools, messages: [prefix], appendMessages: [tail], maxTokens: 64, forkProfile: true, signal }` and assert the scripted stream receives `messages === [...prefix, ...tail]` (flattened) and that the production `defaultStream` path forwards `appendMessages`, `max_tokens: 64`, and omits `output_config.effort` / `speed`. (Assert the production body via `buildRequestBody` on a captured `StreamRequest`, or a spy on `streamAnthropicMessages`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/providers/native/native-session.test.ts -t "fork seam"`
Expected: FAIL (`appendMessages`/`maxTokens`/`forkProfile` not forwarded).

- [ ] **Step 3: Widen the seam**

Add the three optional fields to the `streamFor` and `defaultStream` request types. In `defaultStream`'s `streamAnthropicMessages` call: `maxTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS`; `effort: req.forkProfile ? undefined : (opts?.effortLevel ? opts.effortLevel() : this.effortLevel)`; `fastMode: req.forkProfile ? undefined : (opts?.fastMode ?? this.fastMode)`; spread `appendMessages` when present. In `streamFor`'s test-seam branch, flatten: `testStream({ ...req, messages: [...req.messages, ...(req.appendMessages ?? [])] })`.

- [ ] **Step 4: Add the emission discriminant**

In `isOperationalFrame` (`:1658`), add `case 'task/progress':` to the operational switch so the frame rides `emitFrame`'s verbatim live push (persistFrame already no-ops on non-assistant frames, `:1698`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run server/providers/native/native-session.test.ts`
Expected: PASS (existing tests unaffected — the new fields are optional).

- [ ] **Step 6: Commit**

```bash
git add server/providers/native/native-session.ts server/providers/native/native-session.test.ts
git commit -m "feat(native): forward appendMessages/maxTokens/forkProfile through streamFor; recognize task/progress"
```

---

### Task 3: Foreground-subagent lifecycle emission in NativeTaskManager

**Files:**
- Modify: `server/providers/native/task-manager.ts:54-114` (`runForeground` + settle handler)
- Test: `server/providers/native/task-manager.test.ts`

**Interfaces:**
- Consumes: `task/started.isBackgrounded` (Task 1).
- Produces: `runForeground` emits `task/started` (`isBackgrounded: false`) at registration when `metadata.taskType === 'subagent'`; the foreground settle branch emits `task/notification` (with `result: outcome.text`, `status`) when `metadata.taskType === 'subagent'`, in addition to resolving the loop. Foreground shells emit nothing. The backgrounded settle branch is unchanged.

- [ ] **Step 1: Write the failing tests**

In `task-manager.test.ts`, capture emitted frames via the constructor's `emit` callback. Add tests:
- foreground subagent (`taskType: 'subagent'`): a `task/started` with `isBackgrounded: false` fires at start; on settle a `task/notification` fires with `status: 'completed'` and `result` equal to the outcome text; the loop resolves with the outcome.
- foreground shell (`taskType: 'shell'`): NO `task/started`, NO `task/notification`; loop resolves.
- foreground subagent backgrounded mid-flight (`background(toolUseId)` before settle): exactly ONE `task/notification` at settle (the backgrounded branch), plus the detach `task/started` (`isBackgrounded: true`); no duplicate notification.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run server/providers/native/task-manager.test.ts -t foreground`
Expected: FAIL (no foreground emission).

- [ ] **Step 3: Implement the emission**

In `runForeground`, after `this.records.set(...)`, emit `task/started` when `metadata.taskType === 'subagent'`: `{ type: 'task/started', taskId: metadata.toolUseId, toolUseId: metadata.toolUseId, taskType: 'local_agent', description: metadata.description, ...(metadata.subagentType !== undefined ? { subagentType: metadata.subagentType } : {}), isBackgrounded: false, time: record.startedAt }`. In the `settled` handler's `wasForeground` branch, after `record.resolveLoop(outcome)`, emit `task/notification` when `metadata.taskType === 'subagent'` (mirror the existing backgrounded notification shape at `:101-109`, `status: record.status`, `result: outcome.text`). Update the existing `detach` emission to include `isBackgrounded: true`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/providers/native/task-manager.test.ts`
Expected: PASS (backgrounded-path tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/providers/native/task-manager.ts server/providers/native/task-manager.test.ts
git commit -m "feat(native): emit foreground-subagent task/started + task/notification (shell stays silent)"
```

---

### Task 4: Per-subagent progress tracker (`subagent-progress.ts`)

**Files:**
- Create: `server/providers/native/subagent-progress.ts`
- Test: `server/providers/native/subagent-progress.test.ts`

**Interfaces:**
- Consumes: `task/progress` type (Task 1); widened `streamFor` (Task 2); `projectNativeHistoryToWire(history, opts, signal)` (`wire/wire-projection.ts:100`); `RequestMessage` (`vocabulary/message.ts`); `NativeProjectionOptions` (`attachment-projection.ts`); `supportsThinkingForModel` (`anthropic-stream.ts`).
- Produces: `class SubagentProgress` with `constructor(deps: SubagentProgressDeps)`, `observe(frame: NativeLoopFrame): void`, `start(): void`, `stop(): void`. `SubagentProgressDeps`: `{ taskId: string; toolUseId: string; description: string; subagentType?: string; enabled: boolean; history: () => readonly RequestMessage[]; model: string; system: string; tools: ToolDef[]; streamFor: AgentToolDeps['streamFor']; attachmentProjection: NativeProjectionOptions; emit: (frame: OperationalFrame, parentToolUseId: string | null) => void; parentToolUseId: string | null; signal: AbortSignal }`. Emits `task/progress` frames via `deps.emit`. Exports `PROGRESS_INTERVAL_MS = 30_000`, `PROGRESS_MAX_TOKENS = 64`, and a pure `normalizeProgressSummary(raw: string): string | null`.

- [ ] **Step 1: Write the failing normalize test**

```ts
// normalizeProgressSummary: trim, take the first line, cap length, reject empty.
expect(normalizeProgressSummary('  Analyzing authentication module  ')).toBe('Analyzing authentication module')
expect(normalizeProgressSummary('first line\nsecond line')).toBe('first line')
expect(normalizeProgressSummary('   ')).toBeNull()
expect(normalizeProgressSummary('')).toBeNull()
// a >100-char single line is capped to <=100 chars (no trailing partial surrogate)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/providers/native/subagent-progress.test.ts -t normalize`
Expected: FAIL (module/function not defined).

- [ ] **Step 3: Implement `normalizeProgressSummary` + the class skeleton**

Pure normalize: trim → first line (`split('\n')[0]`) → trim → cap to 100 chars on a code-point boundary → null if empty. (Thresholds are builder calls; pin 100 here.) Class stores deps, a `toolUses` counter, `lastToolName`, accumulated `totalTokens`, `startedAt`, a `materialSinceLastFork` flag, an `inFlight` AbortController | null, and a timer handle.

- [ ] **Step 4: Write the failing observe + mechanical-emission test**

With a scripted `streamFor` seam and fake timers: `observe` an assistant-frame carrying a `tool_use` block named `Read` and usage `{inputTokens: 100, outputTokens: 50}`; advance 30 s; assert a `task/progress` frame emitted with `lastToolName: 'Read'`, `usage.toolUses: 1`, `usage.totalTokens: 150`, `usage.durationMs >= 30000`, and (enabled true, scripted summary text) `summary` normalized. With `enabled: false`, assert the frame carries `lastToolName` but NO `summary` and the stream seam was never called.

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run server/providers/native/subagent-progress.test.ts -t "mechanical"`
Expected: FAIL.

- [ ] **Step 6: Implement observe + the tick**

`observe`: count `tool_use` blocks (from assistant-frame content), set `lastToolName`, accumulate `AssistantFrame.usage` tokens, set `materialSinceLastFork`. `start`: arm a `setInterval(PROGRESS_INTERVAL_MS)` (unref). Each tick: emit a mechanical `task/progress` (usage triple + lastToolName, no summary); then if `enabled && materialSinceLastFork && !inFlight && !signal.aborted`, run the fork (Step 8). Reset `materialSinceLastFork` only when a fork starts.

- [ ] **Step 7: Write the failing fork-tail validity test**

Snapshot history ending in an assistant message with an unmatched `tool_use` (id `tuX`): assert the fork request's `appendMessages` is ONE user message whose content begins with a `tool_result` block keyed `tool_use_id: 'tuX'` (placeholder content), followed by the summary prompt text. Snapshot ending in a complete `tool_result` user message: assert the tail is a plain user message (summary prompt only). Assert the fork request carries `maxTokens: PROGRESS_MAX_TOKENS`, `forkProfile: true`, and `thinking: {type:'disabled'}` only when `supportsThinkingForModel(model)`; assert `history()` is snapshotted (mutating the source array after the fork starts does not change the sent prefix).

- [ ] **Step 8: Run it to verify it fails, then implement the fork**

Run: `npx vitest run server/providers/native/subagent-progress.test.ts -t "fork tail"` → FAIL.

Implement the fork: slice `deps.history()`; `projectNativeHistoryToWire(snapshot, deps.attachmentProjection, forkSignal)`; build the tail — collect trailing unmatched `tool_use` ids (assistant message whose tool_results have not landed), synthesize `tool_result` blocks (`{ type: 'tool_result', tool_use_id, content: '(tool still running)' }`) for them, append the summary prompt text block, all in ONE user message; wire tools = `deps.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.schema }))` (identical to `loop.ts:208`); call `deps.streamFor({ model, system, tools: wireTools, messages: projectedPrefix, appendMessages: [tail], maxTokens: PROGRESS_MAX_TOKENS, forkProfile: true, signal: forkSignal, ...(supportsThinkingForModel(model) ? { thinking: { type: 'disabled' } } : {}) }, { suppressRetryFrames: true })`. Collect text by block index (the `runSuggestion` idiom, `native-session.ts:1580-1587`), normalize, and on a pass emit a `task/progress` carrying the `summary`. `inFlight` guards one-at-a-time; clear it in `finally`.

- [ ] **Step 9: Write the failing lifecycle/failure tests**

- abort: `stop()` (or `deps.signal` abort) while a fork is in flight → the fork's signal aborts, no frame emits after stop, no unhandled rejection.
- silent failure: scripted `streamFor` throws → no summary frame, no throw out of the tick; the mechanical frame still emits.
- always-on-thinking skip: `streamFor` rejects with a 400 on a classifier-matching model → mechanical `last_tool_name` frame still emits, no summary, no throw.
- no-material skip: a tick with no new material since the last fork does not call `streamFor`.

- [ ] **Step 10: Run them to verify they fail, then implement stop + failure contract**

Run: `npx vitest run server/providers/native/subagent-progress.test.ts -t "lifecycle"` → FAIL. Implement `stop()` (clear timer, abort in-flight fork) and the `runSuggestion` failure contract (abort → silent; error → `log.debug` + `metrics.count('native_task_progress_total', { outcome: 'failed' })`, never throw). Metric outcomes: `generated` (summary produced), `mechanical` (frame without summary), `suppressed` (skip), `failed`.

- [ ] **Step 11: Run the full module test to verify it passes**

Run: `npx vitest run server/providers/native/subagent-progress.test.ts`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add server/providers/native/subagent-progress.ts server/providers/native/subagent-progress.test.ts
git commit -m "feat(native): per-subagent progress tracker with cache-reusing summary fork"
```

---

### Task 5: Wire the tracker into the subagent + thread the option

**Files:**
- Modify: `server/providers/native/subagent.ts:51-54` (`streamFor` signature), `:219-242` (emit interceptor + tracker start), `:345-349` (finally → stop)
- Modify: `server/providers/native/native-session.ts` (NativeSession opts + `AgentToolDeps` producer `:755-784`)
- Modify: `server/providers/native/native-provider.ts:295-330` (pass option)
- Test: `server/providers/native/subagent.test.ts`

**Interfaces:**
- Consumes: `SubagentProgress` (Task 4); foreground emission (Task 3); widened seam (Task 2).
- Produces: `AgentToolDeps.streamFor` request type widened with `appendMessages?`/`maxTokens?`/`forkProfile?`; `AgentToolDeps` gains `agentProgressSummaries: boolean`. `NativeSession` opts gain `agentProgressSummaries?: boolean` (default true). The Agent tool constructs a `SubagentProgress` per run, feeds it from the emit interceptor, starts it before `runTurn`, stops it in `finally`.

- [ ] **Step 1: Write the failing integration test**

In `subagent.test.ts`, run a scripted foreground subagent (scripted `streamSupplier` producing an assistant tool_use round + a final text round, with fake timers advancing 30 s mid-run). Assert: a `task/progress` frame is emitted via the session emit with the subagent's `toolUseId` and a `lastToolName`; with `agentProgressSummaries: false` no summary fork runs. Assert the tracker is stopped after the run (no frames after settle).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/providers/native/subagent.test.ts -t progress`
Expected: FAIL (no tracker wired).

- [ ] **Step 3: Widen the dep + thread the option**

Widen `AgentToolDeps.streamFor`'s request type with the three optional fields (match Task 2). Add `agentProgressSummaries: boolean` to `AgentToolDeps`. In `native-session.ts`'s producer (`:761`), forward the widened req and add `agentProgressSummaries: this.opts.agentProgressSummaries ?? true`. Add `agentProgressSummaries?: boolean` to `NativeSession` opts. In `native-provider.ts` `createSession`, pass `agentProgressSummaries: opts.agentProgressSummaries ?? true` into the `NativeSession` constructor.

- [ ] **Step 4: Construct + feed + start/stop the tracker**

In `subagent.ts` `run`, after `nestedCtx`/`nestedTools`/`nestedModel`/`nestedSystem` are built, construct `new SubagentProgress({ taskId: ctx.toolUseId, toolUseId: ctx.toolUseId, description: typeof input.description === 'string' ? input.description.trim() : '', subagentType: agentType, enabled: deps.agentProgressSummaries, history: () => nestedHistory, model: nestedModel, system: nestedSystem, tools: nestedTools, streamFor: deps.streamFor, attachmentProjection: deps.attachmentProjection, emit: deps.emit, parentToolUseId: nestedCtx.parentToolUseId ?? null, signal: ctx.signal })` (`agentType` is the resolved type already computed at `:183`; read `description` from `input` here rather than the later `:245` local). In the emit interceptor (`:231`), call `progress.observe(frame)` before `deps.emit`. Call `progress.start()` before `runTurn`; call `progress.stop()` in the `finally` (`:345`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run server/providers/native/subagent.test.ts server/providers/native/native-session.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/providers/native/subagent.ts server/providers/native/native-session.ts server/providers/native/native-provider.ts server/providers/native/subagent.test.ts
git commit -m "feat(native): wire subagent progress tracker + thread agentProgressSummaries option"
```

---

### Task 6: E2E parity, client reducer pin, decision record

**Files:**
- Modify: `server/providers/native/e2e-subagent.test.ts`
- Test: client session-store reducer test (the `TASKS_SNAPSHOT` / async-subagent completion suite)
- Create: `.agents/notes/implemented/feature/2026-11-27-native-task-panel-parity.md`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: an e2e assertion that a foreground native subagent folds into a running `session.tasks` record that settles to terminal with its result; a client reducer pin that a native foreground record (`isBackgrounded: false`) + its `task_notification` coexist with the tool_result without double-settling.

- [ ] **Step 1: Write the failing e2e test**

In `e2e-subagent.test.ts`, drive a foreground subagent through the real pump fold (`applyTaskEvent` on the projected SDK frames). Assert: after launch, `session.tasks` holds a record keyed by the toolUseId with `status: 'running'`, `isBackgrounded: false`, `taskType: 'subagent'`; mid-run a `task_progress` folds `progressSummary` / `lastToolName`; after settle the record is terminal (`completed`) with `result` equal to the report. Assert a foreground shell produces NO record.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/providers/native/e2e-subagent.test.ts -t "foreground panel"`
Expected: FAIL.

- [ ] **Step 3: Make the e2e pass (fix any wiring gap it exposes)**

The emission pipeline from Tasks 1–5 should satisfy this; if a gap surfaces (e.g. frame ordering, `runId`), fix it at the owning layer and re-run. Do not add client code.

- [ ] **Step 4: Write the client reducer pin**

In the session-store reducer test suite, add a test: dispatch a `TASKS_SNAPSHOT` carrying a native foreground subagent record (`isBackgrounded: false`, running) then its terminal `task_notification`-folded record, alongside the subagent's tool_result; assert the `activeSubagents` entry settles exactly once (no duplicate terminal card, `isAsync` stays false). This pins the zero-client-change claim against the foreground notification + tool_result coexistence.

- [ ] **Step 5: Run the reducer test + full typecheck + lint**

Run: `npx vitest run src/session-store` then `npm run typecheck` then `npm run lint`
Expected: PASS (both tsconfigs; no lint errors).

- [ ] **Step 6: Write the decision record**

Create `.agents/notes/implemented/feature/2026-11-27-native-task-panel-parity.md` per `.agents/notes/README.md`: the why (parity), the fork strategy and why not a small model, the emit-only usage decision, the fork-tail synthetic-tool_result validity rule, the inherited always-on-thinking 400 limitation, and what was knowingly left out (usage surfacing, foreground shells, task_updated).

- [ ] **Step 7: Run the agent-notes gate + the native suite**

Run: `npm run verify:agent-notes` then `npx vitest run server/providers/native`
Expected: PASS.

- [ ] **Step 8: Code review the full diff, fix confirmed findings, then commit**

Run the `code-review` skill on `git diff HEAD` (the whole feature). Verify each finding against the code; fix confirmed issues; re-review non-trivial fixes. Then:

```bash
git add server/providers/native/e2e-subagent.test.ts src/session-store .agents/notes/implemented/feature/2026-11-27-native-task-panel-parity.md
git commit -m "test(native): TasksPanel foreground parity e2e + reducer pin; decision record"
```