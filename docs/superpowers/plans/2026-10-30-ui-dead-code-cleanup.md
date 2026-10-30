# Remaining UI Dead Code and Stale Comments Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the remaining unused UI, exports, types, and helper functions, and update comments that still describe the deleted `useChatStream` as a current dependency or lifecycle owner.

**Architecture:** Make three independent, behavior-preserving cleanups: UI dead paths, export/type/helper dead code, then documentation-only cleanup. Keep Side Chat working indication, current settings deep links, controlled overlays, lazy named exports, and all replay/trim behavior.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, existing UI and session-store modules.

**Spec:** `docs/superpowers/specs/2026-10-30-ui-dead-code-cleanup-design.md`

## Global Constraints

- No user-visible, WS/REST, SessionSynchronizer, or reducer behavior changes.
- Preserve `sideChatWorking`, Settings sessionId/nonce deep links, hand-written Subagent/Workflow overlays and their CSS, MessageList bottom-overlay DOM, and named lazy exports.
- Update comments that describe deleted modules as current dependencies; retain meaningful historical migration notes.
- Do not add compatibility aliases or replacement stubs for deleted UI/exports/types/functions.
- Stage only exact files changed by each task; never stage unrelated working-tree or untracked files.
- Before every commit, run `code-review` on the full task diff, fix confirmed findings, and re-review non-trivial fixes.

## Review Focus

1. **Side Chat collapse after unread removal:** the working dot/label still derives from `sideChatWorking`, with no unread-number dependency — pinned in Task 1.
2. **Settings deep links after memo removal:** sessionId filtering and nonce changes still open the correct panel/tab — pinned in Task 1.
3. **Hand-written transcript overlays after variant removal:** Subagent/Workflow overlay DOM and CSS remain functional — pinned in Task 1.
4. **Lazy dialog loading after default-export removal:** named dynamic imports still resolve — pinned in Task 2.
5. **Trim/replay after helper deletion:** `isTrimBoundary` and replay behavior remain intact without `isDiskStableMsg` — pinned in Task 2.

## File Structure

- Task 1 removes UI dead paths in `App.tsx`, `ChatPanel.tsx`, `ThemeToggle.tsx`, `Overlay.tsx`, and `MessageList.tsx`.
- Task 2 removes unused exports/icons/types/helpers in `ResetConfigDialog.tsx`, `InputHistoryPanel.tsx`, `ToolIcons.tsx`, `types.ts`, and `session-store/normalize.ts`, with surface tests and trim-comment updates.
- Task 3 updates stale comments across App, hooks, session-sync, session-store, and affected components/tests.

---

