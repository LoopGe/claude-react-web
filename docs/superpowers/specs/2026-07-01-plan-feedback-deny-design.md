# Plan Feedback Deny — Design Spec

**Date:** 2026-07-01
**Status:** Approved (pending implementation)
**Related research:** CLI `ExitPlanModePermissionRequest` UX in `D:\codes\claude-code`

## Problem

When Claude proposes a plan (`ExitPlanMode`), the web UI's plan card offers three
"Approve" buttons and a single "Keep planning" button. "Keep planning" always
resolves the permission with `interrupt: false`, so Claude continues planning in
the **same turn**. There is no way to say "stop the turn — I'll type my own
message." Users must click "Keep planning" then chase the Stop button.

The claude-code CLI solves this with a single feedback input field whose
**presence or absence of typed feedback** selects the behavior:
- typed feedback + Enter → `interrupt: false` (model re-plans with the feedback)
- empty + Esc → abort the turn (user gets the input box back)

This spec ports that UX to the web UI.

## Goal

Replace the plan dialog's "Keep planning" button with a feedback input field
plus two explicit deny actions, and thread an optional `interrupt` flag through
the full deny path so a plan deny can end the turn instead of always
re-planning.

## Non-Goals (YAGNI — deferred)

- Pasting images as deny feedback
- Shift+Tab "approve with feedback"
- A distinct `stopped` transcript status (deny + interrupt still shows as `rejected`)
- Ultraplan / external-editor (Ctrl+G) options

## Decisions (confirmed with user)

1. **Esc in the plan dialog = stop the turn** (`deny` + `interrupt: true`), aligning
   with the CLI. This flips current behavior (Esc = Keep planning). Plain tool
   permission dialogs keep Esc = `deny` (interrupt unset → false).
2. **Empty feedback disables the "Send feedback" button**, mirroring the CLI's
   early-return. The user must type or use "Stop & take over".
3. **No separate "Keep planning" button.** Two deny actions only: "Send feedback"
  (with text, re-plans) and "Stop & take over" (aborts turn).
4. **No image feedback in v1.**
5. **`interrupt` transparency is universal** — the broker does not special-case
   plan tools. Only the plan dialog front-end sends `interrupt: true`.
6. **No new transcript status.** `deny` + `interrupt: true` still renders as
   `rejected` in `plan-status.ts`. (Implementation must verify what the SDK
   emits on `interrupt: true` and adjust if the pending status would stick.)

## Architecture

```
PermissionDialog (feedback state)
  → onDecide({ behavior:'deny', message?: feedback, interrupt?: true })
  → usePermissionChannel.decide()
  → POST /sessions/:id/permissions/:pid/decide
  → server/routes/permissions.ts        (reads + passes through `interrupt`)
  → PermissionBroker.decide()           → SDK PermissionResult { behavior:'deny', message, interrupt }
  → SDK Query                           → interrupt:false: model re-plans
                                          interrupt:true:  turn aborted
```

The SDK's `PermissionResult` deny variant natively supports
`interrupt?: boolean` (`@anthropic-ai/claude-agent-sdk` `sdk.d.ts:2023-2029`).
`interrupt: true` aborts the whole turn — equivalent to the CLI's
`abortController.abort()`. No manual `/interrupt` call is needed.

## Changes by Layer

### Backend

**`server/routes/permissions.ts`** (`POST /sessions/:id/permissions/:pid/decide`)
- Extend the parsed body type with `interrupt: unknown`.
- In the `behavior === 'deny'` branch, pass
  `interrupt: typeof raw.interrupt === 'boolean' ? raw.interrupt : undefined`
  into `sm.decide(...)`.

**`server/permission-broker.ts`** (`PermissionBroker.decide`)
- Widen the `decision` parameter's deny variant to
  `{ behavior: 'deny'; message?: string; interrupt?: boolean }`.
- Line ~545: change `interrupt: false` to `interrupt: decision.interrupt ?? false`.
  The default `?? false` preserves the existing behavior for every caller that
  does not set `interrupt` (all plain tool-permission denies, session-cleanup
  denies, question denies).

The broker does **not** special-case plan tools. The flag is generic; only the
plan dialog front-end chooses to send `interrupt: true`.

### Frontend types

