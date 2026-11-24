# Update Check Subsystem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running web server or desktop app discovers new releases automatically (12 h default cadence) and notifies through three explicit choices — Update / Remind me later / Skip this version — with no ✕ on the nag and no hidden persistence.

**Architecture:** A generic completion-based scheduler (DSH semantics: backoff ×2 capped, ±20% jitter, monotonic clock, coalescing) runs in two instances — server process (npm channel) and Electron main (electron-updater channel). Every meaningful checker-snapshot mutation publishes through one hub that fans out over a new always-on global WS frame `update-info`; the client merges frames into `useUpdateInfo` with a `checkedAt` staleness fence. The nag toast gains a generic multi-action + hide-dismiss extension; "Remind me later" writes nothing (per-mount dedup only), "Skip this version" owns the persistent dismissal. Desktop offers go through a dedup/skip state machine with a persisted skip list; install stays user-confirmed everywhere.

**Tech Stack:** TypeScript, Hono, existing WS hub (`shared/ws-protocol.ts` generics + `createAsyncSubscription`), React 19 hooks, electron-updater, vitest (fake timers + injected clock/random).

**Spec:** `docs/superpowers/specs/2026-11-24-update-check-subsystem-design.md`

## Global Constraints

- `server/config.ts` reads NO `process.env`; interval is `config.json` `updateCheckIntervalMs`, default `43_200_000` (12 h), explicit `0` disables periodic checking (startup + manual unaffected), nonzero < `60_000` clamps to `60_000`.
- Scheduler: completion-based deadline; failure delay ×2 capped at `maxBackoffMs = max(4 × intervalMs, 3_600_000)`; jitter ±20% uniform; `performance.now()` monotonic.
- Meaningful-change keys (exact list): `latest`, `deprecated`, `error`, `updateAppliedToDisk`, `disabled`.
- Nag three-state: **Update** writes nothing; **Remind me later** writes nothing (per-mount dedup only); **Skip this version** writes the existing localStorage dismiss key. Nag toast has NO ✕. Dialog close writes nothing; dialog has an explicit Skip button (nag modes only).
- Desktop: `autoDownload = false`, `autoInstallOnAppQuit = true`, enabled gate unchanged. Download failure clears in-memory dedup (re-offer); explicit Skip persists across restarts; periodic checks skip while download/dialog live.
- Diagnostic logging via `createLogger(scope)` only. Canonical WS frames in `shared/ws-protocol.ts` + both alias files. Probes never throw; no speculative defensive code. CSS via theme variables, both themes (reuse `.toast-action`).
- `npm run typecheck` (both tsconfigs), `npm run test`, `npm run lint` pass; full-diff code review before every commit (CLAUDE.md gate). No new dependencies.

## Review Focus

- **Nag persistence semantics** (a wrong write silences forever or nags forever): Remind me later / dialog close / Update click write NOTHING and re-nag on the next mount; Skip writes the key and never re-nags that version; a newer latest breaks through both. Pinned in Task 10.
- **Late GET clobbering a fresher frame** (GET awaits CLI/SDK overlays): core fields must not regress; About-only overlays survive frames. Pinned in Tasks 7 and 9.
- **Registry disabled mid-run**: next tick takes the no-network disabled path, every tab gets the `disabled` transition, reconnecting tabs are seeded `disabled` — never a stale offer. Pinned in Tasks 4 and 6.
- **Desktop offer dead-ends**: failed download re-offers next tick; Later re-offers after restart; Skip never re-offers; busy ticks never stack dialogs. Pinned in Tasks 11 and 12.
- **Reconnecting tab missing the current offer**: the always-on channel seeds the latest snapshot on every new connection. Pinned in Task 5.

---

### Task 1: Config field `updateCheckIntervalMs`

**Files:**
- Modify: `server/config.ts` (ConfigFile near `workingStuckMs` :95; ServerConfig readonly near :233; DEFAULTS near :341; coercion near :639; reset-key list near :838)
- Modify: `CONFIG.md`
- Test: `server/config.test.ts`

**Interfaces:**
- Produces: `config.updateCheckIntervalMs: number` (readonly, default `43_200_000`), consumed by Tasks 6 and 12.

