# Clear Preserves Pre-Clear Conversation — Design Spec

**Date:** 2026-07-01
**Status:** Draft (pending review)
**Related research:** `server/session-manager.ts` `clear()` (L1412), SDK `listSessions` / `--resume` semantics, prior commit `4ac8e8c fix(clear): delete transcript file before respawn`

## Problem

`/clear` is destructive and irreversible. `SessionManager.clear()` does three things that each destroy the pre-clear conversation P1:

1. `await deleteTranscriptFile(s.id)` (L1496) — `unlink`s `~/.claude/projects/<cwd>/<id>.jsonl`, the only source the SDK's `--resume <id>` can read.
2. `s.history = []` (L1501) — wipes the in-memory history ring.
3. Broadcasts `session-cleared` → client `useChatStream.ts:309` calls `store.clearPersisted()`, erasing the IDB cache, and sets `clearedRef` to block reverse-paging.

After `/clear`, P1 exists nowhere. The user cannot resume P1 into a new panel — `listSessions()` finds no transcript for it, so it never appears in the Ctrl+Shift+O resume picker. The only reason: `clear()` reuses session id X **and** deletes X's transcript, so P1 has no surviving copy under any id.

This is the user's reported symptom: "I /clear'd, regretted it, and want to resume the pre-clear conversation in a new session — there's no direct way."

## Goal

Make `/clear` non-destructive of P1: the pre-clear conversation survives as a first-class **resumable session** the user can pick in the resume dialog and load into a new panel. The cleared tab gets a fresh conversation. Both coexist.

Concretely: after `/clear` on session X, the resume picker lists P1 (the pre-clear conversation) as its own entry, and resuming it opens P1 in a new panel with full context intact.

## Non-Goals (YAGNI — deferred)

- An "undo clear" affordance that reverts the cleared tab back to P1 in place. (The resume picker already covers recovery; in-place undo is a separate UX.)
- A grace window / time-limited recovery. (P1 is preserved indefinitely as a dormant session, same as any other past session.)
- Preserving P1 when the user **deletes** a session from the sidebar. (Delete is an explicit destroy; clear is not.)
- Changing `/clear` semantics for Side Chats (they have `parentId` and are ephemeral; out of scope for v1).

## Root Cause (confirmed)

The resume picker is backed by the SDK's `listSessions()`, which scans `~/.claude/projects/*/*.jsonl` — one entry per file, keyed by the `<id>.jsonl` filename. `clear()` reuses id X and deletes X's file, so:

- P1's transcript is gone (no file → not listed).
- The fresh post-clear conversation writes a new file under the same id X.
- The resume list shows at most one entry for X (post-clear content). P1 is unrecoverable.

Empirically confirmed: a cleared session WITH a post-clear message DOES appear in `listSessions()` under the same id (e.g. session `8fd9a221` shows its post-clear firstPrompt). What's lost is P1, not the post-clear conversation.

## Decision

**`/clear` mints a new session id for the cleared (fresh) conversation and leaves the pre-clear conversation's transcript + meta intact under the original id as a dormant, resumable session.**

Mental model: `/clear` becomes "unload X as dormant + create a fresh session Y in the same tab with the same settings." X keeps its transcript file and sessions.json entry; Y is a brand-new `create()`. This mirrors how the `claude` CLI treats `/clear` (a new session) and aligns with the existing `fork()` / `create()` spawn paths.

### Why this over backup-and-restore

A backup-restore design (copy `<id>.jsonl` to a sidecar before `unlink`, add a restore endpoint + UI) was rejected:
- It invents a parallel "backup" concept that isn't a first-class session — P1 wouldn't naturally appear in the resume picker; it'd need a separate restore affordance + grace window.
- Design 1 makes P1 a normal dormant session for free: the sidebar, resume picker, history pagination, search, and recap all work on it unchanged.
- No new API surface or UI affordance — just the clear() rewrite + a client id-swap.

## Architecture

### Server: `SessionManager.clear(id)` rewrite

Current flow (L1412–1592): tear down Query → `deleteTranscriptFile` → wipe `s.history` → respawn same-id fresh → broadcast `session-cleared`.

New flow:

