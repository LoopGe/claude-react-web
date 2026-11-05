# Configurable Trace Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in, configurable fold/scroll/visual diagnostics to manual trace Record without changing transcript behaviour.

**Architecture:** A recording-scoped diagnostic module owns fold correlation, visual probes, and a bounded plain-event ring. Existing `scrollDebug` and `AnimatedCollapse` only call no-op-when-inactive recorder hooks; `jank-monitor` serializes selected streams, while `DevTraceButton` owns the persisted right-click configuration menu.

**Tech Stack:** React 19, TypeScript, browser PerformanceObserver/ResizeObserver APIs, Vitest, Testing Library, Chrome Trace Event Format.

**Spec:** `docs/superpowers/specs/2026-11-05-configurable-trace-recording-design.md`

## Global Constraints

- Do not alter fold timing, scroll compensation, Virtuoso options, or transcript layout logic.
- Geometry probes run only between manual Record start and stop.
- Capture semantics remain unchanged and Capture exports no recorded diagnostic ring.
- All four record groups default to true and persist under `crw:dev-trace-record-options:v1`.
- Do not create a commit unless the user explicitly requests it.

## Review Focus

- Inactive recorder: diagnostic calls return without DOM geometry reads or ring growth; pinned by recorder and AnimatedCollapse tests in Tasks 1 and 3.
- Capture after a manual Record: stale diagnostic events cannot leak into Capture; pinned by an export test in Task 2.
- Visual-only recording: fold correlation still works without emitting fold/scroll geometry events; pinned by a recorder test in Task 1.
- Repeated folds and cleanup: fold ids remain unique and cancelled animations emit a terminal diagnostic; pinned by AnimatedCollapse tests in Task 3.
- Recording configuration: right-click cannot change options mid-record and left-click remains start/stop; pinned by component tests in Task 5.

---

### Task 1: Recording-scoped diagnostic recorder

**Files:**
- Create: `src/client-debug/trace-diagnostics.ts`
- Create: `src/client-debug/trace-diagnostics.test.ts`

**Interfaces:**
- Produces: `TraceRecordOptions = { performance: boolean; reactInput: boolean; foldScroll: boolean; visual: boolean }` and `DEFAULT_TRACE_RECORD_OPTIONS`.
- Produces: `TraceDiagnosticEvent = { kind: 'diagnostic'; t: number; track: 'fold' | 'scroll' | 'visual' | 'layout'; name: string; args: Record<string, unknown> }`.
- Produces: `startTraceDiagnostics(options)`, `stopTraceDiagnostics()`, `traceDiagnosticsSnapshot(): { events: TraceDiagnosticEvent[]; capDroppedAtTime: number }`, `resetTraceDiagnosticsForTests()`.
- Produces: `traceFoldScrollActive()`, `traceVisualActive()`, `traceFoldStart(body, details)`, `traceFoldFrame(body, details)`, `traceFoldEnd(body, phase, details)`, `traceFoldIdFor(body)`, `recordScrollDiagnostic(name, args)`.
- Consumes: no existing modules; fold ids, next-row anchor discovery, and the recording-scoped layout-shift observer are owned here.

- [ ] **Step 1: Write failing recorder tests**

Cover: no events/no rect reads while inactive; foldScroll emits start/frame/end with a shared `fold-1`; visual-only emits anchors but no fold events; next-row `data-crw-row-id` and top/delta serialization; scroll events are gated; stop disconnects the layout-shift observer; layout shifts retain `hadRecentInput`, row id, and both rects.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src/client-debug/trace-diagnostics.test.ts`
Expected: FAIL because `trace-diagnostics.ts` does not exist.

- [ ] **Step 3: Implement the recorder**

Use one bounded `EventRing`-style array (20,000 events, FIFO), explicit active options, a WeakMap body→fold id, and per-fold anchor baselines. Start clears old diagnostic events and installs a layout-shift observer only for visual recording; stop disconnects probes but preserves events for export. Geometry helpers check the relevant active flag before reading DOM geometry.

- [ ] **Step 4: Run the recorder tests**

Run: `npx vitest run src/client-debug/trace-diagnostics.test.ts`
Expected: PASS.

### Task 2: Trace export selection and diagnostic tracks

**Files:**
- Modify: `src/client-debug/jank-monitor.ts`
- Modify: `src/client-debug/jank-monitor.trace.test.ts`
- Modify: `src/client-debug/jank-monitor.test.ts` if its reset helpers require the new ring

**Interfaces:**
- Consumes: `TraceRecordOptions`, `TraceDiagnosticEvent`, `traceDiagnosticsSnapshot()`, and `resetTraceDiagnosticsForTests()` from Task 1.
- Produces: `exportTrace({ windowMs, now?, recordOptions? })`; omitted `recordOptions` means legacy Capture.
- Produces: `TraceBuildInput.diagnostics` and `TraceFile.crwRaw.recordOptions: TraceRecordOptions | null`.
- Adds trace tracks: fold=8, scroll=9, visual=10, layout=11; diagnostic source stream name is `diagnostics`.

- [ ] **Step 1: Write failing export tests**

Assert selected diagnostic events become instant events on the correct tracks with args intact; Record filters Performance and React/input streams at export; Capture exports the legacy base streams but no diagnostics; `recordOptions` round-trips; diagnostic ring eviction is reported as `diagnostics` truncation.

- [ ] **Step 2: Run the trace tests and verify they fail**

Run: `npx vitest run src/client-debug/jank-monitor.trace.test.ts src/client-debug/jank-monitor.test.ts`
Expected: FAIL on missing diagnostics and `recordOptions`.

- [ ] **Step 3: Extend the builder and exporter**

Keep existing base collectors untouched. `buildTrace` filters time windows as before, serializes supplied diagnostic events, and defaults new input to empty arrays. `exportTrace` applies `recordOptions` only to a manual Record snapshot, reads the diagnostic ring only for foldScroll/visual Record selections, and includes the selection in raw metadata.

- [ ] **Step 4: Run the trace tests**

Run: `npx vitest run src/client-debug/jank-monitor.trace.test.ts src/client-debug/jank-monitor.test.ts`
Expected: PASS.

### Task 3: Fold and scroll instrumentation without behaviour changes

**Files:**
- Modify: `src/components/AnimatedCollapse.tsx`
- Modify: `src/components/AnimatedCollapse.test.tsx`
- Modify: `src/components/message-list/scroll-debug.ts`
- Create: `src/components/message-list/scroll-debug.test.ts`
- Modify: `src/components/message-list/useTranscriptScroll.ts`
- Modify: `src/components/MessageList.test.tsx` only where debug-payload assertions are needed

**Interfaces:**
- Consumes: all recorder hooks from Task 1.
- `traceFoldStart/Frame` details include `open`, `kind`, `from`, `to`, `writtenHeight`; the recorder derives body used/content heights and row/anchor identity.
- `traceFoldEnd` uses phase `settled` or `cancelled`.
- `recordScrollDiagnostic` receives the existing debug event name and plain payload.

- [ ] **Step 1: Write failing instrumentation tests**

Extend AnimatedCollapse tests to start foldScroll recording and assert open/close start-frame-settled sequences and cleanup cancellation; assert inactive folds emit nothing. Add scroll-debug tests proving Record forwards payloads without `crw:debug:scroll`, while console/`__scrollLogV2` still require the existing flag.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src/components/AnimatedCollapse.test.tsx src/components/message-list/scroll-debug.test.ts`
Expected: FAIL because no diagnostic events are emitted.