- [ ] **Step 1: Write the failing tests** (existing coercion-test style): default `43_200_000` when absent; `7_200_000` coerces verbatim; `0` coerces to `0` (valid); negative / non-number leave the default; fractional rounds.
- [ ] **Step 2: Run** `npx vitest run server/config.test.ts` — expect new cases FAIL.
- [ ] **Step 3: Implement** — ConfigFile `updateCheckIntervalMs?: number` (doc: ms between periodic probes; 0 disables periodic, startup/manual unaffected; default 12 h), ServerConfig readonly field, DEFAULTS `43_200_000`, coercion mirroring `workingStuckMs` (`typeof number && >= 0` → `Math.round` + `log.info`), `'updateCheckIntervalMs'` in the reset-key list beside `'updateCheckRegistry'`. CONFIG.md entry.
- [ ] **Step 4: Run** the test file — expect PASS.
- [ ] **Step 5: Commit** `feat(config): add updateCheckIntervalMs (default 12h, 0 disables periodic checks)`

### Task 2: Generic scheduler `UpdateSchedule<R>`

**Files:**
- Create: `server/update-schedule.ts`
- Test: `server/update-schedule.test.ts`

**Interfaces:**
- Produces (used by Tasks 6 and 12):

```ts
export interface UpdateScheduleConfig { intervalMs: number; maxBackoffMs: number; jitter: number }
export interface UpdateScheduleDeps<R> {
  check: (manual: boolean) => Promise<R>
  failed: (result: R) => boolean
  current: () => R
}
export class UpdateSchedule<R> {
  constructor(deps: UpdateScheduleDeps<R>, config: UpdateScheduleConfig,
              random?: () => number, now?: () => number)
  check(manual?: boolean, force?: boolean): Promise<R>  // due → coalesced check; not due → current(); manual bypasses deadline
  arm(): void      // arm the first deadline WITHOUT probing (caller ran the startup check)
  dispose(): void
}
/** null when intervalMs === 0; else { intervalMs: max(60_000, intervalMs),
    maxBackoffMs: max(4 * intervalMs, 3_600_000), jitter: 0.2 }. */
export function resolveUpdateScheduleConfig(intervalMs: number): UpdateScheduleConfig | null
```

- [ ] **Step 1: Write the failing tests** (`vi.useFakeTimers()`, injected `now`/`random`; DSH `apps/desktop/src/update-schedule.ts` is the semantics reference):
  - `resolveUpdateScheduleConfig`: `0 → null`; `30_000 → intervalMs 60_000`; `43_200_000 → maxBackoffMs 172_800_000, jitter 0.2`.
  - completion-based: interval 10_000, `random: () => 0.5` (jitter midpoint = exact delay; ≥5000 keeps the 1000 ms floor out of play); a check resolving after 400 ms arms completion+10_000 (advance 9999 ms → no check; +1 ms → check).
  - backoff: same setup, failures double 10_000 → 20_000 → 40_000, capped at `maxBackoffMs`; success resets.
  - jitter bounds: `random: () => 0` → `max(1000, delay * (1 - jitter))`; `() => 1` → `min(maxBackoffMs, delay * (1 + jitter))`.
  - coalescing: two concurrent `check()` → one `deps.check`; not-due non-manual → `current()` without probing; `check(true)` bypasses deadline.
  - `arm()` schedules one future check without probing now; `dispose()` cancels + rejects new work.
- [ ] **Step 2: Run** `npx vitest run server/update-schedule.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** — port DSH's `pending`/`activeChecks`/`nextCheck`/`delay`/`schedule(failed)` structure with generic deps; `arm()` = private `schedule(false)` made public; `setTimeout` re-arms `check(false, true)`.
- [ ] **Step 4: Run** the test file — expect PASS.
- [ ] **Step 5: Commit** `feat(update): generic completion-based update scheduler with backoff and jitter`

### Task 3: Update-info hub (single broadcast decision point)

**Files:**
- Create: `server/update-info-hub.ts`
- Test: `server/update-info-hub.test.ts`

**Interfaces:**
- Consumes: `UpdateInfo` (`shared/update-info.js`), `createAsyncSubscription` (`./async-subscription.js`).
- Produces (used by Tasks 4 and 5):

```ts
export function publishUpdateInfo(info: UpdateInfo): void  // meaningful-change compare vs last received, then fan out; sets last even when silent
export function subscribeUpdateInfo(): { iterable: AsyncIterable<UpdateInfo>; snapshot: UpdateInfo | null; unsubscribe: () => void }
export function __resetUpdateInfoHubForTests(): void
```

- [ ] **Step 1: Write the failing tests:** first publish fans out; identical second silent; each of the five meaningful keys individually triggers; a non-meaningful change (`checkedAt` alone) silent; `snapshot` reflects latest received even when last publish silent; two subscribers both receive; `unsubscribe()` stops only that one.
- [ ] **Step 2: Run** `npx vitest run server/update-info-hub.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** — module-level `last` + `Set<AsyncSubscription<UpdateInfo>>`; key list `['latest', 'deprecated', 'error', 'updateAppliedToDisk', 'disabled']`; subscribe mirrors `sm.subscribeGlobal()` (cleanup removes from set; unsubscribe ends + removes).
- [ ] **Step 4: Run** the test file — expect PASS.
- [ ] **Step 5: Commit** `feat(update): update-info hub — meaningful-change fan-out at the snapshot write point`

