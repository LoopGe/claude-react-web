# Resume: Forbid Adoption on Automatic Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent deleted sessions from being silently resurrected by WS subscribe auto-resume, while keeping soft-delete semantics (transcript stays on disk, explicit picker recovery still works).

**Architecture:** Adoption of disk-only sessions (no `SessionMeta` in our store) becomes explicit-intent-only. `SessionManager.resume()` gains an `allowAdopt` option (default `false`); `doResume` refuses unknown ids with 404 **inside the op lock** instead of falling through to `adoptDiskSession`. The only opt-in is the explicit REST route `POST /sessions/:id/resume`. No client changes, no tombstones, no transcript deletion.

**Tech Stack:** TypeScript, Hono (server routes), Vitest (server unit tests).

**Spec:** Design approved in chat (2026-10-28). Root cause proven from `logs/server-2026-10-28.log` (09:15:49–54): `/resume`-replace's `DELETE X → 200` succeeded, then a late WS subscribe for X auto-resumed it; `doResume` found the store entry removed and re-adopted X's surviving transcript (`adopted disk session … for resume` → `spawn resume=true`), so X reappeared in the sidebar with its app-level config reset (`permissionMode=default`). Approved rule: **automatic paths only act on sessions still present in the store; adoption requires an explicit user action. Deleted = removed from sidebar but recoverable via the resume picker.**

## Global Constraints

