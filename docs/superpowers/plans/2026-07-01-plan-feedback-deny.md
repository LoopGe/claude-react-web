# Plan Feedback Deny Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user deny a plan proposal (`ExitPlanMode`) either with feedback (Claude re-plans in the same turn) or by stopping the turn entirely (user gets the composer back), by threading an optional `interrupt` flag through the deny path and replacing the plan dialog's "Keep planning" button with a feedback input plus two deny actions.

**Architecture:** The SDK's `PermissionResult` deny variant already supports `interrupt?: boolean` (`sdk.d.ts:2023-2029`); `interrupt: true` aborts the whole turn. We widen the deny decision type end-to-end (UI → REST → SessionManager → PermissionBroker → SDK), defaulting to `false` so existing plain-tool-permission denies are unchanged. The plan dialog's footer replaces the single "Keep planning" button with a feedback `<textarea>`, a "Send feedback" button (disabled when empty, sends `message` with no `interrupt`), and a "Stop & take over" button (sends `interrupt: true`). Plan-dialog Esc is flipped to `interrupt: true`; plain-tool Esc is unchanged.

**Tech Stack:** React 19 + Vitest (@testing-library/react, jsdom) for the client; Hono + Vitest for the server; TypeScript strict. CSS uses existing theme variables (no new colors).

**Spec:** `docs/superpowers/specs/2026-07-01-plan-feedback-deny-design.md`

---

## File Structure

**Modify:**
- `server/permission-broker.ts` — widen `decide()` deny param to include `interrupt?: boolean`; resolve with `decision.interrupt ?? false`. Update the stale doc comment.
- `server/session-manager.ts` — widen `decide()` signature's deny variant the same way. Update the stale doc comment.
- `server/routes/permissions.ts` — read `interrupt` from the request body and pass it through on deny.
- `src/hooks/usePermissionChannel.ts` — widen `PermissionDecision` deny variant with `interrupt?: boolean`.
- `src/components/PermissionDialog.tsx` — replace plan-footer "Keep planning" button with feedback textarea + "Send feedback" + "Stop & take over"; flip plan-dialog Esc to `interrupt: true`.
- `src/components/PermissionDialog.test.tsx` — update `buttonLabels` filter (remove "Keep planning"), add new plan-deny tests, add plan-vs-tool Esc test.

**No new files.** No CSS changes (uses existing `.btn`, `.btn-danger`, `.btn-primary`, theme vars).

---

### Task 1: Backend — thread `interrupt` through the deny path (TDD)

**Files:**
- Modify: `server/permission-broker.ts:498-553` (the `decide` method)
- Modify: `server/session-manager.ts:2120-2148` (the `decide` method + doc comment)
- Modify: `server/routes/permissions.ts:23-55` (the decide route)
- Test: `server/permission-broker.test.ts` (the `decide` describe block, ~line 533)
- Test: `server/routes/permissions.test.ts`

- [ ] **Step 1: Write the failing broker test**

Add to `server/permission-broker.test.ts`, inside the `describe('decide', ...)` block, right after the existing `'resolves a pending permission with deny'` test (~line 545):

```ts
    it('resolves a pending permission with deny + interrupt:true when requested', () => {
      const { broker, session, pending } = setupPending()
      broker.decide(session, pending.id, { behavior: 'deny', message: 'stop', interrupt: true })
      expect(pending.resolve).toHaveBeenCalledWith(expect.objectContaining({
        behavior: 'deny',
        message: 'stop',
        interrupt: true,
      }))
    })

    it('defaults interrupt to false when not provided on deny', () => {
      const { broker, session, pending } = setupPending()
      broker.decide(session, pending.id, { behavior: 'deny', message: 'nope' })
      expect(pending.resolve).toHaveBeenCalledWith(expect.objectContaining({
        behavior: 'deny',
        interrupt: false,
      }))
    })
```

If `setupPending` is not the existing helper name in this file, reuse whatever helper the existing `'resolves a pending permission with deny'` test (line 533) uses to build `{ broker, session, pending }`. Read that test first and mirror it exactly.