### Task 4: Checker publishes every mutation; install-completion publish; desktop host gate

**Files:**
- Modify: `server/update-checker.ts` (three `cached =` writes in `checkForUpdates`: disabled ~:310, success ~:359, failure ~:372)
- Modify: `server/routes/update-routes.ts` (`buildUpdateRouter` signature; POST /update after `runNpmInstall` ~:224)
- Modify: `server/routes/index.ts:199` (pass `host`)
- Test: `server/update-checker.test.ts`, `server/routes/update-routes.test.ts`

**Interfaces:**
- Consumes: `publishUpdateInfo` (Task 3), `withInstalledOverlay` / `getCachedUpdateInfo` (existing).
- Produces: `buildUpdateRouter(claudeBinary?: string, host?: 'web' | 'desktop')` — desktop POST /update answers 400.

- [ ] **Step 1: Write the failing tests:**
  - checker (vi.mock the hub, spy publish): forced success, forced failure, disabled-registry call each publish once with the overlaid snapshot; `probeRegistry` does NOT publish.
  - routes: POST /update with a flipped on-disk version publishes a snapshot carrying `updateAppliedToDisk: true` (mock `runNpmInstall` + `readInstalledVersion` as existing tests do).
  - routes: `buildUpdateRouter(undefined, 'desktop')` → POST /update 400 without `runNpmInstall`.
  - **Review-focus pin:** warm `hasUpdate` cache → `__setConfigForTest({ updateCheckRegistry: '' })` → `checkForUpdates()` publishes `disabled: true`.
- [ ] **Step 2: Run** both test files — expect new cases FAIL.
- [ ] **Step 3: Implement:**
  - checker: `publishUpdateInfo(withInstalledOverlay(cached))` after each of the three writes; none in `probeRegistry`.
  - routes: `host: 'web' | 'desktop' = 'web'` param; POST /update top: `if (host === 'desktop') throw new HttpError(400, 'in-app npm update is not available on the desktop host')`; after successful install: `publishUpdateInfo(getCachedUpdateInfo())`. `routes/index.ts` passes its `host`.
  - **Verification sub-step (spec §5):** pin `detectInstallMethod()`'s classification of an `app.asar/dist/cli.mjs`-shaped path via `__classifyForTests` (documents the desktop path; the 400 gate makes behavior moot).
- [ ] **Step 4: Run** both test files — expect PASS.
- [ ] **Step 5: Commit** `feat(update): publish every snapshot mutation; gate npm self-update off the desktop host`

### Task 5: Wire frame `update-info` + always-on channel

**Files:**
- Modify: `shared/ws-protocol.ts` (interface near `WsCliNotification` :227; union :823)
- Modify: `server/ws-protocol.ts:51`, `src/ws-types.ts:45` (re-export lists)
- Modify: `server/frame-bridge.ts` (`start()` :257; cleanup in `close()` ~:593)
- Modify: `CLAUDE.md` (WS frame list bullet)
- Test: `server/frame-bridge.test.ts`

**Interfaces:**
- Consumes: `subscribeUpdateInfo` (Task 3), `getCachedUpdateInfo` (existing).
- Produces (used by Task 9): `export interface WsUpdateInfo { kind: 'update-info'; info: import('./update-info.js').UpdateInfo }` (SDK-agnostic, no generic params).

