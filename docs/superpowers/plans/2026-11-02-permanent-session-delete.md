# Permanent Session Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a context-menu-only permanent delete action that removes SDK/CLI transcript artifacts without changing ordinary session deletion.

**Architecture:** Extend the existing DELETE route and SessionManager with an opt-in `deleteTranscript` flag. A strict history-reader helper deletes transcript artifacts after CLI shutdown; the two context menus pass the same option through the existing client delete funnel.

**Tech Stack:** TypeScript, Node filesystem APIs, Hono, React 19, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-02-permanent-session-delete-design.md`

## Global Constraints

- Ordinary `Delete session`, Restart, and existing `sm.delete(id)` calls keep the SDK/CLI JSONL.
- New UI appears only in `SessionContextMenu` and the Chat message-area context menu.
- Never construct transcript paths from user-supplied cwd; use `findTranscriptFile()` and basename-constrained session ids.
- Do not swallow permanent-delete filesystem failures or broadcast successful removal after one.
- Do not modify unrelated untracked files or commit without a separate user request.

## Review Focus

- **Default safety:** an omitted flag preserves the main JSONL and session directory; pinned by Task 1 manager tests.
- **Missing artifacts:** deleting a session with no transcript still succeeds; pinned by Task 1 helper tests.
- **Retry after failure:** transcript errors prevent metadata removal and the `removed` broadcast; pinned by Task 1 manager tests.
- **Neighbor isolation:** another session's JSONL/directory remains untouched; pinned by Task 1 helper tests.
- **Entry-point scope:** SessionCard gains no new button and both approved context menus get exactly one permanent action; pinned by Task 2 UI tests and diff review.

---

### Task 1: Strict transcript-artifact deletion and API opt-in

**Files:**
- Modify: `server/history-reader.ts`
- Modify: `server/history-reader.test.ts`
- Modify: `server/session-manager.ts`
- Modify: `server/session-manager.test.ts`
- Modify: `server/routes/sessions.ts`

**Interfaces:**
- Produces: `deleteTranscriptFiles(sessionId: string): Promise<boolean>`; returns false when no main transcript exists, removes the sibling session directory then the main JSONL when present, and throws filesystem failures.
- Produces: `SessionManager.delete(id: string, opts?: { deleteTranscript?: boolean }): Promise<void>`.
- Consumes: route query `deleteTranscript=true`; all other values mean false.

- [ ] **Step 1: Write failing helper and manager tests**

Cover main JSONL plus `<id>/subagents/agent-*.jsonl` removal, missing-file no-op, unrelated-session preservation, ordinary `delete(id)` preservation, and permanent-delete failure preventing store removal/`removed` broadcast.

- [ ] **Step 2: Run focused tests and verify the new cases fail**

Run: `npm test -- server/history-reader.test.ts server/session-manager.test.ts`
Expected: new permanent-delete cases fail because the helper/option does not exist; existing cases pass.

- [ ] **Step 3: Implement the helper, manager option, and route query**

Call the strict helper only when `opts.deleteTranscript === true`, immediately after terminated `unload()` and before worktree/store teardown. Invalidate `jsonlPageCache` after successful artifact deletion. Keep existing sidecar and ordinary-delete behavior unchanged.

- [ ] **Step 4: Run focused backend tests**

Run: `npm test -- server/history-reader.test.ts server/session-manager.test.ts`
Expected: PASS.

### Task 2: Add the two permanent-delete context-menu actions

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/session-list/SessionContextMenu.tsx`
- Modify: `src/components/Chat.tsx`
- Modify: `src/components/ChatPanel.tsx`
- Test: `src/components/ChatPanel.side-chat.test.tsx` or the smallest existing context-menu test host that exercises the real item

**Interfaces:**
- Extend the relevant delete callbacks to `(sessionId: string, opts?: { deleteTranscript?: boolean }) => void`.
- `performDelete` appends `?deleteTranscript=true` only for the permanent action.
- New copy: label `Delete permanently`, title `Permanently delete session?`, confirm `Delete permanently`; message explicitly includes main and subagent local transcript files and irreversibility.

- [ ] **Step 1: Write failing UI tests**

Exercise each real context menu, confirm the new item, and assert the delete callback receives `{ deleteTranscript: true }`. Keep an ordinary-delete assertion proving it passes no permanent option. Do not add a SessionCard action.

- [ ] **Step 2: Run focused UI tests and verify the new cases fail**

Run the selected test files with `npm test -- <files>`; expected failure is the missing `Delete permanently` item.

- [ ] **Step 3: Implement callback threading and menu items**

Reuse `handleDelete`/`performDelete`; do not create a parallel deletion path. Keep all existing callers and the ordinary confirmation text intact.

- [ ] **Step 4: Run focused UI tests**

Run the selected test files again. Expected: PASS.

### Task 3: Full verification and required review

**Files:**
- Review all files changed by Tasks 1–2 only.

- [ ] **Step 1: Run project checks**

Run: `npm run typecheck`, `npm test`, and `npm run lint`.
Expected: all PASS; investigate and fix any regression caused by this change.

- [ ] **Step 2: Review the complete diff**

Run the `code-review` skill on `git diff HEAD`, verify every finding against the code, fix confirmed issues, and re-run affected checks plus review for non-trivial fixes.

- [ ] **Step 3: Report evidence**

Summarize behavior changed, exact verification commands/results, and any remaining limitation. Do not claim success from unrun checks.
