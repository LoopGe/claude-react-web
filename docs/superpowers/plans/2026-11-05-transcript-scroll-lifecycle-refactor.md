# Transcript Scroll Lifecycle Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the transcript's competing scroll writers and implicit lifecycles with one pure lifecycle reducer, one DOM write gateway, and one epoch-aware correction scheduler.

**Architecture:** A pure reducer maps lifecycle events to commands; an imperative writer executes them without making policy decisions. React and App only produce events, while a dedicated fold session owns fold mathematics and emits alignment requests.

**Tech Stack:** TypeScript, React 19, react-virtuoso, Vitest, Testing Library, Playwright, Chrome Trace Event Format.

**Spec:** `docs/superpowers/specs/2026-11-05-transcript-scroll-lifecycle-design.md`

## Global Constraints

- Do not replace Virtuoso or change fold/seek easing and device-pixel mathematics.
- Cover the main Virtuoso transcript and App restoration only; SideChatDrawer and StreamingFooter are excluded.
- By the end of Task 4, every scroll write, rAF, timeout, and Virtuoso fallback must pass through the writer gateway.
- Do not issue uncancellable Virtuoso smooth fallbacks; missing-element work waits for attachment.
- No reason-string delivery, callback-inversion arming, observer-local pending state, or new one-off guards.
- Do not create a commit unless the user explicitly asks for it.

## Review Focus

- Epoch change, element replacement, hide, and unmount must invalidate every asynchronous token; pinned by reducer tests in Task 1 and writer tests in Task 2.
- Restoration to an arbitrary remembered target must be preempted by leave/fold/newer ownership without changing follow intent or seek state; pinned by Task 4 tests.
- Overlapping fold/follow plus margin, padding, or sub-pixel non-fold growth must not create competing writes or dropped residuals; pinned by Task 5 tests.
- Missing scroller and detached-element callbacks must not produce a Virtuoso smooth write or any late write; pinned by Tasks 2 and 4 tests.
- Pending work with no subsequent ResizeObserver must still reach a named terminal state; pinned by Task 5 scheduler tests.

---

### Task 1: Pure lifecycle reducer and transition contract

**Files:**
- Create: `src/components/message-list/transcript-scroll-machine.ts`
- Create: `src/components/message-list/transcript-scroll-machine.test.ts`

**Interfaces:**
- Produces `Attachment`, `Intent`, `Owner`, `WorkRequest`, `ScrollState`, `ScrollEvent`, `ScrollCommand`.
- Produces `createInitialScrollState(epoch = 0): ScrollState` and `reduceScroll(state: ScrollState, event: ScrollEvent): { state: ScrollState; commands: ScrollCommand[] }`.
- Uses the exact state/event/command vocabulary from the spec, including `Owner.kind = 'restore'` and `WorkRequest.delivery = 'next-observation' | 'after-owner'`.

- [ ] **Step 1: Write failing table-driven reducer tests**

Cover: follow→away preemption; true-bottom return; follow/seek/fold token replacement; restore preserving intent and seek state; work consume/cancel/retention; epoch, detach, hide, and unmount invalidating every token; no subsequent RO still allowing `after-owner` work to settle. Assert exact emitted commands and state, not DOM positions.

- [ ] **Step 2: Run the reducer tests and verify they fail**