- [ ] **Step 2: Run broker tests to verify they fail**

Run: `npx vitest run server/permission-broker.test.ts`
Expected: the new `interrupt: true` test FAILS — the resolved object has `interrupt: false` (broker hardcodes it). The `defaults to false` test should PASS already.

- [ ] **Step 3: Widen the broker `decide` signature and pass `interrupt` through**

In `server/permission-broker.ts`, find the `decide` method signature (~line 505-506) and widen the deny variant:

```ts
      | { behavior: 'deny'; message?: string; interrupt?: boolean },
```

Then at the deny resolution (~line 542-547), change `interrupt: false` to `interrupt: decision.interrupt ?? false`:

```ts
      const message = decision.message?.trim() || 'User denied the tool request.'
      p.resolve({
        behavior: 'deny',
        message,
        interrupt: decision.interrupt ?? false,
        toolUseID: p.toolUseID,
      })
```

Also update the stale doc comment above the method (~line 495-496) from "For 'deny': we always return interrupt=false, so the model sees the deny result and can re-plan rather than aborting the whole turn." to:

```ts
   * For "deny": `interrupt` defaults to false (the model sees the deny result
   * and re-plans). A caller can pass `interrupt: true` to abort the whole turn
   * instead (used by the plan dialog's "Stop & take over" action).
```

- [ ] **Step 4: Run broker tests to verify they pass**

Run: `npx vitest run server/permission-broker.test.ts`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 5: Write the failing route test**

Add to `server/routes/permissions.test.ts`, inside the `describe('permission routes', ...)` block:

```ts
  it('forwards interrupt:true on deny', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/permissions/p1/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ behavior: 'deny', interrupt: true }),
    })
    expect(res.status).toBe(200)
    expect(sm.decide).toHaveBeenCalledWith('s1', 'p1', {
      behavior: 'deny',
      message: undefined,
      interrupt: true,
    })
  })

  it('omits interrupt on deny when not provided', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/permissions/p1/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ behavior: 'deny', message: 'no' }),
    })
    expect(res.status).toBe(200)
    expect(sm.decide).toHaveBeenCalledWith('s1', 'p1', {
      behavior: 'deny',
      message: 'no',
    })
  })
```

- [ ] **Step 6: Run route tests to verify they fail**