```
clear(id):
  s = requireRunnable(id)
  if s.clearing: return info(s)            // idempotency preserved

  // 1. Capture the settings to clone into the fresh session.
  settings = { cwd, model, permissionMode, title, betas, effortLevel,
               hooks, fastMode, enabledPlugins, mcpServerNames, parentId?,
               skillOverride } from s

  // 2. Detach X as dormant — do NOT delete its transcript, do NOT wipe its
  //    sessions.json entry. Destroy its live Query (so the subprocess exits
  //    and releases the file handle), mark it not-running, persist.
  permBroker.denyAll(s)
  ... (existing interrupt + drain + destroy + await-processExit) ...
  // NO deleteTranscriptFile(s.id)
  s.running = false
  // history ring + recap stay as-is — they're the dormant session's
  // last-known state; resume() will re-read from disk anyway.
  this.persist(s)                          // X stays in sessions.json, resumable
  this.broadcastGlobal({ kind: 'update', session: info(s) })  // sidebar dims to dormant

  // 3. Create a fresh session Y under a new id, same settings, no resume.
  freshOpts = buildOptsFrom(settings)      // mirrors current L1529–1544
  const newY = this.spawn(randomUUID(), freshOpts, ...)   // reuse create()/spawn() path

  // 4. Return Y. The client swaps the panel from X to Y (see below).
  return info(newY)                        // { id: Y, ... }
```

Key changes vs current:
- **Remove `deleteTranscriptFile(s.id)`** (L1496). X's transcript survives.
- **Remove `s.history = []` / state-wipe block** (L1501–1521). X keeps its history as a dormant session; Y starts empty via `spawn()`.
- **Remove `s.captureNextInitAsClearBoundary = true`** and the `clearBoundaryUuid` capture. With separate ids there is no boundary. (See Cleanup.)
- **`spawn(randomUUID(), ...)` instead of reusing `s.id`** — Y is a normal fresh session.
- The Side Chat `parentId` case: if `s.parentId`, Y inherits `parentId` + `SIDE_DEVELOPER_INSTRUCTIONS` exactly as today (L1538–1544), so a cleared Side Chat stays a Side Chat.

### Server: route

`POST /sessions/:id/clear` (`server/routes/sessions.ts:229`) is unchanged in shape — it returns `{ session: <info> }`. The returned session now has a **different id** (Y). The client detects the id change and swaps. No new route, no new frame.

(X also stays in the session list via the normal `session-update` broadcast from step 2; the sidebar shows it as dormant. No `session-removed`.)

### Client: panel id-swap on clear

`src/local-commands.ts` `clear` → `ctx.clearSession(sessionId)` → `POST /sessions/:id/clear`. Today the handler awaits `session-cleared` and resets X's transcript store. New behavior:

