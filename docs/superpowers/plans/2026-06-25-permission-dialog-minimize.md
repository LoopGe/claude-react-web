# PermissionDialog Minimize for Regular Tool Permissions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the non-plan `PermissionDialog` a `×` minimize button (with a "Review permission" reopen chip on the matching `ToolCard`), matching the behavior plan/question already have.

**Architecture:** Clone the existing `minimizedPlan` state block in `Chat.tsx` for regular tool permissions, extend the `useReopenQuestion` context with the new minimized set + reopen callback, widen the `×` render condition in `PermissionDialog`, and have `ToolCard` consume the context to render a reopen chip when its `toolUseId` is minimized.

**Tech Stack:** React 19, TypeScript, Vitest + @testing-library/react, CSS with theme variables.

**Spec:** `docs/superpowers/specs/2026-06-25-permission-dialog-minimize-design.md`

---

## File Structure

- **Modify** `src/hooks/useReopenQuestion.ts` — add two fields to the context value + type + default.
- **Modify** `src/components/Chat.tsx` — add `minimizedPermission` state block (mirrors `minimizedPlan`), wire into `activeVisiblePendingRequest` + `reopenCtxValue`, pass `onMinimize` for non-plan permissions.
- **Modify** `src/components/PermissionDialog.tsx` — widen the `×` render condition.
- **Modify** `src/components/ToolCard.tsx` — consume `useReopenQuestion`, render "Review permission" chip when minimized.
- **Modify** `src/styles/messages.css` — add `.tool-card-perm-reopen` (mirror `.plan-card-reopen`, reuse `--warn`).
- **Modify** `src/components/PermissionDialog.test.tsx` — add tests for the `×` button on non-plan requests.

---

## Task 1: Extend the `useReopenQuestion` context

**Files:**
- Modify: `src/hooks/useReopenQuestion.ts`

- [ ] **Step 1: Add the two new fields to the context type, default value**

Replace the entire contents of `src/hooks/useReopenQuestion.ts` with:

```ts
// Context + hook for re-opening a minimized AskUserQuestion / plan / tool-permission dialog.
//
// Mirrors the pattern of useQuestionAnswers.ts — Chat owns the set of
// minimized tool_use_ids plus an `onReopen*` callback for each kind, and
// provides them through this context so the deeply nested inline cards
// (rendered inside per-message memoised MessageView trees) can read whether
// they're currently minimized and ask Chat to re-open them — without
// prop-drilling through MessageList.
//
// The provider is a renderless React component constructed via createElement
// to keep this file in the hooks/ directory (the project's eslint
// react-refresh rule treats files in hooks/ as non-component).

import { createContext, createElement, useContext, type ReactNode } from 'react'

export interface ReopenQuestionValue {
  /** tool_use_ids of pending questions whose dialog the user has minimized. */
  minimizedToolUseIds: ReadonlySet<string>
  /** tool_use_ids of pending plan requests whose dialog the user has minimized. */
  minimizedPlanToolUseIds: ReadonlySet<string>
  /** tool_use_ids of pending regular tool-permission requests whose dialog the user has minimized. */
  minimizedPermissionToolUseIds: ReadonlySet<string>
  /** Re-open the dialog for a minimized question, keyed by its tool_use_id. */
  onReopen: (toolUseId: string) => void
  /** Re-open the dialog for a minimized plan, keyed by its tool_use_id. */
  onReopenPlan: (toolUseId: string) => void
  /** Re-open the dialog for a minimized regular tool permission, keyed by its tool_use_id. */
  onReopenPermission: (toolUseId: string) => void
}

const Ctx = createContext<ReopenQuestionValue>({
  minimizedToolUseIds: new Set(),
  minimizedPlanToolUseIds: new Set(),
  minimizedPermissionToolUseIds: new Set(),
  onReopen: () => {},
  onReopenPlan: () => {},
  onReopenPermission: () => {},
})

export function ReopenQuestionProvider({
  value,
  children,
}: {
  value: ReopenQuestionValue
  children: ReactNode
}) {
  return createElement(Ctx.Provider, { value }, children)
}

/** Read the minimized state and the re-open callbacks. */
export function useReopenQuestion(): ReopenQuestionValue {
  return useContext(Ctx)
}
```

- [ ] **Step 2: Run typecheck to confirm the new field compiles**