**`src/hooks/usePermissionChannel.ts`**
- Widen `PermissionDecision` deny variant to
  `{ behavior: 'deny'; message?: string; interrupt?: boolean }`.

### Frontend UI

**`src/components/PermissionDialog.tsx`** (the only meaningful UI work)

In the `isPlanRequest` branch, replace the single "Keep planning" button block
with:

- A controlled `<textarea>` (or input) bound to a `feedback` state,
  `placeholder="Tell Claude what to change"`. Auto-focus when the dialog opens
  for plan requests.
- A **"Send feedback"** button (primary-ish styling):
  - Disabled when `feedback.trim()` is empty.
  - On click: `click({ behavior: 'deny', message: feedback })` — `interrupt`
    unset → false → model re-plans with the feedback as the deny message.
- A **"Stop & take over"** button (danger styling):
  - On click: `click({ behavior: 'deny', interrupt: true })` — no message; the
    SDK aborts the turn and the user gets the composer back.
- Updated footer hint explaining the two actions.

**Esc key handling** (currently lines 73–85, which map Esc → `click({ behavior: 'deny' })`):
- For plan requests: Esc → `click({ behavior: 'deny', interrupt: true })`
  (aligns with CLI; "stop the turn").
- For plain tool-permission requests: Esc → `click({ behavior: 'deny' })`
  (unchanged; interrupt unset → false).

The plain tool-permission dialog (Allow once / Allow + suggestions / Deny) is
**not changed**.

### Status rendering

`src/utils/plan-status.ts` and `PlanCard` are not changed for v1. A deny —
whether `interrupt: true` or `false` — still resolves to `rejected`. The
implementation must verify what the SDK emits on `interrupt: true`; if no
`tool_result` lands (so `plan-status.ts` would leave the card `pending`), the
pump/session layer must treat the abort as a terminal state. This is the key
implementation-time verification step.

## Error Handling & Edge Cases

- **Optimistic update unchanged.** `usePermissionChannel.optimisticPost` already
  closes the dialog immediately and re-fetches on POST failure. The new
  `interrupt` field rides along in the body with no special handling.
- **Unknown / missing `interrupt`.** Broker defaults to `false` via `?? false`.
  A malformed client payload cannot accidentally abort a turn.
- **Session deleted with pending permissions.** Existing cleanup path
  (line ~597) denies with `interrupt: false` and `message: 'session closed'`.
  Unchanged.
- **Subagents.** Out of scope; plan proposals are top-level. The CLI's
  `!sub` guard is not ported because the web UI's plan dialog only appears for
  top-level `ExitPlanMode`.

## Testing

**`src/components/PermissionDialog.test.tsx`** — extend the existing plan-approval
suite:
- Renders a feedback input and two deny buttons (Send feedback / Stop & take over).
- "Send feedback" is disabled when the input is empty.
- Typing feedback + clicking "Send feedback" → `onDecide` receives
  `{ behavior: 'deny', message: <text> }` with no `interrupt`.
- Clicking "Stop & take over" → `onDecide` receives
  `{ behavior: 'deny', interrupt: true }`.
- Pressing Esc in a plan dialog → `onDecide` receives
  `{ behavior: 'deny', interrupt: true }`.
- Pressing Esc in a plain tool-permission dialog → `onDecide` receives
  `{ behavior: 'deny' }` with no `interrupt` (regression guard).

**Backend** — if a broker/route unit test exists, add a case asserting
`interrupt: true` is threaded through to the resolved `PermissionResult`;
otherwise add a minimal test.

**Quality gates:** `npm run typecheck && npm run test && npm run lint` all green.

## Implementation Risks

1. **SDK `interrupt: true` emission** — must be verified early. If the SDK does
   not emit a `tool_result` for an aborted deny, the `PlanCard` may stay
   `pending`. Mitigation: drive a real session, observe the stream, adjust
   `plan-status.ts` / pump if needed.
2. **Esc muscle memory** — flipping Esc semantics for plan dialogs changes
   existing user behavior. Accepted by design decision (aligns with CLI).

## Out of Scope

- Image feedback, Shift+Tab approve-with-feedback, Ultraplan, Ctrl+G editor,
  `stopped` transcript status (all deferred).