Run: `npx vitest run server/routes/permissions.test.ts`
Expected: the `forwards interrupt:true on deny` test FAILS — `sm.decide` is called without `interrupt` (route doesn't read/pass it).

- [ ] **Step 7: Widen SessionManager.decide signature and read `interrupt` in the route**

In `server/session-manager.ts`, widen the `decide` signature (~line 2127-2129):

```ts
    decision:
      | { behavior: 'allow'; persistForSession?: boolean; planTargetMode?: PermissionMode }
      | { behavior: 'deny'; message?: string; interrupt?: boolean },
```

Update the stale doc comment above it (~line 2121-2122) from "For 'deny': we always return interrupt=false..." to:

```ts
   * For "deny": `interrupt` defaults to false (model re-plans). `interrupt: true`
   * aborts the turn — used by the plan dialog's "Stop & take over" action.
```

In `server/routes/permissions.ts`, widen the parsed body type (~line 26) and pass `interrupt` through on deny (~line 48-51):

```ts
    const raw = await safeJson<{ behavior: unknown; persistForSession: unknown; message: unknown; planTargetMode: unknown; interrupt: unknown }>(c.req)
```

```ts
    if (raw.behavior === 'deny') {
      log.info(`decide session=${id} pid=${pid} behavior=deny interrupt=${raw.interrupt === true}`)
      await sm.decide(id, pid, {
        behavior: 'deny',
        message: typeof raw.message === 'string' ? raw.message : undefined,
        interrupt: typeof raw.interrupt === 'boolean' ? raw.interrupt : undefined,
      })
      return c.json({ ok: true })
    }
```

- [ ] **Step 8: Run route tests + broker tests to verify they pass**

Run: `npx vitest run server/routes/permissions.test.ts server/permission-broker.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/permission-broker.ts server/permission-broker.test.ts server/session-manager.ts server/routes/permissions.ts server/routes/permissions.test.ts
git commit -m "feat(permissions): thread interrupt flag through deny path

Widen the deny decision type end-to-end (route → SessionManager →
PermissionBroker → SDK) with an optional `interrupt` boolean. Defaults
to false so existing plain-tool denies are unchanged. The plan dialog
will use interrupt:true to abort the turn on 'Stop & take over'."
```

---

### Task 2: Frontend — widen `PermissionDecision` type

**Files:**
- Modify: `src/hooks/usePermissionChannel.ts:15-22`

- [ ] **Step 1: Widen the deny variant of `PermissionDecision`**

In `src/hooks/usePermissionChannel.ts`, update the `PermissionDecision` type (lines 15-19):

```ts
export type PermissionDecision =
  // `planTargetMode` only applies when approving a plan proposal (ExitPlanMode):
  // the execution mode the session switches to after the plan is approved.
  | { behavior: 'allow'; persistForSession: boolean; planTargetMode?: PlanTargetMode }
  // `interrupt` defaults to false (model re-plans). `interrupt: true` aborts
  // the whole turn — used by the plan dialog's "Stop & take over" action.
  | { behavior: 'deny'; message?: string; interrupt?: boolean }
```

- [ ] **Step 2: Run typecheck to verify the widen is consistent so far**

Run: `npm run typecheck`
Expected: PASS (no callers pass `interrupt` yet, so nothing breaks).

- [ ] **Step 3: Commit**

```bash
git add src/hooks/usePermissionChannel.ts
git commit -m "feat(permissions): widen PermissionDecision deny with interrupt?"
```

---

### Task 3: Frontend — plan dialog feedback input + two deny buttons (TDD)

**Files:**
- Modify: `src/components/PermissionDialog.tsx:48-297` (component body + plan footer)
- Test: `src/components/PermissionDialog.test.tsx`

- [ ] **Step 1: Update the `buttonLabels` helper so existing plan tests still work**

In `src/components/PermissionDialog.test.tsx`, the `buttonLabels` helper (line 42-48) filters by `t.startsWith('Approve') || t === 'Keep planning'`. "Keep planning" is being removed. Update the filter so the plan-ordering tests (which only assert on `Approve` labels) keep working:

```ts
function buttonLabels(container: HTMLElement): string[] {
  return within(container)
    .getAllByRole('button')
    .map((b) => b.textContent?.trim() ?? '')
    // Drop the "Show raw input" toggle and the new deny actions; the plan
    // ordering tests only assert on Approve labels.
    .filter((t) => t.startsWith('Approve'))
}
```

- [ ] **Step 2: Write the failing tests for the new plan deny UI**

Add to `src/components/PermissionDialog.test.tsx`, inside the `describe('PermissionDialog plan approval', ...)` block (after the existing tests):

```ts
  it('renders a feedback input and two deny actions for a plan request', () => {
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={vi.fn()} currentMode={'default'} />,
    )
    expect(within(container).getByPlaceholderText('Tell Claude what to change')).toBeTruthy()
    expect(within(container).getByRole('button', { name: /Send feedback/i })).toBeTruthy()
    expect(within(container).getByRole('button', { name: /Stop & take over/i })).toBeTruthy()
  })

  it('disables Send feedback when the input is empty', () => {
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={vi.fn()} currentMode={'default'} />,
    )
    expect(within(container).getByRole('button', { name: /Send feedback/i })).toBeDisabled()
  })

  it('Send feedback emits deny with message and no interrupt', () => {
    const onDecide = vi.fn()
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={onDecide} currentMode={'default'} />,
    )
    const input = within(container).getByPlaceholderText('Tell Claude what to change') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'add more tests' } })
    fireEvent.click(within(container).getByRole('button', { name: /Send feedback/i }))
    expect(onDecide).toHaveBeenCalledWith({
      behavior: 'deny',
      message: 'add more tests',
    })
  })

  it('Stop & take over emits deny with interrupt:true', () => {
    const onDecide = vi.fn()
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={onDecide} currentMode={'default'} />,
    )
    fireEvent.click(within(container).getByRole('button', { name: /Stop & take over/i }))
    expect(onDecide).toHaveBeenCalledWith({
      behavior: 'deny',
      interrupt: true,
    })
  })
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `npx vitest run src/components/PermissionDialog.test.tsx`
Expected: the four new tests FAIL (no feedback input, no "Send feedback"/"Stop & take over" buttons; "Keep planning" still present). The first existing plan test (`promotes the option matching the current mode...`) should still PASS after the `buttonLabels` filter change.

- [ ] **Step 4: Widen the `click` callback's deny type and add `feedback` state**

In `src/components/PermissionDialog.tsx`, widen the `click` helper's deny type (lines 60-64) and the `Props.onDecide` type (lines 27-31) to include `interrupt?: boolean`:

```ts
  onDecide: (
    decision:
      | { behavior: 'allow'; persistForSession: boolean; planTargetMode?: PlanTargetMode }
      | { behavior: 'deny'; message?: string; interrupt?: boolean },
  ) => void
```

```ts
  const click = (
    d:
      | { behavior: 'allow'; persistForSession: boolean; planTargetMode?: PlanTargetMode }
      | { behavior: 'deny'; message?: string; interrupt?: boolean },
  ) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    onDecide(d)
  }
