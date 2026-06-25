# PermissionDialog minimize for regular tool permissions

**Date:** 2026-06-25
**Status:** Approved

## Problem

`PermissionDialog` shows a `×` minimize button **only** for plan-mode requests. Regular
tool-permission requests (Bash, Edit, …) have no minimize affordance — the user must
Allow/Deny immediately (Escape = Deny). This is an asymmetry with both `QuestionDialog`
(AskUserQuestion) and the plan path of `PermissionDialog`, both of which let the user
hide the dialog to read the transcript and reopen it later.

## Goal

Give the non-plan `PermissionDialog` the same minimize behavior plan/question already
have, with a "Review permission" reopen chip on the corresponding generic `ToolCard`.

## Behavior

- The `×` button renders on `PermissionDialog` whenever `onMinimize` is passed (no
  longer gated on `isPlanRequest`). `aria-label="Minimize"`.
- `×` = **minimize**: hide the overlay; the request stays pending; the SDK keeps
  awaiting the `canUseTool` decision.
- **Escape = Deny** (unchanged) — same split plan mode already uses. Escape does not
  minimize.
- Minimizing the active pending permission hides the dialog. Subsequent queued
  permissions do **not** auto-surface while the head is minimized — this matches the
  existing plan/question behavior (`activeVisiblePendingRequest` becomes null while the
  head is minimized).
- **Reopen**: a "Review permission" chip on the `ToolCard` whose `toolUseId` matches the
  minimized pending permission. Clicking drops the id from the minimized set and the
  dialog re-renders.

## Changes

1. **`src/hooks/useReopenQuestion.ts`** — extend `ReopenQuestionValue` with
   `minimizedPermissionToolUseIds: ReadonlySet<string>` and
   `onReopenPermission: (toolUseId: string) => void`. Add both to the default context
   value.

2. **`src/components/Chat.tsx`** — clone the `minimizedPlan` block for regular
   permissions:
   - `minimizedPermission` Set + `minimizePermission` / `reopenPermission` callbacks
     (predicate: `kind === 'permission' && !PLAN_TOOL_NAMES.has(toolName)`).
   - `minimizedPermissionToolUseIds` memo (same predicate).
   - Stale-state cleanup `useEffect` mirroring the plan one (lines 485–498).
   - Extend `reopenCtxValue` with the two new fields.
   - Extend `activeVisiblePendingRequest` to treat a minimized regular permission as
     hidden (add `isMinimizedPermission` to the guard).
   - Pass `onMinimize` for non-plan permissions at the `PermissionDialog` render site
     (currently line 1226: `onMinimize={PLAN_TOOL_NAMES.has(...) ? minimizePlan : undefined}`
     → pass `minimizePermission` for the non-plan branch).

3. **`src/components/PermissionDialog.tsx`** — change the `×` render condition from
   `{isPlanRequest && onMinimize && …}` to `{onMinimize && …}`.

4. **`src/components/ToolCard.tsx`** — consume `useReopenQuestion`; when `toolUseId` is
   in `minimizedPermissionToolUseIds`, render a "Review permission" button in the header
   chip row (before the spacer / status badge).

5. **CSS** — add `.tool-card-perm-reopen` styling using theme CSS variables only, mirroring
   `.plan-card-reopen`. Define in both `:root` (dark) and `[data-theme="light"]` blocks
   where new colors are introduced.

6. **`src/components/SideChatDrawer.tsx`** — untouched. It does not pass `onMinimize`
   even for plan today, so no `×` appears there either (consistent).

## Testing

- `src/components/PermissionDialog.test.tsx`: `×` renders for a non-plan request when
  `onMinimize` is provided; clicking it calls `onMinimize`; `×` is absent when
  `onMinimize` is not provided (side-chat path). Existing plan-minimize tests stay green.
- Manual: minimize a regular permission → dialog hides, ToolCard shows "Review
  permission" chip → click reopens dialog → Allow/Deny resolves.

## Out of scope

- Panel-level floating "pending permission" pill.
- SideChatDrawer minimize support.
- Changing Escape semantics.
- Minimize for the question path (already exists).
