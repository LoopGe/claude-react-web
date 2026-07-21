# Session Dormant (Sleep) — Design

## Goal

Give the user a manual entry point to move an idle session into the dormant
state: kill the SDK subprocess, release the pump / WS subscribers / pending
permission map / git-broadcast timers / background-subagent watchers, but keep
the on-disk metadata and transcript intact so the session can be resumed later.

This is distinct from `DELETE /sessions/:id` (which marks `terminated` and
removes the store entry — unrecoverable). Dormant is reversible.

## Scope

- **Manual, per-session only.** A "sleep" affordance on each session.
- No bulk "sleep all idle", no idle-timeout auto-sleep. (CLAUDE.md explicitly
  notes idle sessions are no longer auto-unloaded by design; we honor that and
  only add an explicit user action.)
- Only idle sessions can be slept. Working / pending-permission / queued-input
  sessions are rejected with 409.

## Background: dormant already exists internally

`SessionManager.unload(id)` without `{ terminated: true }` IS the dormant
transition (`server/session-manager.ts:2805`):

- `s.handle.destroy()` — kills the SDK subprocess (the heavy resource).
- `endAllSubscribers(s)` — closes per-session WS subscriber queues.
- `permBroker.denyAll(s)`, `cancelGitBroadcast(id)`,
  `stopBackgroundSubagentWatchers(id)` — clears pending perms, timers, watchers.
- `this.sessions.delete(id)` — removes from the live pool.
- `writeStore(s)` — persists `SessionMeta` to disk (`terminated: false`).
- Broadcasts `session-update` with `running:false, phase:'dormant'`.

Resume already exists: `POST /sessions/:id/resume` → `sm.resume(id)` re-spawns
the Query with `resume: id`, re-seeds the history ring from disk, re-applies
MCP/plugins/hooks. The client already auto-resumes dormant sessions on select
(`App.tsx:1753`) and the resume-replay reconciliation handles overlap with the
client's cached transcript (`session-store/reducer.test.ts:2049`).

**What's missing today:** no public endpoint triggers the non-terminated
`unload`. `unload()` is private; the only user-facing teardown is
`DELETE /sessions/:id` → `sm.delete()` → `unload({terminated:true})` +
`store.remove()` + `removed` broadcast. So dormant only arises passively
(server restart / spawn-failed / `/clear` / GC force-unload), never from an
explicit "put to sleep" action.

## Design (Approach A: reuse the existing dormant path)

### Server

**`SessionManager.sleep(id: string): Promise<SessionInfo>`** (new public method,
`session-manager.ts`):

1. `requireLive(id)` — throws `HttpError(409, 'session is already dormant or not live')`
   if not in the live map.
2. `if (this.phaseOf(s) !== 'idle') throw new HttpError(409, 'session is working — wait for the turn to finish')`.
   `phaseOf` returns `'working'` for `clearing` / `pendingTurns > 0` /
   `queueDepth > 0` / `pending.size > 0`, so a single guard covers every
   mid-turn race.
3. `await this.unload(id)` — no `terminated`, no `removeFromStore`. Reuses the
   existing dormant path verbatim.
4. Return `this.get(id)` (dormant info via `infoFromMeta`).

No new WS frame kind. No new persistence field. No GC change. Side Chats
(`parentId` set) are allowed to sleep — `parentId` is persisted on the meta and
resume restores the Side-Chat system prompt; `session-health.ts` only scans the
live map so dormant side chats are invisible to it.

**Route** (`server/routes/sessions.ts`): `POST /sessions/:id/sleep` →
`const session = await sm.sleep(c.req.param('id')); return c.json({ session })`.

### Client

**API** (`src/hooks/useApi.ts`): `sleepSession(id)` → `POST /sessions/:id/sleep`.

**Sidebar** (`src/components/SessionList.tsx` + `SessionCard`): new `onSleep`
prop threaded next to `onDelete`. A moon-icon button on each card, enabled only
when `phase === 'idle'`; disabled with tooltip "等当前回合结束" when working;
hidden for dormant / terminated. The sidebar context menu
(`SessionContextMenu`) also gains a "Sleep (release resources)" item (idle-only,
disabled otherwise). Dormant rows already dim via the existing `dormant` class
+ status chip; no new badge needed (the status label already reads "dormant").