### Task 1: Remove Unused UI Paths and Redundant State

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/ChatPanel.tsx`
- Modify: `src/components/Overlay.tsx`
- Modify: `src/components/Overlay.test.tsx`
- Modify: `src/components/MessageList.tsx`
- Modify: `src/components/ChatPanel.side-chat.test.tsx`
- Modify: `src/components/SettingsPanel.test.tsx`
- Delete: `src/components/ThemeToggle.tsx`

**Interfaces:**
- Removes: `initialMessageCount`, `sideChatUnread`, `stableSettingsTabRequest`, `ThemeToggle`, Overlay `subagent`/`workflow` variants, `bottomOverlayRef`.
- Preserves: `sideChatWorking`, direct `settingsTabRequest` state flow, all other Overlay variants, and the bottom-overlay DOM element.

- [ ] **Step 1: Add failing behavior and type-surface tests**

Add tests so current code fails:
- Side Chat collapse/expand still exposes the working dot/label solely from `sideChatWorking`, with no unread count or `initialMessageCount` dependency.
- Settings deep-link coverage proves a new nonce opens the requested tab and a request for another sessionId does not open the current one.
- Overlay type assertions reject `variant="subagent"` and `variant="workflow"` after implementation (`@ts-expect-error` must become used).
- Existing MessageList bottom-overlay behavior remains the control, not a test that merely checks a ref existed.

- [ ] **Step 2: Run the focused tests to verify the new assertions fail**

Run: `npm test -- src/components/ChatPanel.side-chat.test.tsx src/components/SettingsPanel.test.tsx src/components/Overlay.test.tsx src/components/MessageList.test.tsx`
Expected: FAIL on the new unread-free UI, direct settings flow, or removed-variant assertions.

- [ ] **Step 3: Delete the unused UI paths**

Remove the unread state field and all writes/props/arithmetic, the settings memo, ThemeToggle, the two variant entries, and the unread ref. Pass `settingsTabRequest` directly while retaining its outer sessionId filter. Preserve Overlay compositing rationale separately from the deleted variants note.

- [ ] **Step 4: Run affected UI suites and typecheck**

Run: `npm test -- src/components/ChatPanel.side-chat.test.tsx src/components/SettingsPanel.test.tsx src/components/Overlay.test.tsx src/components/SubagentOverlay.test.tsx src/components/WorkflowOverlay.test.tsx src/components/MessageList.test.tsx src/components/streaming-render-isolation.test.tsx`
Expected: PASS, including working-only Side Chat indication, Settings deep links, hand-written overlays, and unchanged bottom-overlay behavior.

Run: `npm run typecheck`
Expected: PASS, with the two removed variants rejected by type tests.

- [ ] **Step 5: Review and commit**

```bash
git add src/App.tsx src/components/ChatPanel.tsx src/components/Overlay.tsx src/components/Overlay.test.tsx src/components/MessageList.tsx src/components/ChatPanel.side-chat.test.tsx src/components/SettingsPanel.test.tsx src/components/ThemeToggle.tsx
git commit -m "refactor: remove unused ui paths and state" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 2: Remove Unused Exports, Icons, Types, and Helpers

**Files:**
- Modify: `src/components/ResetConfigDialog.tsx`
- Modify: `src/components/InputHistoryPanel.tsx`
- Modify: `src/components/icons/ToolIcons.tsx`
- Modify: `src/types.ts`
- Modify: `src/types.test.ts`
- Modify: `src/session-store/normalize.ts`
- Modify: `src/session-store/reducer.ts`
- Modify: `src/session-store/reducer.test.ts`
- Modify: `src/session-store/store.test.ts`
- Test: `src/components/lazy-export-surface.test.tsx`

**Interfaces:**
- Removes: two default exports, `IconLink`, `IconBug`, `IconBugOff`, `IconDollar`, `IconWrench`, `cacheDroppedMedia`, `isDiskStableMsg`.
- Preserves: all named component exports and every other icon/helper.

- [ ] **Step 1: Write failing export/type-surface tests**

Create `lazy-export-surface.test.tsx` to assert:
- `ResetConfigDialog` and `InputHistoryPanel` modules expose their named components but no default export after implementation;
- the icons module does not expose the five deleted icons after implementation;
- `normalize` does not expose `isDiskStableMsg` after implementation.

Add a compile-time `SdkMessage` object using `cacheDroppedMedia: true` behind `@ts-expect-error`; it must be rejected after deletion. Add store/reducer behavior controls proving trim and replay still work without the helper.

- [ ] **Step 2: Run the new surface tests to verify they fail**

Run: `npm test -- src/components/lazy-export-surface.test.tsx src/session-store/store.test.ts src/types.test.ts`
Expected: FAIL because default exports, dead icons/helpers, and the legacy type field still exist.

- [ ] **Step 3: Delete the unused exports, type field, and helper**

Remove only the listed exports/functions/field. Keep named component exports and all other icons. Rewrite `isTrimBoundary` documentation to stand on its current stricter predicate, and remove stale helper references in `reducer.ts` and `reducer.test.ts` without changing behavior.

- [ ] **Step 4: Run lazy, icon, type, and session-store tests**

Run: `npm test -- src/components/lazy-export-surface.test.tsx src/components/ResetConfigDialog.test.tsx src/components/icons/ToolIcons.test.tsx src/types.test.ts src/session-store/store.test.ts src/session-store/reducer.test.ts`
Expected: PASS, including named lazy imports and unchanged trim/replay behavior.