- [ ] **Step 1: Write the failing tests** (existing channel-test pattern, fake sink): `start()` seeds one `update-info` frame equal to a previously published snapshot; a changed-`latest` publish arrives as a second frame; **review-focus pin:** a SECOND `SessionConnection` started later is seeded the latest snapshot without a new probe; cold hub seeds `getCachedUpdateInfo()` fallback.
- [ ] **Step 2: Run** `npx vitest run server/frame-bridge.test.ts` — expect new cases FAIL.
- [ ] **Step 3: Implement** — `WsUpdateInfo` + union member + both alias re-exports; `startUpdateInfo()` mirroring `startGlobal()` (subscribe, seed `sub.snapshot ?? getCachedUpdateInfo()`, `for await` fan-out, catch → `error` frame, cleanup in `close()`); call from `start()`. CLAUDE.md bullet.
- [ ] **Step 4: Run** the test file + `npm run typecheck` — expect PASS / clean.
- [ ] **Step 5: Commit** `feat(ws): update-info global frame — always-on channel seeded on every connection`

### Task 6: Server scheduler wiring (web host)

**Files:**
- Modify: `server/update-schedule.ts` (server factory below the generic class)
- Modify: `server/cli.ts:215` (startup probe block)
- Test: `server/update-schedule.test.ts`

**Interfaces:**
- Consumes: Task 2 class, `config.updateCheckIntervalMs` (Task 1), `checkForUpdates` / `getCachedUpdateInfo`.
- Produces: `export function startUpdateSchedule(): UpdateSchedule<UpdateInfo> | null` — null on interval 0; ticks call `checkForUpdates(true)` (TTL bypass); `failed = !!r.error && !r.disabled`; `current = getCachedUpdateInfo()`.

- [ ] **Step 1: Write the failing tests** (`__setConfigForTest` + `__resetUpdateCheckerForTests`, mock fetch as `update-checker.test.ts` does): interval 0 → null; default → schedule (dispose cleans); **review-focus pin (first-run):** registry `''` → a tick completes with zero fetches; after `__setConfigForTest({ updateCheckRegistry: TEST_REGISTRY })` the NEXT tick fetches once. Drive with fake timers + `arm()`.
- [ ] **Step 2: Run** the test file — expect new cases FAIL.
- [ ] **Step 3: Implement** the factory; in `cli.ts` keep the startup probe + log lines and call `startUpdateSchedule()?.arm()` inside its `.then`. Comment: desktop never runs `cli.ts`, so the web-only gate is structural.
- [ ] **Step 4: Run** the test file — expect PASS.
- [ ] **Step 5: Commit** `feat(update): periodic npm update probing on the web host (12h default)`

### Task 7: Client merge util (staleness fence + overlay preservation)

**Files:**
- Create: `src/utils/update-info-merge.ts`
- Test: `src/utils/update-info-merge.test.ts` (pure logic → node environment)

**Interfaces:**
- Produces (used by Task 9): `export function mergeUpdateInfoSnapshot(prev: UpdateInfo | null, incoming: UpdateInfo): UpdateInfo`