Run: `npm run typecheck`
Expected: PASS (no new errors — `Chat.tsx` doesn't supply the new field yet, but the default context value covers it; the provider value will be updated in Task 3).

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useReopenQuestion.ts
git commit -m "refactor: add permission minimize fields to ReopenQuestion context"
```

---

## Task 2: Widen the `×` render condition in `PermissionDialog`

**Files:**
- Modify: `src/components/PermissionDialog.tsx:153-162`
- Modify: `src/components/PermissionDialog.test.tsx` (add tests)

- [ ] **Step 1: Write the failing tests**

Append this `describe` block to the end of `src/components/PermissionDialog.test.tsx` (after the closing `})` of the existing `describe('PermissionDialog plan approval', …)`):

```ts
describe('PermissionDialog minimize button', () => {
  it('renders a Minimize button for a non-plan request when onMinimize is provided', () => {
    const onMinimize = vi.fn()
    const { container } = render(
      <PermissionDialog request={toolRequest()} onDecide={vi.fn()} onMinimize={onMinimize} />,
    )
    const btn = within(container).getByRole('button', { name: 'Minimize' })
    expect(btn).toBeTruthy()
  })

  it('does not render a Minimize button when onMinimize is not provided', () => {
    const { container } = render(
      <PermissionDialog request={toolRequest()} onDecide={vi.fn()} />,
    )
    expect(within(container).queryByRole('button', { name: 'Minimize' })).toBeNull()
  })

  it('clicking the Minimize button calls onMinimize', () => {
    const onMinimize = vi.fn()
    const { container } = render(
      <PermissionDialog request={toolRequest()} onDecide={vi.fn()} onMinimize={onMinimize} />,
    )
    fireEvent.click(within(container).getByRole('button', { name: 'Minimize' }))
    expect(onMinimize).toHaveBeenCalledTimes(1)
  })

  it('still renders a Minimize button for a plan request when onMinimize is provided (regression)', () => {
    const onMinimize = vi.fn()
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={vi.fn()} onMinimize={onMinimize} />,
    )
    expect(within(container).getByRole('button', { name: 'Minimize' })).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/PermissionDialog.test.tsx`
Expected: FAIL — the first three tests fail because no `Minimize` button renders for non-plan requests (the current condition gates on `isPlanRequest`).

- [ ] **Step 3: Widen the `×` render condition**

In `src/components/PermissionDialog.tsx`, find this block (around line 153):

```tsx
          {isPlanRequest && onMinimize && (
            <button
              className="btn-icon"
              aria-label="Minimize"
              disabled={busy}
              onClick={onMinimize}
            >
              <IconX size={14} />
            </button>
          )}
```

Replace the condition `{isPlanRequest && onMinimize && (` with `{onMinimize && (`:

```tsx
          {onMinimize && (
            <button
              className="btn-icon"
              aria-label="Minimize"
              disabled={busy}
              onClick={onMinimize}
            >
              <IconX size={14} />
            </button>
          )}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/PermissionDialog.test.tsx`
Expected: PASS — all four new tests pass, plus the existing plan-approval tests stay green.

- [ ] **Step 5: Commit**

```bash
git add src/components/PermissionDialog.tsx src/components/PermissionDialog.test.tsx
git commit -m "feat(PermissionDialog): show minimize button for non-plan permissions"
```

---

## Task 3: Wire minimize state for regular permissions in `Chat.tsx`

**Files:**
- Modify: `src/components/Chat.tsx:461-507` (add the permission minimize block + extend `activeVisiblePendingRequest`) and `src/components/Chat.tsx:1226` (pass `onMinimize` for non-plan permissions)

- [ ] **Step 1: Add the `minimizedPermission` state block**

In `src/components/Chat.tsx`, find the plan minimize block (starts at the comment `// Plan minimize/re-open — same pattern as questions.` around line 461). Immediately **after** the plan stale-state cleanup `useEffect` (the one ending around line 498 with `}, [permissions.pending])`), insert this new block:

```ts
  // Regular tool-permission minimize/re-open — same pattern as plan, but for
  // permission requests whose toolName is NOT a plan tool. The inline reopen
  // chip lives on the generic ToolCard (ToolCard.tsx) via useReopenQuestion.
  const [minimizedPermission, setMinimizedPermission] = useState<Set<string>>(() => new Set())
  const minimizePermission = useCallback((id: string) => {
    setMinimizedPermission((prev) => { const next = new Set(prev); next.add(id); return next })
  }, [])
  const reopenPermission = useCallback(
    (toolUseId: string) => {
      const req = permissions.pending.find(
        (p) => p.kind === 'permission' && !PLAN_TOOL_NAMES.has(p.toolName) && p.toolUseID === toolUseId,
      )
      if (!req) return
      setMinimizedPermission((prev) => {
        if (!prev.has(req.id)) return prev
        const next = new Set(prev); next.delete(req.id); return next
      })
    },
    [permissions.pending],
  )
  const minimizedPermissionToolUseIds = useMemo(() => {
    const out = new Set<string>()
    for (const p of permissions.pending) {
      if (p.kind === 'permission' && !PLAN_TOOL_NAMES.has(p.toolName) && minimizedPermission.has(p.id)) {
        out.add(p.toolUseID)
      }
    }
    return out
  }, [permissions.pending, minimizedPermission])
  // Clean up stale permission minimize state when permissions resolve.
  useEffect(() => {
    const livePerm = new Set(
      permissions.pending
        .filter((p) => p.kind === 'permission' && !PLAN_TOOL_NAMES.has(p.toolName))
        .map((p) => p.id),
    )
    setMinimizedPermission((prev) => {
      let changed = false
      const next = new Set<string>()
      for (const id of prev) {
        if (livePerm.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [permissions.pending])
```

- [ ] **Step 2: Extend `reopenCtxValue` with the two new fields**

Find the `reopenCtxValue` memo (around line 500):

```ts
  const reopenCtxValue = useMemo(
    () => ({ minimizedToolUseIds, minimizedPlanToolUseIds, onReopen: reopenQuestion, onReopenPlan: reopenPlan }),
    [minimizedToolUseIds, minimizedPlanToolUseIds, reopenQuestion, reopenPlan],
  )
```

Replace with:

```ts
  const reopenCtxValue = useMemo(
    () => ({
      minimizedToolUseIds,
      minimizedPlanToolUseIds,
      minimizedPermissionToolUseIds,
      onReopen: reopenQuestion,
      onReopenPlan: reopenPlan,
      onReopenPermission: reopenPermission,
    }),
    [minimizedToolUseIds, minimizedPlanToolUseIds, minimizedPermissionToolUseIds, reopenQuestion, reopenPlan, reopenPermission],
  )
```

- [ ] **Step 3: Extend the minimized guards + `activeVisiblePendingRequest`**

Find (around lines 505–507):

```ts
  const activePendingRequest = permissions.pending[0]
  const isMinimizedQuestion = activePendingRequest?.kind === 'question' && minimizedQ.has(activePendingRequest.id)
  const isMinimizedPlan = activePendingRequest?.kind === 'permission' && PLAN_TOOL_NAMES.has(activePendingRequest.toolName) && minimizedPlan.has(activePendingRequest.id)
  const activeVisiblePendingRequest = (isMinimizedQuestion || isMinimizedPlan) ? null : activePendingRequest
```

Replace with:

```ts
  const activePendingRequest = permissions.pending[0]
  const isMinimizedQuestion = activePendingRequest?.kind === 'question' && minimizedQ.has(activePendingRequest.id)
  const isMinimizedPlan = activePendingRequest?.kind === 'permission' && PLAN_TOOL_NAMES.has(activePendingRequest.toolName) && minimizedPlan.has(activePendingRequest.id)
  const isMinimizedPermission = activePendingRequest?.kind === 'permission' && !PLAN_TOOL_NAMES.has(activePendingRequest.toolName) && minimizedPermission.has(activePendingRequest.id)
  const activeVisiblePendingRequest = (isMinimizedQuestion || isMinimizedPlan || isMinimizedPermission) ? null : activePendingRequest
```

- [ ] **Step 4: Pass `onMinimize` for non-plan permissions at the render site**

Find the `PermissionDialog` render (around line 1219–1228):

```tsx
            <PermissionDialog
              key={pendingHead.id}
              open={pendingDialogOpen}
              request={pendingHead}
              onDecide={(d) => void permissions.decide(pendingHead.id, d)}
              planContentMap={stream.planContent}
              currentMode={session.permissionMode}
              onMinimize={PLAN_TOOL_NAMES.has(pendingHead.toolName) ? () => minimizePlan(pendingHead.id) : undefined}
            />
```

Replace the `onMinimize` line so the non-plan branch passes `minimizePermission` instead of `undefined`:

```tsx
            <PermissionDialog
              key={pendingHead.id}
              open={pendingDialogOpen}
              request={pendingHead}
              onDecide={(d) => void permissions.decide(pendingHead.id, d)}
              planContentMap={stream.planContent}
              currentMode={session.permissionMode}
              onMinimize={PLAN_TOOL_NAMES.has(pendingHead.toolName) ? () => minimizePlan(pendingHead.id) : () => minimizePermission(pendingHead.id)}
            />
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — `PLAN_TOOL_NAMES` is already imported in `Chat.tsx` (used by the plan block), and `useMemo`/`useCallback`/`useEffect`/`useState` are already imported.

- [ ] **Step 6: Run the full test suite**

Run: `npm run test`
Expected: PASS — no regressions. (The new minimize behavior is wired but the reopen chip isn't rendered yet; that's Task 4. Manual verification comes after Task 5.)

- [ ] **Step 7: Commit**

```bash
git add src/components/Chat.tsx
git commit -m "feat(Chat): wire minimize state for regular tool permissions"
```

---

## Task 4: Render the "Review permission" reopen chip on `ToolCard`

**Files:**
- Modify: `src/components/ToolCard.tsx`
- Modify: `src/styles/messages.css` (add `.tool-card-perm-reopen`)

- [ ] **Step 1: Add the CSS for the reopen chip**

In `src/styles/messages.css`, find the `.plan-card-reopen:hover` block (around line 1817–1819):

```css
.plan-card-reopen:hover {
  background: color-mix(in srgb, var(--warn) 85%, #000);
}
```

Immediately **after** that block (and before `details.plan-card-minimized {`), insert:

```css
/* "Review permission" pill on a ToolCard whose pending tool-permission dialog
   the user has minimized. Mirrors .plan-card-reopen — reuses --warn so no new
   theme color is introduced. */
.tool-card-perm-reopen {
  padding: 2px 10px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 999px;
  cursor: pointer;
  background: var(--warn);
  color: var(--bg);
  border: 1px solid color-mix(in srgb, var(--warn) 60%, transparent);
  white-space: nowrap;
}
.tool-card-perm-reopen:hover {
  background: color-mix(in srgb, var(--warn) 85%, #000);
}
```

- [ ] **Step 2: Make `ToolCard` consume `useReopenQuestion` and render the chip**

In `src/components/ToolCard.tsx`, add the import. Find the existing import from the icons (line 13–19 area) and the other imports; add this line alongside the other `../hooks` imports (after the `useToolResult`/`useToolStatus` import, line 21):

```ts
import { useReopenQuestion } from '../hooks/useReopenQuestion'
```

Then, inside the `ToolCard` component body, find the line that reads the tool result (around line 301):

```ts
  const result = useToolResult(toolUseId)
```

Add immediately after it:

```ts
  // When this tool's pending permission dialog has been minimized, surface a
  // "Review permission" chip so the user can re-open it. Mirrors the inline
  // reopen button PlanCard/QuestionCard render when minimized.
  const { minimizedPermissionToolUseIds, onReopenPermission } = useReopenQuestion()
  const isPermMinimized = !!toolUseId && minimizedPermissionToolUseIds.has(toolUseId)
```

Then, in the returned JSX, find the header chip row (around line 309):

```tsx
        {chips}
        <span className="tool-card-spacer" />
```

Replace with:

```tsx
        {chips}
        {isPermMinimized && toolUseId && (
          <button
            type="button"
            className="tool-card-perm-reopen"
            onClick={() => onReopenPermission(toolUseId)}
          >
            Review permission
          </button>
        )}
        <span className="tool-card-spacer" />
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run the full test suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ToolCard.tsx src/styles/messages.css
git commit -m "feat(ToolCard): show Review permission chip when minimized"
```

---

## Task 5: Manual verification + lint

**Files:** none (verification only)

- [ ] **Step 1: Run lint**

Run: `npm run lint`
Expected: PASS — no new eslint errors. (If `ToolCard.tsx` triggers a react-refresh warning for importing a hook, it's fine — `useReopenQuestion` is a hook, not a component, and `ToolCard` already imports hooks like `useToolResult`.)

- [ ] **Step 2: Run the dev server and verify manually**

Run: `npm run dev`

Then in the browser (http://localhost:5174):

1. Start a session in `default` permission mode and send a prompt that triggers a tool permission (e.g. ask Claude to run a Bash command).
2. When the `PermissionDialog` appears for the non-plan tool, confirm a `×` button is in the top-right of the card header.
3. Click `×`. Confirm: the dialog hides, the session stays "working" (pending), and the corresponding `ToolCard` in the transcript shows a "Review permission" chip.
4. Click "Review permission". Confirm: the `PermissionDialog` reappears.
5. Click "Allow once" (or "Deny"). Confirm: the permission resolves and the chip disappears.
6. Repeat with a plan-mode prompt (ExitPlanMode) to confirm the plan `×` still works (regression).

Expected: all behaviors work as described.

- [ ] **Step 3: Final commit (if any lint fixes)**

If lint or manual review produced fixes, commit them:

```bash
git add -A
git commit -m "chore: polish permission minimize UX"
```

Otherwise, no commit needed — the feature is complete.

---

## Self-Review Notes

- **Spec coverage:** Every spec change section (1–6) maps to a task: hook (Task 1), PermissionDialog condition (Task 2), Chat.tsx wiring (Task 3), ToolCard chip (Task 4), CSS (Task 4 Step 1), SideChatDrawer untouched (no task — correct). Testing covered in Task 2 + Task 5.
- **Type consistency:** Field names match across tasks: `minimizedPermissionToolUseIds` / `onReopenPermission` (Task 1 defines, Task 3 supplies, Task 4 consumes). `isMinimizedPermission` used only in `Chat.tsx`.
- **No placeholders:** All steps contain exact code and exact commands.