**Panel transition (focused session slept):** `ChatPanel` already renders a
dormant empty-state when `!session.running && !session.terminated`
("Session is dormant — Click the session again in the sidebar to resume it.").
Sleep flips `running:false, phase:'dormant'`, so the focused panel transitions
to this existing empty-state automatically — consistent with every other
dormant transition (server restart, spawn-fail, GC). We add a **"Resume"
button** to that empty-state (threaded `onResume` from App's `resumeSession`)
so the user can wake the session directly from the panel without going to the
sidebar.

> Deviation from the original "preserve history + overlay" preference: keeping
> `<Chat>` mounted across the dormant boundary (to preserve the live transcript
> under an overlay) would run Chat's hooks (recap auto-gen, context-usage
> polling, mcp-status) on a dormant session — paths that today never execute
> for dormant sessions and risk regressing the working dormant flow. Reusing
> the established empty-state is consistent and low-risk; on resume the server
> re-seeds the transcript from disk (the existing replay path), so history
> returns without a separate persistence mechanism. A live-history overlay can
> be layered on later as a focused follow-up if desired.

No new `DormantOverlay` component, no panel-header sleep button (the sidebar
card + context menu already provide one affordance per session).

### Data flow

```
user clicks sleep (idle session)
  → POST /sessions/:id/sleep
  → sm.sleep(id): phaseOf=='idle' ✓ → unload(id)
      handle.destroy(); denyAll(); cancelGitBroadcast();
      stopBackgroundSubagentWatchers(); endAllSubscribers();
      sessions.delete(id); writeStore(s)
      broadcastGlobal update{running:false, phase:'dormant'}
  → client receives session-update → focused panel transitions to the existing
    dormant empty-state (with a Resume button); sidebar status chip reads "dormant"

user clicks Resume in the panel (or selects the row in the sidebar)
  → POST /sessions/:id/resume (existing)
  → sm.resume: spawn(resume:id) + re-seed history + broadcast update{running:true}
  → panel re-renders <Chat>, transcript re-seeded from disk
```

## Error handling

- **Sleep while working:** 409; button already disabled client-side, toast兜底
  "等当前回合结束".
- **Sleep already-dormant / not live:** `requireLive` throws 404 (the session
  isn't in the live map); client doesn't render the button for non-idle, ignore
  兜底.
- **Resume finds transcript missing:** existing path (`markTranscriptMissing` →
  410 → marked terminated); the panel's empty-state shows the terminated branch.
- **Session deleted/GC'd concurrently with sleep:** `requireLive` 404; client
  ignores.

## Testing

**Server** (`server/session-manager.test.ts`):

1. Idle session: after `sleep`, `sessions.has(id) === false`,
   `store.get(id).terminated === false`, `info.phase === 'dormant'`; on-disk
   transcript file untouched.
2. Working session (`pendingTurns > 0`): `sleep` throws 409.
3. Already-dormant session: `sleep` throws 409.
4. After `sleep`, `resume(id)` re-enters the live map and the history ring is
   seeded from disk.

Note: a "sleep clears pending permissions" test is impossible by design —
the idle guard rejects any session with `pending.size > 0` (phaseOf returns
`'working'`), so `sleep` never reaches `unload` with pending perms. The
`unload` deny-all path itself is already covered by the `delete()` tests.
Likewise background-subagent watchers only exist while a parent turn is in
flight (phase `'working'`), so they're also rejected by the guard.

**Client** (component tests):

1. `SessionCard` renders the sleep button when `phase === 'idle'`; disables it
   (with hint) when `phase === 'working'`; hides it for dormant / terminated.
2. `SessionContextMenu` "Sleep" item is disabled unless `phase === 'idle'`.
3. The dormant empty-state in `ChatPanel` shows a Resume button that calls
   `onResume` (covered by a render + click test).