```

Add a `feedback` state hook near the other `useState` calls (after line 50):

```ts
  const [feedback, setFeedback] = useState('')
```

- [ ] **Step 5: Replace the plan footer's "Keep planning" block with the feedback input + two buttons**

In `src/components/PermissionDialog.tsx`, replace the block at lines 241-250 (the `<div>` containing the "Keep planning" button) with:

```tsx
              <textarea
                className="perm-feedback-input"
                placeholder="Tell Claude what to change"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                disabled={busy}
                rows={2}
                aria-label="Plan feedback"
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn"
                  onClick={() => click({ behavior: 'deny', message: feedback })}
                  disabled={busy || feedback.trim().length === 0}
                  style={{ flex: 1 }}
                  title="Send this feedback to Claude — it keeps planning in this turn"
                >
                  Send feedback
                </button>
                <button
                  className="btn btn-danger"
                  onClick={() => click({ behavior: 'deny', interrupt: true })}
                  disabled={busy}
                  style={{ flex: 1 }}
                  title="Stop this turn and return to the input box"
                >
                  Stop & take over
                </button>
              </div>
```

Update the footer hint (lines 251-255) to explain the two actions:

```tsx
              <span className="hint" style={{ textAlign: 'center' }}>
                Approving exits plan mode and lets Claude execute in the chosen
                mode. "Send feedback" returns your note to Claude so it can
                revise. "Stop & take over" ends this turn so you can type.
              </span>