1. POST returns `{ session: Y }`.
2. Client swaps the panel's session id from X to Y **at the same slot** in `openIds` / panel state (App.tsx). The Chat component for X unmounts; a fresh Chat for Y mounts (empty transcript — exactly the "/clear" visual).
3. X remains in the sidebar (dormant), courtesy of the server's `session-update` broadcast. Its transcript store / IDB cache stay associated with X for when the user reopens it.
4. WS: unsubscribe from X's message channel, subscribe to Y's. (X's permission channel subscriptions can stay or be torn down — X has no live turn.)
5. The `session-cleared` frame (L289–314) is **no longer triggered by `clear()`** (Y is a fresh session with no pre-clear content to block from reverse-paging). However, the frame still has a second producer — the SDK's own in-band `cleared` control event, forwarded at `server/ws.ts:459` — so the client handler **must stay** to handle SDK-emitted clears. Only `clear()` stops emitting it. (See Cleanup.)

To recover P1: open Ctrl+Shift+O → P1 appears under id X (its pre-clear firstPrompt) → pick it → `resumeSession(X)` opens P1 in a new panel. Standard resume flow, unchanged.

### Cleanup (now-dead machinery)

With separate ids, the `clearBoundaryUuid` concept is fully moot (it already was after `4ac8e8c`, but capture was "harmless and kept"). This change lets us delete:
- `SessionMeta.clearBoundaryUuid` field + `coerceMeta` read (`server/persistence.ts:66, 181`).
- `SessionState.clearBoundaryUuid` + `captureNextInitAsClearBoundary` (`server/session-types.ts:181`, `server/session-pump.ts:416–426`).
- The `afterUuid: clearBoundaryUuid` plumbing in `getHistoryPage` / `searchMessages` (`server/session-manager.ts:2609, 2634`).
- Client `clearedRef` reverse-page block + the `session-cleared`-on-clear path (`src/hooks/useChatStream.ts:289–314`) — but **keep the frame handler itself**, since `server/ws.ts:459` still forwards the SDK's own `cleared` control event. Only the `clear()`→`broadcastSessionCleared` call (L1584) is removed.
- The stale comment at `useChatStream.ts:311` ("on-disk transcript still holds the pre-clear messages") — wrong since `4ac8e8c`.

`coerceMeta` already tolerates missing fields, so dropping `clearBoundaryUuid` from new writes needs no migration; old `sessions.json` entries with the field are simply ignored.

## Implementation Surface

**Server**
- `server/session-manager.ts` — `clear()` rewrite (L1412–1592); remove `deleteTranscriptFile` import usage in clear (keep the export — `delete()` route may still use it).
- `server/session-pump.ts` — remove `captureNextInitAsClearBoundary` capture block (L405–426).
- `server/session-types.ts` / `server/persistence.ts` — drop `clearBoundaryUuid` / `captureNextInitAsClearBoundary` fields.
- `server/session-manager.ts` `getHistoryPage` / `searchMessages` — drop `afterUuid` clear-boundary threading.
- `server/session-manager.test.ts` — update `clear()` tests (L406–500, L1572): assert (a) a new id is returned, (b) X's transcript file still exists post-clear, (c) X is resumable via `listResumable`, (d) Y is a fresh empty session.

**Client**
- `src/App.tsx` — `clearSession` handler: swap panel id X→Y on response; keep X in sidebar.
- `src/hooks/useChatStream.ts` — remove `session-cleared`-on-clear handling + `clearedRef` block (or repurpose; verify no other producer emits `session-cleared`).
- `src/session-store/` — ensure transcript store keys by session id so X's cache is preserved and Y starts empty (likely already the case).
- `src/local-commands.ts` — `clear` command description unchanged; behavior flows from the handler.

**Manual verification**
- `/clear` a session with history → resume picker shows the pre-clear conversation as a separate entry → resume it into a new panel → context intact.
- `/clear` a session, send a post-clear message → both pre-clear (old id) and post-clear (new id) appear as separate resume entries.
- Sidebar: cleared tab shows the fresh conversation; the pre-clear session appears dormant.
- Side Chat `/clear` still carries `parentId` + boundary prompt.
- Restart server → both sessions still resumable from disk.

## Alternatives Considered

1. **Backup-and-restore** (copy transcript before delete + restore endpoint). Rejected — see "Why this over backup-and-restore" above.
2. **Re-id the pre-clear transcript** (rename `<X>.jsonl` to `<Z>.jsonl`, create dormant meta for Z, respawn X fresh). Avoids the client id-swap (tab stays X), but: (a) requires rewriting or renaming the transcript and creating a synthetic meta, (b) uncertain whether the SDK tolerates a transcript whose internal `sessionId` fields don't match the filename (needs verification), (c) still needs a sessions.json entry for Z. Rejected in favor of Design 1's cleaner "each conversation has its own id naturally."
3. **Keep current behavior, document irreversibility.** Rejected — the user explicitly wants recovery, and the fix is localized.

## Open Questions

- **Q1:** Does the client panel-state model support swapping a session id in place at a fixed slot, or does it require a close-X-then-open-Y dance? Need to read `App.tsx` panel/openIds management to confirm the swap is a one-line replace vs. a remount sequence. (Doesn't change the design, only the impl effort.)
- **Q2 (resolved):** `session-cleared` has a second producer — the SDK's in-band `cleared` control event forwarded at `server/ws.ts:459`. The client handler stays; only `clear()` stops emitting. ✅
- **Q3:** Should the pre-clear session X be auto-deduped/hidden from the sidebar if it has no completed turns (e.g. cleared before any message)? Edge case: clearing an empty session produces a dormant empty X — probably fine to show, but confirm UX.