- The adoption gate MUST run inside `doResume` under `opLock` — a pre-check in `frame-bridge.ts` is TOCTOU-vulnerable (the delete can complete between the pre-check and lock acquisition). This is the whole point of the fix.
- `delete()` semantics unchanged: store entry + sidecars removed, transcript jsonl kept on disk.
- No new lifecycle state, no tombstones, no client changes, no changes to `/clear` or `fork`.
- Logging through `createLogger`, never bare `console.*`; errors via `HttpError(404, …)` (translated by the router's `onError`).
- No speculative defensive code — only the states proven by the log evidence.
- Every commit is preceded by a review of the full diff (`code-review` skill per CLAUDE.md) and ends with the line `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- Verification commands: `npm run test`, `npm run typecheck` (both tsconfigs), `npm run lint`.

## Review Focus

- **Lock ordering (both directions):** subscribe's `doResume` before delete → session resumes, delete then destroys it (final: deleted). Delete before `doResume` → store lookup misses, no `allowAdopt` → 404 (final: deleted). Pinned by Task 1 Step 1 tests simulating the post-delete state.
- **Explicit recovery preserved:** a disk-only session (deleted or CLI-created) must still be resumable via the explicit route. Pinned by Task 1 Step 1's second test plus the updated orphan-adoption tests in Step 4.
- **Known dormant sessions unaffected:** subscribe auto-resume of store-known dormant sessions must keep working. Pinned by the existing unmodified resume tests (`server/session-manager.test.ts:728` etc.) and `frame-bridge.test.ts` auto-resume tests staying green in Step 5.
- **No retry storm on 404:** the WS hub only re-subscribes on reconnect (documented in `frame-bridge.ts:490-492`), so a refused late subscribe errors once. Verified in Task 2's manual repro (single 404 error frame, no repeated resume attempts in the log).
- **Adoption fixture coverage:** existing tests that exercise adoption by calling `sm.resume('orphan*')` directly must opt in with `allowAdopt: true`, since they model the explicit route. Pinned in Task 1 Step 4.

---

### Task 1: Gate `adoptDiskSession` behind explicit intent in `doResume`

**Files:**
- Modify: `server/session-manager.ts` (`resume()` at :1746, `doResume` adoption fallback at :1793-1799)
- Modify: `server/routes/sessions.ts:472` (POST `/sessions/:id/resume`)
- Test: `server/session-manager.test.ts` (adoption tests at :5556, :5583, :5604, :5625-5626; new tests beside them)

**Interfaces:**
- Consumes: existing `adoptDiskSession(id, provider)` (:2090), `HttpError` (404), the op-locked `doResume`.
- Produces: `resume(id: string, opts?: { permissionMode?: PermissionMode; allowAdopt?: boolean }): Promise<SessionInfo>` — `allowAdopt` defaults to `false`; when `false` and the store has no meta for `id`, `doResume` throws `HttpError(404, \`session ${id} not found\`)` **without** calling `adoptDiskSession`.

- [ ] **Step 1: Write the failing tests**

Add to `server/session-manager.test.ts` near the existing orphan-adoption tests (:5556-5630), reusing their disk-transcript fixture shape (transcript on disk, no store entry — exactly the post-delete state):

```ts
it('resume() without allowAdopt refuses disk-only sessions (deleted / unknown) instead of adopting them', async () => {
  // Same on-disk orphan fixture as the 'orphan' adoption test at :5556.
  await expect(sm.resume('orphan')).rejects.toMatchObject({ status: 404 })
  // Nothing was registered or spawned: the id must not reappear.
  expect(sm.list().some((s) => s.id === 'orphan')).toBe(false)
})

it('resume() after delete() does not resurrect the deleted session', async () => {
  // Create + real transcript (reuse the deleteOriginal fixture at :9187), then sm.delete(id).
  await expect(sm.resume(id)).rejects.toMatchObject({ status: 404 })
  expect(sm.list().some((s) => s.id === id)).toBe(false)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/session-manager.test.ts -t "without allowAdopt"`
Expected: FAIL — today `resume('orphan')` adopts the disk transcript and returns a live session (this is the bug being pinned).

- [ ] **Step 3: Implement the gate**

In `server/session-manager.ts`:
1. Widen the signature to `resume(id: string, opts?: { permissionMode?: PermissionMode; allowAdopt?: boolean })` and thread `opts` through to `doResume` (same object, both call sites :1760 and the `doResume` signature :1769).
2. Replace the adoption fallback at :1798 with an explicit branch:

```ts
let meta = this.store.get(id)
if (!meta) {
  // Adoption = creating a tracked identity from a disk-only session. Restrict
  // it to explicit user intent (POST /resume). Automatic paths (WS subscribe
  // auto-resume) must NOT resurrect a session whose store entry was removed —
  // e.g. /resume-replace's delete — otherwise the deleted session reappears
  // in the sidebar (observed: DELETE 200, then subscribe re-adopted the
  // surviving transcript and re-spawned it). This check runs under opLock,
  // so a delete racing this resume is serialized before the lookup.
  if (!opts?.allowAdopt) throw new HttpError(404, `session ${id} not found`)
  meta = await this.adoptDiskSession(id, this.defaultProvider)
}
if (!meta) throw new HttpError(404, `session ${id} not found`)
```

In `server/routes/sessions.ts:472`, opt the explicit route in:
`const info = await sm.resume(c.req.param('id'), { permissionMode: mode, allowAdopt: true })`

- [ ] **Step 4: Update the existing adoption tests to opt in**

The direct-manager tests modeling the explicit route must pass the flag: `sm.resume('orphan')` (:5556), `sm.resume('orphan-titled')` (:5583), `sm.resume('orphan-cli')` (:5604), and both `sm.resume('orphan')` calls in the coalescing test (:5625-5626) become `sm.resume(<id>, { allowAdopt: true })`. The `sm.resume('ghost')` 404 test (:5613) needs no change (unknown + no transcript still 404s). No other `sm.resume(info.id)` call sites change — they use store-known sessions.

- [ ] **Step 5: Run the full verification suite**

Run: `npx vitest run server/session-manager.test.ts server/frame-bridge.test.ts` → all PASS (new guard tests, updated adoption tests, and every pre-existing resume/auto-resume test).
Then: `npm run typecheck` and `npm run lint` → clean.

- [ ] **Step 6: Review the diff, then commit**

Run the `code-review` skill on `git diff HEAD`; verify each finding against the code and fix confirmed issues before committing.

```bash
git add server/session-manager.ts server/routes/sessions.ts server/session-manager.test.ts
git commit -m "fix(resume): only adopt disk sessions on explicit resume, never on WS subscribe auto-resume"
```

### Task 2: End-to-end verification of the original incident scenario

**Files:** none (manual verification against the dev server, `LOG_LEVEL=info`).

**Interfaces:**
- Consumes: Task 1's gated `doResume` and the opted-in POST route.

- [ ] **Step 1: Reproduce the original /resume-replace flow**

With the dev server running at info logging: open panel with session X, type `/resume`, pick a different session Y. Expected in the log: `POST /api/sessions/Y/resume → 200`, `DELETE /api/sessions/X → 200`, and **no** `adopted disk session` line for X afterwards; any late subscribe for X produces a single 404 error (`session X not found`), not a spawn.

- [ ] **Step 2: Confirm the UI end state**

Sidebar shows Y only — X does not reappear, no repeated 404 spam in the log (hub re-subscribes only on reconnect).

- [ ] **Step 3: Confirm explicit recovery still works**

Open the resume picker, explicitly pick X (its transcript survived deletion). Expected: X is adopted and resumed (`adopted disk session … for resume` + `spawn resume=true` appear for X), opens in a panel. This is the intended soft-delete recovery path.

- [ ] **Step 4: Full-suite pass**

Run: `npm run test` → all PASS. If anything unrelated regressed, return to Task 1 rather than patching here.