Merge rules (exact): (1) `prev === null` → core = incoming. (2) `incoming.disabled` → core = incoming. (3) `prev.checkedAt` set, `incoming.checkedAt` undefined → core = prev (checking placeholder can't clobber). (4) both set, `incoming.checkedAt < prev.checkedAt` → core = prev. (5) else core = incoming (ties: incoming). (6) result = core + overlays `repoUrl`/`claudeCli`/`agentSdk` each taking incoming when present else prev's; absent-on-both stay absent.

- [ ] **Step 1: Write the failing tests** — one per rule, plus: frame after GET preserves all three overlays; GET after frame refreshes overlays while stale GET core rejected; equal `checkedAt` incoming wins; disabled incoming clears `latest`, keeps overlays.
- [ ] **Step 2: Run** `npx vitest run src/utils/update-info-merge.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the pure function per rules.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(update): client snapshot merge — checkedAt fence, overlay preservation`

### Task 8: Toast surface — multi-action + hide-dismiss

**Files:**
- Modify: `src/hooks/toastContext.ts` (`Toast`, `PushOptions`)
- Modify: `src/components/ToastProvider.tsx` (`show` passthrough ~:122-147)
- Modify: `src/components/ToastHost.tsx` (action rendering :152-159; ✕ :164)
- Test: `src/components/ToastHost.test.tsx`

**Interfaces:**
- Produces (used by Task 10):

```ts
// added to Toast AND PushOptions:
actions?: Array<{ label: string; onClick: () => void }>  // rendered as .toast-action buttons; click runs onClick then auto-dismisses
hideDismiss?: boolean                                     // omit the ✕ button
```

Existing `actionLabel`/`onClick`/`onDismiss` behavior unchanged for all current callers.

- [ ] **Step 1: Write the failing tests** (extend ToastHost.test.tsx): `actions: [a, b, c]` renders three labeled buttons; clicking one runs its onClick and dismisses the toast; `hideDismiss: true` renders no `.toast-dismiss`; `hideDismiss` + `durationMs: 0` leaves the actions as the only exit; legacy single `actionLabel` still renders exactly one button + ✕.
- [ ] **Step 2: Run** `npx vitest run src/components/ToastHost.test.tsx` — expect new cases FAIL.
- [ ] **Step 3: Implement** — type additions, provider passthrough, host renders `t.actions?.map(...)` with the same dismiss-after-click wiring as `actionLabel`, and `{!t.hideDismiss && <button className="toast-dismiss" …>}`. Reuse `.toast-action` styling (no new CSS colors).
- [ ] **Step 4: Run** the test file — expect PASS.
- [ ] **Step 5: Commit** `feat(toast): optional multi-action buttons and hide-dismiss for explicit-choice toasts`

### Task 9: `useUpdateInfo` frame subscription

**Files:**
- Modify: `src/hooks/useUpdateInfo.ts`
- Test: `src/hooks/useUpdateInfo.test.tsx` (create; happy-dom)

**Interfaces:**
- Consumes: `mergeUpdateInfoSnapshot` (Task 7), `useOptionalWsHub` (existing), `WsUpdateInfo` (Task 5).
- Produces: unchanged `UseUpdateInfo` shape; `info` now also advances via WS frames.

- [ ] **Step 1: Write the failing tests** (vi.mock `./useWsHub` → fake `{ addListener }` capturing the listener; mock `./useApi` as existing hook tests do): a frame with newer `latest` updates `info` without a fetch; a frame preserves GET-set `claudeCli`/`agentSdk`/`repoUrl`; a late GET with older `checkedAt` doesn't regress `latest`; listener unregisters on unmount; null hub → REST-only still works.
- [ ] **Step 2: Run** `npx vitest run src/hooks/useUpdateInfo.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement** — `const hub = useOptionalWsHub()`; effect: `hub.addListener(frame => { if (frame.kind === 'update-info') setInfo(prev => mergeUpdateInfoSnapshot(prev, frame.info)) })` (mountedRef-guarded, cleanup unregisters); GET path `setInfo(next)` → `setInfo(prev => mergeUpdateInfoSnapshot(prev, next))`.
- [ ] **Step 4: Run** the test file + `npm run typecheck` — expect PASS / clean.
- [ ] **Step 5: Commit** `feat(update): live update-info frames drive useUpdateInfo`

### Task 10: Nag three-state + dialog Skip + host gate

**Files:**
- Modify: `src/hooks/useUpdateNag.ts`
- Modify: `src/components/UpdateDialog.tsx` (footer button area ~:258; new optional prop)
- Modify: `src/App.tsx` (nag call site :654 → below `hostCaps` :950; dialog wiring ~:5772)
- Test: `src/hooks/useUpdateNag.test.tsx`, `src/components/UpdateDialog.test.tsx`

**Interfaces:**
- Consumes: toast `actions`/`hideDismiss` (Task 8), `writeNagDismiss` / `nagDismissValueFor` (existing), `hostCaps.npxSelfUpdate` (existing).
- Produces: `UpdateDialog` gains optional `onSkip?: () => void` — rendered as a "Skip this version" footer button in nag modes only (`update`/`deprecation`), never in `current`.

- [ ] **Step 1: Write the failing tests:**
  - nag: toast renders actions `[Update, Remind me later, Skip this version]` and NO ✕ (`hideDismiss`); **Remind me later writes NOTHING** (localStorage untouched) and dismisses; **Skip writes the dismiss key** (`latest` / `deprecated:<current>` per branch); **Update opens the dialog without writing**; no `onDismiss` skip-write remains; per-mount dedup still blocks re-push; a remount after Later re-nags (toastedRef reset); a newer latest breaks through a stored skip.
  - dialog: `onSkip` renders the button in update/deprecation modes, absent in `current`; clicking calls it; close paths call only `onClose`.
  - App-level wiring is covered by the two suites above + typecheck (the call-site move is mechanical).
- [ ] **Step 2: Run** both test files — expect new cases FAIL.
- [ ] **Step 3: Implement:**
  - `useUpdateNag`: `toast.show('info', msg, { title, durationMs: 0, hideDismiss: true, actions: [{ label: 'Update', onClick: () => onOpenRef.current(mode) }, { label: 'Remind me later', onClick: () => {} }, { label: 'Skip this version', onClick: () => writeNagDismiss(value) }] })` — NO `onDismiss`, NO write on Update. Both branches identical shape. Keep `toastedRef` + localStorage-read gates.
  - `UpdateDialog`: `onSkip?: () => void` prop; footer "Skip this version" button when provided.
  - App: move `useUpdateNag` below `hostCaps` (:950), gate `hostCaps.npxSelfUpdate ? updateInfo.info : null`; dialog `onClose` → `setUpdateNagDialog(null)` ONLY; `onSkip` → `writeNagDismiss(nagDismissValueFor(mode, info))` + close (nag modes).
- [ ] **Step 4: Run** both test files + `npm run typecheck` — expect PASS / clean.
- [ ] **Step 5: Commit** `feat(update): three-state nag — Update / Remind me later / Skip this version, no ✕`

### Task 11: Desktop offer state machine (dedup + persisted skip)

**Files:**
- Create: `desktop/update-offer.ts`
- Test: `desktop/update-offer.test.ts`

**Interfaces:**
- Produces (used by Task 12):

```ts
export interface UpdateOfferDeps {
  download: () => Promise<void>                                   // rejects on failure
  showDialog: (kind: 'available' | 'downloaded', version: string) => Promise<'download' | 'later' | 'skip'>
  quitAndInstall: () => void
  isSkipped: (version: string) => boolean                         // persisted skip list
  skip: (version: string) => void                                 // persist
}
export class DesktopUpdateOffer {
  constructor(deps: UpdateOfferDeps)
  offer(version: string): Promise<void>      // update-available entry
  downloaded(version: string): Promise<void> // update-downloaded entry (restart dialog; 'later'|'skip' both just close)
  get busy(): boolean                        // download in flight || dialog pending → scheduler skips
}
```

- [ ] **Step 1: Write the failing tests** (deferred promises):
  - `isSkipped` true → no dialog; first offer shows; concurrent same-version offer dedups;
  - **'later'** → in-memory dedup only (`skip` NOT called), later offer silent;
  - **'skip'** → `deps.skip(version)` called once, later offer silent;
  - 'download' + resolve → busy true during, false after; **'download' + reject → dedup cleared**, next offer re-shows (unless skipped);
  - busy true while either dialog pending / downloading;
  - `downloaded` accept → `quitAndInstall` once; later/skip → not called.
- [ ] **Step 2: Run** `npx vitest run desktop/update-offer.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** — `offered: Set<string>` + `dialogPending`/`downloadInFlight`; `offer` checks `isSkipped` first, adds to set BEFORE showing; deletes on download rejection only; 'skip' calls `deps.skip` (persistence owns cross-restart memory).
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(desktop): update offer state machine — later is stateless, skip persists, failure re-offers`

### Task 12: Desktop periodic wiring + skip store

**Files:**
- Create: `desktop/update-skip-store.ts`
- Modify: `desktop/updater.ts`
- Test: `desktop/update-skip-store.test.ts`, `desktop/updater.test.ts` (create)

**Interfaces:**
- Consumes: `UpdateSchedule` / `resolveUpdateScheduleConfig` (Task 2), `DesktopUpdateOffer` (Task 11), `config.updateCheckIntervalMs` (Task 1; loaded in-process before `setupAutoUpdate`).
- Produces: `setupAutoUpdate(): Promise<void>` (same signature, now periodic); skip store:

```ts
/** JSON at join(app.getPath('userData'), 'update-skipped.json'): { skipped: string[] },
    capped at 50 (oldest evicted). Missing/corrupt file → empty list (logged). */
export function createUpdateSkipStore(filePath: string): { isSkipped: (v: string) => boolean; skip: (v: string) => void }
```

- [ ] **Step 1: Write the failing tests:**
  - store: roundtrip skip → isSkipped; cap evicts oldest; missing file → empty; corrupt JSON → empty (no throw).
  - updater (vi.mock `electron` → `{ app: { isPackaged: true, getPath: () => tmpDir }, dialog: { showMessageBox: vi.fn() } }`; vi.mock `electron-updater` → fake EventEmitter `autoUpdater` with spies; vi.mock `node:fs` `existsSync` → true; vi.mock `../server/config.js`; fake timers): launch check once, then periodic one interval later; interval 0 → never; unpackaged/no-feed → no-op; **busy skip:** download in flight → tick does NOT call `checkForUpdates`, next tick after settle does; rejected periodic check doubles delay; `update-available` → three-button dialog (buttons `['Download', 'Remind me later', 'Skip this version']`, response 0/1/2 → 'download'/'later'/'skip'); skip persists via the store; `autoDownload` false / `autoInstallOnAppQuit` true unchanged.
- [ ] **Step 2: Run** both test files — expect FAIL.
- [ ] **Step 3: Implement** — skip store (read-modify-write JSON, cap 50); `setupAutoUpdate`: construct offer with deps wired to `autoUpdater.downloadUpdate` / `dialog.showMessageBox` (keep existing copy for available; add the third button) / `quitAndInstall` / store; route events to `offer.offer` / `offer.downloaded`; after launch check settles, `new UpdateSchedule({ check: async () => { if (offer.busy) return { ok: true }; try { await autoUpdater.checkForUpdates(); return { ok: true } } catch { return { ok: false } } }, failed: r => !r.ok, current: () => ({ ok: true }) }, resolveUpdateScheduleConfig(config.updateCheckIntervalMs)!)` + `.arm()`; skip entirely when config resolves null. Keep error handler + logs.
- [ ] **Step 4: Run** both test files + `npm run typecheck` — expect PASS / clean.
- [ ] **Step 5: Commit** `feat(desktop): periodic feed checks, three-button offer, persisted skip list`

### Task 13: Decision record + full verification

**Files:**
- Create: `.agents/notes/implemented/feature/2026-11-24-update-check-subsystem.md`
- Modify: `CLAUDE.md` (update-checker paragraph — scheduler + frame + three-state nag; frame bullet landed in Task 5)

- [ ] **Step 1: Write the agent note** per `.agents/notes/README.md`: the why (timeliness on long-running hosts); DSH prior art and what was NOT adopted (mandatory policy, coordinator/revision fences, channel switching); single-mutation-point broadcast; merge-not-replace + checkedAt fence; **three-state nag semantics and why ✕ was removed from the nag** (✕ meaning "permanent skip" was misleading; Later is deliberately stateless — per-mount dedup is the whole mechanism, no snooze timers); desktop failure-re-offers + persisted skip; knowingly given up (no settings UI; desktop Later re-offers after restart; scheduler deadline not reset by manual Check now — checker dedup makes the worst case one redundant probe; post-download discard still open).
- [ ] **Step 2: Run** `npm run verify:agent-notes` — expect PASS.
- [ ] **Step 3: Full verification:** `npm run typecheck && npm run test && npm run lint` — expect all PASS; fix fallout (checker now publishes on every write — tests asserting call counts may need the hub reset hook).
- [ ] **Step 4: Code review** the full diff per CLAUDE.md; verify and fix confirmed findings.
- [ ] **Step 5: Commit** `docs(update): decision record for the update check subsystem`

---

## Self-review notes

- Spec coverage: §1 → Task 2; §2 → Task 1; §3 → Tasks 3/4/6; §4 → Tasks 5/7/9; §5 → Tasks 4/10; §6 → Tasks 11/12; §7 → Tasks 8/10/11/12; constraints/docs → Tasks 1/5/13. Non-goals honored (no mandatory policy, no channels, no auto-install, no snooze timers, no settings UI, no post-download discard).
- Concretizations of spec-builder-decisions: module-singleton hub (checker's own idiom, stays WS-agnostic); desktop skip cap 50; action order Update/Later/Skip.
- Type consistency: `UpdateSchedule<R>` deps `{check, failed, current}` identical in Tasks 6/12; `resolveUpdateScheduleConfig` null-on-zero handled in both; `DesktopUpdateOffer` deps/`offer`/`downloaded`/`busy` match Task 12 wiring; `mergeUpdateInfoSnapshot(prev, incoming)` matches Task 9; toast `actions`/`hideDismiss` names match Task 10; `onSkip` prop matches App wiring.
- Known behavioral consequence (deliberate, spec §7): after "Remind me later", every reload/new tab re-nags the same version until Skip or a newer release — the per-mount ref is the only suppression.