Run: `npx vitest run src/components/message-list/transcript-scroll-machine.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure reducer**

Use immutable state transitions. The reducer performs no DOM reads, timers, rAF, or React calls. Every transition returns the next state and explicit commands; stale tokens cannot produce commands.

- [ ] **Step 4: Run the reducer tests**

Run: `npx vitest run src/components/message-list/transcript-scroll-machine.test.ts`
Expected: PASS for all transition and pending-terminal cases.

### Task 2: DOM writer and epoch-aware scheduler

**Files:**
- Create: `src/components/message-list/transcript-scroll-writer.ts`
- Create: `src/components/message-list/transcript-scroll-writer.test.ts`

**Interfaces:**
- Consumes `ScrollCommand` from Task 1.
- Produces `ScrollScheduler = { raf(cb): number; cancelRaf(id): void; timeout(cb, ms): number; clearTimeout(id): void }`.
- Produces `createTranscriptScrollWriter({ scheduler, virtuoso }: { scheduler: ScrollScheduler; virtuoso?: VirtuosoHandle | null }): { attach(el: HTMLElement | null): void; execute(commands: ScrollCommand[]): void; dispose(): void }`.

- [ ] **Step 1: Write failing writer tests**

Use a fake scheduler and DOM/scrollTo spies. Assert one continuous writer, stale rAF/timeout rejection, detach/dispose cleanup, absolute bottom writes, fold transform writes, missing-element deferral with no Virtuoso smooth call, and attach-time token-controlled continuation.

- [ ] **Step 2: Run the writer tests and verify they fail**

Run: `npx vitest run src/components/message-list/transcript-scroll-writer.test.ts`
Expected: FAIL because the writer does not exist.

- [ ] **Step 3: Implement the writer**

Execute commands without policy decisions or mode-specific pending state. All `scrollTop`, `scrollTo`, Virtuoso fallback, transform, timeout, and rAF writes live here. Validate command epoch/token against current attachment before every scheduled write.

- [ ] **Step 4: Run the writer tests**

Run: `npx vitest run src/components/message-list/transcript-scroll-writer.test.ts`
Expected: PASS.

### Task 3: Migrate the React adapter and every existing writer

**Files:**
- Modify: `src/components/message-list/useTranscriptScroll.ts`
- Modify: `src/components/MessageList.tsx`
- Modify: `src/App.tsx`
- Create: `src/components/message-list/useTranscriptScroll.lifecycle.test.tsx`
- Create: `src/app/scroll-restoration.test.tsx`
- Modify: `src/components/MessageList.test.tsx`

**Interfaces:**
- Consumes the reducer and writer from Tasks 1–2.
- Extends `TranscriptScrollApi` with `restoreScroll(target: number): void` for App restoration; existing methods remain unless a caller benefits from simplification.
- React effects only emit events and execute returned commands through the writer.

- [ ] **Step 1: Write failing adapter and App integration tests**

Cover pin, follow animation, seek ease/hold, hidden panel, spacer, viewport shrink, trailing correction, visible-top reporting, and App restore to an arbitrary target. Assert no non-fold direct `scrollTop`/`scrollTo` writes remain in `useTranscriptScroll.ts` or App restoration outside the writer. Preserve current MessageList integration smoke tests.

- [ ] **Step 2: Run lifecycle and integration tests and verify they fail**

Run: `npx vitest run src/components/message-list/useTranscriptScroll.lifecycle.test.tsx src/app/scroll-restoration.test.tsx src/components/MessageList.test.tsx`
Expected: FAIL because adapter events and `restoreScroll` are not implemented.

- [ ] **Step 3: Migrate all non-fold lifecycle paths**

Wire React effects and App restoration into the reducer/writer. Replace missing-element Virtuoso smooth fallbacks with attachment-deferred writer commands. Publish `following`, seek state, and restoration events from lifecycle state.

- [ ] **Step 4: Run lifecycle and integration tests**

Run: `npx vitest run src/components/message-list/useTranscriptScroll.lifecycle.test.tsx src/app/scroll-restoration.test.tsx src/components/MessageList.test.tsx`
Expected: PASS for all non-fold paths and App restoration.

### Task 4: Fold session with unified correction scheduling

**Files:**
- Create: `src/components/message-list/fold-scroll-session.ts`
- Create: `src/components/message-list/fold-scroll-session.test.ts`
- Modify: `src/components/message-list/useTranscriptScroll.ts`
- Modify: `src/components/MessageList.test.tsx`

**Interfaces:**
- Produces `createFoldScrollSession(start: { token: number; from: number; to: number }): FoldScrollSession`.
- `FoldScrollSession.sample(frame: FoldFrame): { kind: 'delta'; delta: number; ledger: number; transform: number } | { kind: 'absolute-bottom'; reason: 'new-body' | 'other-growth' | 'pending' }`.
- `FoldFrame` carries `bodyHeights`, `itemListDelta`, `contentDelta`, `paddingDelta`, `itemListHeight`, `contentHeight`, `scrollTop`, `scrollHeight`, `clientHeight`, and `devicePixelRatio`; all are measurements only, not writer state.
- Consumes reducer ownership/work commands; does not call `pinToBottom`, schedule timers, or cancel other owners.

- [ ] **Step 1: Write failing fold session and scheduler tests**

Cover consecutive folds, overlapping fold with follow animation, new body joining, margin/padding/non-fold growth, sub-pixel accumulation, no-RO settlement, transform cleanup, next-observation delivery, after-owner delivery, and verify retention after absolute alignment. Reuse one geometry harness instead of adding scenario-specific branches.

- [ ] **Step 2: Run fold session and MessageList fold tests and verify they fail**

Run: `npx vitest run src/components/message-list/fold-scroll-session.test.ts src/components/MessageList.test.tsx`
Expected: FAIL because no session object exists.

- [ ] **Step 3: Move fold mathematics and work scheduling**

Move body snapshots, item/content deltas, fractional ledger, and transform into the session. Replace `pendingFoldPinRef`, `armFoldSettleRef`, reason-string delivery, and observer-local pending state with reducer work items and writer scheduling. Existing device-pixel formulas move unchanged.

- [ ] **Step 4: Run fold session and MessageList fold tests**

Run: `npx vitest run src/components/message-list/fold-scroll-session.test.ts src/components/MessageList.test.tsx`
Expected: PASS, including all central arbitration cases.

### Task 5: Delete obsolete state and simplify lifecycle producers

**Files:**
- Modify: `src/components/message-list/useTranscriptScroll.ts`
- Modify: `src/components/MessageList.test.tsx`
- Modify: `src/app/scroll-restoration.test.tsx`
- Modify: `src/App.tsx`
- Modify: `CLAUDE.md` only if the final architecture requires a short ownership note

**Interfaces:**
- Uses the completed reducer, writer, and fold session from Tasks 1–4.

- [ ] **Step 1: Add source-level ownership and lifecycle tests**

Assert the adapter contains no direct scroll writes, reason-string delivery, `pendingFoldPinRef`, `armFoldSettleRef`, or independent fold release polling. Verify every pending request has consume/cancel/retention coverage and App has no independent restoration writer.

- [ ] **Step 2: Run ownership tests and full client integration tests**

Run: `npx vitest run src/components/message-list/useTranscriptScroll.lifecycle.test.tsx src/app/scroll-restoration.test.tsx src/components/MessageList.test.tsx`
Expected: FAIL if obsolete parallel state remains.

- [ ] **Step 3: Remove duplicate state, mode strings, guards, and harnesses**

Keep only reducer events and writer commands in the React adapter. Consolidate repeated visibility/geometry guards into named lifecycle events and trim duplicated test setup rather than adding scenario-specific branches.

- [ ] **Step 4: Run client integration tests**

Run: `npx vitest run src/components/message-list/useTranscriptScroll.lifecycle.test.tsx src/app/scroll-restoration.test.tsx src/components/MessageList.test.tsx`
Expected: PASS.

### Task 6: Whole-system verification and review

**Files:**
- Review all files above and the real browser trace; no scope expansion.

- [ ] **Step 1: Run focused and complete automated checks**

Run: `npx vitest run src/components/message-list/transcript-scroll-machine.test.ts src/components/message-list/transcript-scroll-writer.test.ts src/components/message-list/fold-scroll-session.test.ts src/components/message-list/useTranscriptScroll.lifecycle.test.tsx src/components/MessageList.test.tsx`
Then: `npm run test && npm run typecheck && npm run lint`
Expected: all PASS; report any unrelated pre-existing failure by name rather than hiding it.

- [ ] **Step 2: Record and inspect real lifecycle traces**

With all trace groups enabled, capture consecutive expand/collapse, overlapping fold/follow, append/spacer during fold, seek during fold, and App re-show. Assert zero residual oscillation, no competing writers, no stale pending work after settlement, and correct arbitrary-target restoration.

- [ ] **Step 3: Review the complete diff**

Run the `code-review` skill on `git diff HEAD`, verify findings, rerun non-trivial fixes through RED→GREEN tests, and confirm the acceptance criteria in the spec. Do not commit unless explicitly requested.