Run: `npm run typecheck`
Expected: PASS, with `cacheDroppedMedia` rejected.

- [ ] **Step 5: Review and commit**

```bash
git add src/components/ResetConfigDialog.tsx src/components/InputHistoryPanel.tsx src/components/icons/ToolIcons.tsx src/types.ts src/types.test.ts src/session-store/normalize.ts src/session-store/reducer.ts src/session-store/reducer.test.ts src/session-store/store.test.ts src/components/lazy-export-surface.test.tsx
git commit -m "refactor: remove unused exports and legacy helpers" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 3: Update Stale Current-Owner Comments and Run Full Verification

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/hooks/useWsHub.ts`
- Modify: `src/hooks/usePermissionChannel.ts`
- Modify: `src/hooks/useElicitationChannel.ts`
- Modify: `src/hooks/useUserDialogChannel.ts`
- Modify: `src/hooks/useSessionCommands.ts`
- Modify: `src/hooks/useGitStatus.ts`
- Modify: `src/hooks/useReadFile.ts`
- Modify: `src/session-sync/session-synchronizer.ts`
- Modify: `src/session-sync/useSessionSynchronizer.ts`
- Modify: `src/session-sync/useSessionStreamError.ts`
- Modify: `src/session-store/types.ts`
- Modify: `src/session-store/selectors.ts`
- Modify: `src/session-store/normalize.ts`
- Modify: `src/components/PanelSlot.tsx`
- Modify: `src/components/SessionErrorCard.tsx`
- Modify: `src/components/SessionMessageList.test.tsx`

**Interfaces:**
- Changes comments only: current owners are SessionSynchronizer, SessionCommands, and current selectors/components; no runtime interface changes.
- Preserves meaningful historical notes in `types/context-usage.ts`, SessionSynchronizer protocol tests, and migration documents.

- [ ] **Step 1: Inventory stale comments before editing**

Run:

```bash
git grep -n -E 'useChatStream|ChatStream' -- src
```

Classify matches into current-owner inaccuracies to update versus meaningful history to retain. At minimum, the file list above must no longer describe `useChatStream` as a current module, consumer, or lifecycle owner after implementation.

- [ ] **Step 2: Update only inaccurate current-owner comments**

Replace stale references with the actual current owner: SessionSynchronizer for WS/paging/lifecycle, SessionCommands for user commands, and current selectors/components for rendering. Do not rewrite historical migration rationale merely to eliminate the words `useChatStream` or `ChatStream`.

- [ ] **Step 3: Verify comment accuracy and no behavior diff**

Run the search again and inspect remaining matches: only meaningful historical notes should remain. Confirm the diff contains comments alone for this task.

Run: `npm run typecheck`
Expected: PASS.

Run: `npx eslint src --ignore-pattern 'src/Python/**'`
Expected: 0 errors.

Run: `npx vitest run src`
Expected: all client tests PASS.

Run: `npm run build`
Expected: PASS.

Run: `npm test`
Expected: full suite PASS, or only explicitly documented pre-existing server baseline failures with zero new client failures.

- [ ] **Step 4: Review and commit**

```bash
git add src/App.tsx src/hooks/useWsHub.ts src/hooks/usePermissionChannel.ts src/hooks/useElicitationChannel.ts src/hooks/useUserDialogChannel.ts src/hooks/useSessionCommands.ts src/hooks/useGitStatus.ts src/hooks/useReadFile.ts src/session-sync/session-synchronizer.ts src/session-sync/useSessionSynchronizer.ts src/session-sync/useSessionStreamError.ts src/session-store/types.ts src/session-store/selectors.ts src/session-store/normalize.ts src/components/PanelSlot.tsx src/components/SessionErrorCard.tsx src/components/SessionMessageList.test.tsx docs/superpowers/specs/2026-10-30-ui-dead-code-cleanup-design.md docs/superpowers/plans/2026-10-30-ui-dead-code-cleanup.md
git commit -m "docs: update session synchronization ownership comments" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