- [ ] **Step 3: Add gated hooks and enrich payloads**

Call recorder hooks around existing `animateHeight` writes and cleanup without reordering any write or changing any value. `scrollDebug` builds the payload when either its console flag or foldScroll Record is active. Enrich fold-lockstep with `firstFrame`, `deltaSource`, previous/current itemList height, inline `paddingTop`, body heights/ids, content/scroll bounds, and transform; enrich pin/follow debug with writer and before/after scroll geometry.

- [ ] **Step 4: Run fold and transcript tests**

Run: `npx vitest run src/components/AnimatedCollapse.test.tsx src/components/message-list/scroll-debug.test.ts src/components/MessageList.test.tsx`
Expected: PASS with no changes to height or scroll assertions.

### Task 4: Manual Record lifecycle and right-click configuration menu

**Files:**
- Modify: `src/components/DevTraceButton.tsx`
- Create: `src/components/DevTraceButton.test.tsx`
- Modify: `src/styles/layout.css`

**Interfaces:**
- Consumes: `startTraceDiagnostics`, `stopTraceDiagnostics`, `DEFAULT_TRACE_RECORD_OPTIONS`, `TraceRecordOptions`, and `markJank`.
- Uses `useLocalStorage<TraceRecordOptions>('crw:dev-trace-record-options:v1', DEFAULT_TRACE_RECORD_OPTIONS, { validate })`.
- Record export passes the frozen selection to `exportTrace`; Capture passes none.

- [ ] **Step 1: Write failing component tests**

Assert left-click starts/stops; right-click opens four checked options without starting a Record; toggles persist; outside click/Escape closes; options cannot open/change while recording; Record starts/stops diagnostics with the frozen options and adds marks; Capture never starts diagnostics and exports with no record selection.

- [ ] **Step 2: Run the component test and verify it fails**

Run: `npx vitest run src/components/DevTraceButton.test.tsx`
Expected: FAIL on missing menu and recorder lifecycle.

- [ ] **Step 3: Implement menu and lifecycle**

Add `onContextMenu` to the Record button, a native-checkbox menu, outside/Escape dismissal, and recording-time locking. Start diagnostics only for foldScroll/visual selections, stop them before export/unmount, and preserve the existing auto-stop and Capture timers. Add scoped menu styles using existing theme variables in the existing stylesheet (no new palette).

- [ ] **Step 4: Run the component test**

Run: `npx vitest run src/components/DevTraceButton.test.tsx`
Expected: PASS.

### Task 5: Whole-change verification and review

**Files:**
- Review all files above; no product-logic changes are permitted in this task.

**Interfaces:**
- Consumes the completed implementation and full diff.

- [ ] **Step 1: Run focused and complete tests**

Run: `npx vitest run src/client-debug/trace-diagnostics.test.ts src/client-debug/jank-monitor.trace.test.ts src/client-debug/jank-monitor.test.ts src/components/DevTraceButton.test.tsx src/components/AnimatedCollapse.test.tsx src/components/message-list/scroll-debug.test.ts src/components/MessageList.test.tsx`
Then: `npm run test`
Expected: all PASS.

- [ ] **Step 2: Run static checks**

Run: `npm run typecheck && npm run lint`
Expected: both tsconfigs and eslint PASS.

- [ ] **Step 3: Manually record and inspect one trace**

Run the dev app, right-click Record, enable all groups, expand/collapse a ToolGroupCard, stop, and verify the file contains record start/stop marks, `recordOptions`, fold ids, `firstFrame/deltaSource`, padding and scroll writer fields, visual anchors, and layout shifts. Confirm no application behaviour changed.

- [ ] **Step 4: Review the full diff**

Run the `code-review` skill on `git diff HEAD`, verify each finding, and rerun relevant checks after any non-trivial correction. Do not commit unless explicitly requested.