```

- [ ] **Step 6: Run the dialog tests to verify they pass**

Run: `npx vitest run src/components/PermissionDialog.test.tsx`
Expected: PASS (all tests, including the four new ones and the existing plan-ordering tests).

- [ ] **Step 7: Add minimal CSS for the feedback textarea using existing theme variables**

In `src/styles/session-list.css`, inside the `.perm-card` section (near the other `.perm-card` rules, ~line 430-450), add:

```css
.perm-feedback-input {
  width: 100%;
  resize: vertical;
  min-height: 44px;
  padding: 8px 10px;
  font-family: inherit;
  font-size: var(--font-size-sm, 13px);
  color: var(--text-primary);
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 6px;
}
.perm-feedback-input:focus {
  outline: none;
  border-color: var(--accent);
}
.perm-feedback-input:disabled {
  opacity: 0.6;
}
```

If any of these variables (`--text-primary`, `--input-bg`, `--input-border`, `--accent`, `--font-size-sm`) do not exist, run `grep -n "input-bg\|input-border\|--accent\b" src/styles/*.css` and use the closest existing equivalents. Do NOT introduce new hex colors — CLAUDE.md forbids it.

- [ ] **Step 8: Commit**

```bash
git add src/components/PermissionDialog.tsx src/components/PermissionDialog.test.tsx src/styles/session-list.css
git commit -m "feat(plan): feedback input + Stop & take over deny action

Replace the plan dialog's 'Keep planning' button with a feedback
textarea, a 'Send feedback' button (sends deny with message, model
re-plans), and a 'Stop & take over' button (deny with interrupt:true,
aborts the turn). Empty feedback disables Send feedback."
```

---

### Task 4: Frontend — flip plan-dialog Esc to `interrupt: true` (TDD)

**Files:**
- Modify: `src/components/PermissionDialog.tsx:71-85` (the Esc `useEffect`)
- Test: `src/components/PermissionDialog.test.tsx`

- [ ] **Step 1: Write the failing Esc tests**

Add to `src/components/PermissionDialog.test.tsx`, inside the `describe('PermissionDialog plan approval', ...)` block:

```ts
  it('Esc on a plan dialog denies with interrupt:true', () => {
    const onDecide = vi.fn()
    const { container } = render(
      <PermissionDialog request={planRequest()} onDecide={onDecide} currentMode={'default'} />,
    )
    const dialog = container.querySelector('.perm-card') as HTMLElement
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onDecide).toHaveBeenCalledWith({ behavior: 'deny', interrupt: true })
  })
```

Add to the `describe('PermissionDialog minimize button', ...)` block (or a new `describe` for non-plan Esc — keep it simple, add to the plan-approval block's sibling):

```ts
describe('PermissionDialog Esc', () => {
  it('Esc on a plain tool dialog denies without interrupt (regression)', () => {
    const onDecide = vi.fn()
    const { container } = render(
      <PermissionDialog request={toolRequest()} onDecide={onDecide} currentMode={'default'} />,
    )
    const dialog = container.querySelector('.perm-card') as HTMLElement
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onDecide).toHaveBeenCalledWith({ behavior: 'deny' })
  })
})
```

- [ ] **Step 2: Run the tests to verify the plan-Esc test fails**

Run: `npx vitest run src/components/PermissionDialog.test.tsx`
Expected: the plan-Esc test FAILS (Esc currently calls `click({ behavior: 'deny' })` with no interrupt). The plain-tool Esc regression test should PASS.

- [ ] **Step 3: Flip plan-dialog Esc to `interrupt: true`**

In `src/components/PermissionDialog.tsx`, update the Esc handler (lines 73-85). It currently always calls `click({ behavior: 'deny' })`. Branch on `isPlanRequest`:

```ts
  // Escape should deny and close — not fall through to the global Escape
  // handler which would interrupt the session instead. For plan requests,
  // Esc means "stop the turn" (interrupt:true, aligns with the CLI); for
  // plain tool permissions, Esc is a soft deny (model re-plans).
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    const onKey = (e: KeyboardEvent) => {
      if (open && e.key === 'Escape' && !busyRef.current) {
        e.preventDefault()
        e.stopPropagation()
        if (isPlanRequest) {
          click({ behavior: 'deny', interrupt: true })
        } else {
          click({ behavior: 'deny' })
        }
      }
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  })
```

Note: `isPlanRequest` is defined later in the component body (line 91). Move its definition above this `useEffect` (or hoist the `PLAN_TOOL_NAMES.has(request.toolName)` check into the effect). Simplest: move the `const isPlanRequest = PLAN_TOOL_NAMES.has(request.toolName)` line to just above this `useEffect`.

- [ ] **Step 4: Run the dialog tests to verify they pass**

Run: `npx vitest run src/components/PermissionDialog.test.tsx`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/PermissionDialog.tsx src/components/PermissionDialog.test.tsx
git commit -m "feat(plan): Esc in plan dialog aborts the turn (interrupt:true)

Aligns with the claude-code CLI, where Esc during a plan proposal
stops the turn and returns the user to the input box. Plain tool
permission dialogs keep Esc as a soft deny (interrupt unset)."
```

---

### Task 5: Verify the SDK actually aborts on `interrupt: true`

This is the key risk flagged in the spec: the SDK type allows `interrupt: true`, but we must confirm what gets emitted to the message stream (so `plan-status.ts` doesn't leave the PlanCard stuck `pending`).

**Files:** none modified unless a gap is found.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev` (in a terminal; keep it running).

- [ ] **Step 2: Trigger a plan proposal in the browser**

Open the app (the CLI prints the URL; default `http://localhost:3456`). In a session, ask Claude to plan something that invokes `ExitPlanMode` (e.g. "Plan a small refactor of X, use plan mode"). When the plan card / permission dialog appears, click **"Stop & take over"**.

- [ ] **Step 3: Observe the turn ends and the composer reactivates**

Expected: the dialog closes, Claude's turn ends (working indicator stops), the composer is usable again, and the inline PlanCard in the transcript shows `rejected` (not stuck `pending`).

- [ ] **Step 4: If the PlanCard stays `pending` — diagnose and fix**

If the PlanCard is stuck `pending` after "Stop & take over": the SDK likely did not emit a `tool_result` for the aborted `ExitPlanMode` tool_use. Inspect `src/utils/plan-status.ts` — its `getSubagentStarts`/status logic keys off the presence of a tool_result. If none arrives, add handling so an aborted `ExitPlanMode` (turn ended with no result) resolves to `rejected`. Likely fix: in `src/session-store/normalize.ts` or `plan-status.ts`, treat a tool_use whose turn was interrupted as `rejected` when the session's current turn ends. Read `src/utils/plan-status.ts` and `src/session-store/reducer.ts` first to find where turn-end is observed, then add the minimal fix + a unit test in `src/utils/plan-status.test.ts`.

If the PlanCard correctly shows `rejected`, skip this step.

- [ ] **Step 5: Repeat with "Send feedback"**

Trigger another plan proposal. Type "add more tests" in the feedback box, click **"Send feedback"**. Expected: the dialog closes, Claude continues the same turn and re-plans (working indicator stays active), the PlanCard shows `rejected`, and Claude's next message references the feedback. The composer stays disabled during the turn.

- [ ] **Step 6: Verify plain-tool Esc still soft-denies**

Trigger a plain tool permission (e.g. a Bash command in `default` mode). Press Esc. Expected: the dialog closes, the tool is denied, Claude continues the turn (re-plans). No turn abort.

- [ ] **Step 7: Commit any fix from Step 4 (if any)**

```bash
git add <files touched by the plan-status fix>
git commit -m "fix(plan): resolve ExitPlanMode card to rejected on interrupt abort"
```

If no fix was needed, skip.

---

### Task 6: Full quality gates

**Files:** none.

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (both `tsconfig.json` and `tsconfig.node.json`).

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: PASS, no new warnings.

- [ ] **Step 3: Run the full test suite**

Run: `npm run test`
Expected: PASS (server + client).

- [ ] **Step 4: Fix any failures, then re-run until green**

If anything fails, fix and re-run `npm run typecheck && npm run lint && npm run test`. Do not mark the plan complete until all three pass.

- [ ] **Step 5: Final commit if any fixups were made**

```bash
git add -A
git commit -m "chore: quality-gate fixups for plan-feedback-deny"
```

(If nothing changed, skip.)

---

## Self-Review Notes

- **Spec coverage:** All six spec decisions are implemented: (1) Esc=stop → Task 4; (2) empty-feedback disables Send feedback → Task 3 Step 5 (`disabled={busy || feedback.trim().length === 0}`); (3) no separate Keep planning button → Task 3 Step 5 removes it; (4) no image feedback → not implemented (deferred, correct); (5) universal interrupt transparency → Task 1 (broker does not special-case plan); (6) no new transcript status → Task 5 Step 4 only adds handling if the card would stick `pending` (defensive, not a new status).
- **Type consistency:** `interrupt?: boolean` is the field name everywhere — `PermissionDecision`, `PermissionDialog.click`, `Props.onDecide`, the route body, `SessionManager.decide`, `PermissionBroker.decide`. Verified consistent.
- **No placeholders:** every code step shows the actual code. The only conditional branch is Task 5 Step 4 (depends on observed SDK behavior), which gives a concrete diagnostic path and points at the files to read.
