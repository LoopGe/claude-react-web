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
hidden for dormant / terminated. Dormant rows dim and show a moon corner badge,
distinct from terminated (greyed).

**Panel header** (`Chat` header): sleep button alongside the existing gear /
inline chips when the focused session is idle; same handler as the sidebar.

**`DormantOverlay`** (`src/components/DormantOverlay.tsx`, new): when the
focused session's `phase === 'dormant'`, render a translucent overlay **on top
of the preserved transcript**: "此会话已休眠以释放资源 · 点击恢复". Click →
existing `resumeSession(id)` flow (`App.tsx:1642`). On resume the server
broadcasts `session-update` with `phase` leaving `'dormant'`; the overlay
auto-dismisses. Composer send is disabled in overlay state — the user must
click the overlay to resume first (avoids a race between resume-spawn and an
enqueued message).

**Transition detail:** `useChatStream`'s per-session subscription stops
receiving frames after dormant (server `endAllSubscribers`), but the shared hub
WS connection stays open — no false "connection lost". Verify `useChatStream`
resets `activePhase` / hides `WorkingBubble` on `phase → 'dormant'` so no stale
"Working" lingers. The client `session-store` cache is **not cleared**; it
serves as the read-only transcript under the overlay. On resume the server
re-seeds from disk and the existing resume-replay overlap dedup handles
duplicates.

### Data flow

```
user clicks sleep (idle session)
  → POST /sessions/:id/sleep
  → sm.sleep(id): phaseOf=='idle' ✓ → unload(id)
      handle.destroy(); denyAll(); cancelGitBroadcast();
      stopBackgroundSubagentWatchers(); endAllSubscribers();
      sessions.delete(id); writeStore(s)
      broadcastGlobal update{running:false, phase:'dormant'}
  → client receives session-update → focused panel renders DormantOverlay
    (transcript preserved); sidebar row dims + moon badge

user clicks overlay (or selects the row again)
  → POST /sessions/:id/resume (existing)
  → sm.resume: spawn(resume:id) + re-seed history + broadcast update{running:true}
  → overlay dismisses, transcript continues
```

## Error handling

- **Sleep while working:** 409; button already disabled client-side, toast兜底
  "等当前回合结束".
- **Sleep already-dormant / not live:** 409; client doesn't render the button
  for non-idle, ignore兜底.
- **Resume finds transcript missing:** existing path (`markTranscriptMissing` →
  410 → marked terminated); overlay transitions to a terminated notice.
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
5. `sleep` denies pending permissions and stops background-subagent watchers
   (verify `denyAll` + `stopBackgroundSubagentWatchers` are invoked / pending
   map is empty after).

**Client** (`session-store` + component tests):

1. Focused session `phase → 'dormant'`: `DormantOverlay` appears and the cached
   transcript is preserved.
2. After resume (`phase` leaves dormant): overlay dismisses.
3. Sleep button disabled when `phase === 'working'`.
