# Update Check Subsystem — Design

Date: 2026-11-24
Status: draft (pending approval)
Reference prior art: DeepSeek Harness (DSH) `apps/desktop/src/update-schedule.ts`,
`update-coordinator.ts`, `mandatory-update-policy.ts` (studied 2026-11-24).

## Intent and why

Today both of our update channels are **event-triggered only**: the server probes
the npm registry once at startup, and the desktop Electron updater checks its feed
once at launch. A long-running server never spontaneously notices a new release —
even a page reload doesn't help, because a plain `GET /api/update-info` returns the
cached snapshot whenever `checkedAt` exists (verified: `server/routes/update-routes.ts:108`),
and the client fetches once on mount with no polling (`src/hooks/useUpdateInfo.ts`).
The only ways to learn about a new version are clicking "Check now", restarting,
or the CLI `update` subcommand.

The user's driving scenario is **timeliness**: while the server (or desktop app)
stays open, a new upstream release should be discovered automatically and the user
notified through the existing surfaces — no manual action, no restart, no reload.

Decided with the user:

- Cadence: **12 hours** default (DSH's 10 min rejected as too fast; 3 h proposed
  during design and raised to 12 h by the user).
- Scope: **both hosts** — the web/CLI npm channel and the desktop electron-updater channel.
- Discovery only: **installation stays user-confirmed**. No auto-install.
- DSH's mandatory-update (server-side blocking) policy and stable/nightly channel
  switching are **out of scope** (no account backend, no blocking scenario).
- **Three-state notification semantics** (decided after reviewing the dismissal
  flow): the nag offers **Update / Remind me later / Skip this version** as three
  explicit labeled actions, and the nag toast has **no ✕**. "Remind me later"
  closes the reminder and writes NOTHING (re-nags on the next mount/reload/new
  tab); "Skip this version" is the persistent per-version dismissal (today's ✕
  semantics, moved to an explicit label because ✕ meaning "permanent skip" was
  judged misleading). See §7.

## Goals

1. A running web server discovers a new npm `latest` within ~one interval and every
   connected tab learns about it without user action.
2. A running packaged desktop app discovers a new release feed version within ~one
   interval and offers it once per version.
3. Scheduler semantics are robust: completion-based scheduling, failure backoff,
   jitter, coalescing — modeled on DSH's `DesktopUpdateSchedule`.
4. The two update channels are cleanly separated by host (fixing the half-done
   separation that exists today).
5. Refusal is explicit and unambiguous: three labeled choices, no hidden state
   behind a close icon.

## Non-goals

- Forced/mandatory update policy (DSH's `check_client_update` blocking flow).
- Update channel switching (stable/nightly).
- Auto-download or auto-install beyond what exists today
  (`autoInstallOnAppQuit = true` on desktop stays as-is).
- Any new **settings** UI. The interval is a `config.json` knob only.
- Changing the install paths themselves (`POST /api/update`, `quitAndInstall`).
- A time-boxed snooze (storage + expiry timers). "Remind me later" is deliberately
  stateless — the per-mount dedup is the whole mechanism.
- Discarding an already-downloaded desktop update (the post-download
  `autoInstallOnAppQuit` nuance is a separate, still-open product question).

## Anti-goals (failure even if it technically works)

- Re-nagging a version the user explicitly **skipped** (the per-version localStorage
  dedup must keep holding, cross-tab).
- "Remind me later" accidentally writing the skip key (would silence forever) or
  the skip action writing nothing (would nag forever).
- The npm-channel nag firing on the desktop host (today's leak must not be amplified).
- Probe storms: no uncoalesced concurrent probes, no retry tighter than the backoff,
  no per-tab probing (one server-side probe fans out to all tabs).
- Blocking startup, the event loop, or the first paint on update traffic.
- A scheduler that keeps probing when the registry is disabled/unconfigured.

## Verified current state (facts the builder can rely on)

Server (`server/update-checker.ts`, `server/routes/update-routes.ts`):

- `checkForUpdates(force)` probes `<registry>/<pkg>/latest` (5 s timeout), caches
  success 6 h (`CACHE_TTL_MS`), failure 5 min (`FAILED_RETRY_MS`); failed probes
  preserve last-known `latest`/`deprecated`; `checkedAt` is set on success AND failure.
- In-flight dedup via `inFlight`; a `force=true` caller does not join an unforced
  probe — it waits for it to settle, then re-probes.
- `withInstalledOverlay` overlays the live on-disk `installed` version and computes
  `updateAppliedToDisk` (the nag-suppression SSOT) per request.
- Plain `GET /update-info` returns the cache whenever `checkedAt` exists — it never
  re-probes on its own. `?force=1` awaits a fresh probe; `?registry=<url>` is a
  one-off `probeRegistry()` that touches neither config nor cache.
- Probe triggers today: CLI startup (`server/cli.ts:215`, fire-and-forget), the
  cold-cache GET path, Check now, CLI `update` subcommand (`server/cli/update.ts`).
- `server/config.ts` reads **no** `process.env` by design; `updateCheckRegistry`
  lives in `config.json` (default `https://registry.npmjs.org`, empty = disabled)
  and is live-editable via the config routes / About tab.

Client:

- `useUpdateInfo(enabled)` fetches once when `isConfigured` flips true; no polling.
- `useUpdateNag` fires one sticky toast per offered version: update branch
  (`isUpdateNagNeeded` = `hasUpdate && !updateAppliedToDisk`, stable versions only)
  wins over the deprecation branch; localStorage key + per-mount ref dedup.
  **Today ANY closure writes the skip key** (`onDismiss` on the toast, `onClose`
  on the dialog via `nagDismissValueFor`) — §7 changes exactly this.
- Toast surface (`src/hooks/toastContext.ts`, `src/components/ToastHost.tsx`):
  ONE optional action button (`actionLabel` + `onClick`, click auto-dismisses)
  and an UNCONDITIONAL ✕ (`toast-dismiss`, ToastHost.tsx:164). `onDismiss` fires
  on ✕, action click, and auto-timeout — not on capacity eviction.
- `UpdateDialog`: header ✕ (:165) and footer close button (:258) both call
  `props.onClose`; the App call site writes the skip key on close for nag modes.
- Host separation is **half-done**: `host-capabilities.ts` `npxSelfUpdate` gates only
  the About tab's self-update UI (`GlobalSettingsModal.tsx:516`). `useUpdateNag` and
  `UpdateDialog` have **no host gate**. What `POST /api/update` actually does when
  invoked from a packaged desktop is **unverified** — the builder must verify and
  gate the whole npm nag/dialog chain on the desktop host.

Desktop (`desktop/updater.ts`):

- `setupAutoUpdate()` runs once after window creation; no-ops unless
  `app.isPackaged` and `resources/app-update.yml` exists.
- `autoDownload = false`, `autoInstallOnAppQuit = true`; check once at launch;
  `update-available` → native dialog (Download / Later); `update-downloaded` →
  native dialog (Restart Now / Later) → `quitAndInstall()`. All errors logged, never fatal.
- Feed: GitHub releases (`desktop/electron-builder.yml` `publish: github`).
- Desktop main loads the same config module in-process (`createServerContext`
  before `setupAutoUpdate`), so `config.updateCheckIntervalMs` is readable there.

## Decided design

### 1. Shared scheduler semantics (both hosts)

Model on DSH `DesktopUpdateSchedule` (`apps/desktop/src/update-schedule.ts`):

- **Completion-based**: the next deadline is armed when the previous check settles.
- **Interval**: from config (below), default 12 h.
- **Failure backoff**: delay doubles on each consecutive failed check, capped at
  `max(4 × interval, 1 h)`; resets to the interval on success.
- **Jitter**: ±20% uniform; **monotonic clock** for deadlines.
- **Coalescing**: concurrent check requests share one in-flight probe; explicit
  requests bypass the deadline but still coalesce.

Two instances — server process (npm channel) and Electron main (electron-updater
channel). They share semantics; whether a shared helper module is worth it is the
builder's call (the server and desktop already share `server/` modules).

### 2. Config

- New `config.json` field **`updateCheckIntervalMs`**, default `43_200_000` (12 h).
  One field drives BOTH schedulers.
- Explicit `0` disables periodic checking (startup + manual checks still work);
  unset means the default; nonzero values below 60 s clamp to 60 s.
- No settings UI — a power-user knob beside `updateCheckRegistry`, documented in
  `CONFIG.md`.
- Live config respected: registry cleared → no probes; re-enabled → probes resume
  without a restart (reading current config per tick suffices).

### 3. Server scheduler (web host only)

- New module (suggested `server/update-schedule.ts`) owning one schedule around
  `checkForUpdates()`, started beside the startup probe in `cli.ts` (the desktop
  host never runs `cli.ts`, so the web-only gate is structural).
- **Tick-gated, not start-gated**: the schedule exists even while the registry is
  unconfigured (first-run wizard). Each tick reads live config; disabled registry →
  the checker's no-network disabled path (which resets the snapshot and broadcasts
  the transition), never a probe.
- The startup probe stays; the scheduler arms its first deadline after it settles.
- **Scheduled probes bypass the cache TTL** (the scheduler is the freshness
  authority); the 6 h / 5 min windows keep serving ad-hoc unforced callers.
  In-flight dedup still applies.

**Broadcast ownership — the single snapshot-mutation point, not the scheduler.**
Every meaningful snapshot mutation broadcasts, regardless of trigger: scheduled
probe, manual Check now, install completion (`updateAppliedToDisk` flip), or
registry-disabled reset. The checker's snapshot-write path compares against the
previous snapshot and invokes the hub on a meaningful change. Meaningful = any of
`latest`, `deprecated`, `error`, `updateAppliedToDisk`, `disabled` changed; an
unchanged successful probe is silent. `POST /api/update` completion re-runs the
installed overlay through the same path, so an in-app install suppresses the nag
in every tab immediately.

### 4. Wire: one new global WS frame

- New frame kind **`update-info`** in `shared/ws-protocol.ts`, riding the GLOBAL
  channel (always-on, like `sessions-snapshot`), seeded on every new connection.
- Payload: the `UpdateInfo` snapshot with the installed overlay
  (`getCachedUpdateInfo()` shape). Route-level Claude-CLI / agent-SDK overlays stay
  GET-only.
- Client: `useUpdateInfo` subscribes via the hub. Frame arrival **merges, never
  wholesale-replaces**: GET-only overlay fields (`claudeCli`, `agentSdk`, `repoUrl`)
  survive frames. **Staleness fence**: a core-snapshot update (frame OR GET) applies
  only when its `checkedAt` is at least as new as the current core's; a `disabled`
  transition (no `checkedAt`) always applies; a `checking` placeholder cannot
  clobber a checked snapshot. GET overlay fields always merge.
- Mount fetch, Check now, versions switcher: unchanged.

### 5. Host separation (cleanup that rides along)

- The npm-channel nag + UpdateDialog chain is suppressed on the desktop host —
  one decision point (the App nag call site, gated on `hostCaps.npxSelfUpdate`).
- The builder verifies what `POST /api/update` does today from a packaged desktop
  and makes the server-side behavior consistent (400 on the desktop host).

### 6. Desktop scheduler

- `setupAutoUpdate()` gains a schedule with the same semantics around
  `autoUpdater.checkForUpdates()`, reading `updateCheckIntervalMs`. Launch check
  stays; the scheduler arms after it settles.
- Periodic checks **stand down while a transfer or confirmation is live** (download
  in flight or a dialog pending) — never stack dialogs or supersede a download.
- `update-available` offers the version **once per process run** (in-memory dedup);
  the three-button dialog (§7) decides what happens next.
- A failed download is NOT a dismissal: it clears the in-memory dedup so the next
  periodic check re-offers (one "Remind me later" stops it; a persistent failure
  re-asks at most once per interval). An explicit **Skip** persists across restarts.
- `autoDownload = false`, `autoInstallOnAppQuit = true`, the enabled gate, and the
  post-download restart dialog: unchanged.

### 7. Notification semantics — three explicit states, no ✕

The nag toast renders **three labeled actions and no dismiss icon**:

| Action | Meaning | State written |
|---|---|---|
| **Update** | Open the What's New / update dialog | none |
| **Remind me later** | Close the reminder, do nothing | **none** — the per-mount dedup keeps this tab silent; the next mount (reload, new tab, app restart) re-nags the same version |
| **Skip this version** | Never nag this version again in this browser | the existing localStorage dismiss key (`latest`, or `deprecated:<current>` for the deprecation branch) |

- A newer `latest` always breaks through both states (the stored value differs).
- Cross-tab: Skip is browser-wide (localStorage); Remind me later is per-mount.
- **UpdateDialog**: closing it (backdrop / Esc / header ✕ / footer close) writes
  NOTHING (= remind me later); a new explicit **Skip this version** button in the
  nag modes writes the dismiss key. The read-only `current` mode is untouched.
- **Desktop pre-download dialog**: `[Download] [Remind me later] [Skip this version]`.
  Later = in-memory dedup only (restart re-offers); Skip = persisted to a small
  JSON under `userData` (capped version list), consulted before every offer.
- Toast surface extension (generic, small): `Toast`/`PushOptions` gain an optional
  `actions` array (label + onClick, click auto-dismisses) and `hideDismiss`;
  `ToastHost` renders them and omits ✕ when set. The nag passes no `onDismiss`.
- **My calls**: action order `[Update] [Remind me later] [Skip this version]`;
  English copy matching the existing nag; desktop skip list capped (builder picks
  the cap, suggestion 50); no tooltip needed (labels are explicit).

## Constraints (repo conventions the plan must honor)

- `server/config.ts` reads no `process.env`; all config via `config.json`.
- Diagnostic logging via `createLogger(scope)`, never bare `console.*`.
- Canonical WS frames in `shared/ws-protocol.ts`; both alias files updated.
- Probes never throw out of the checker; failures are data (`info.error`).
- No speculative defensive code; real errors surface loudly.
- CSS: theme variables only, both `:root` and `[data-theme="light"]` (new toast
  action buttons reuse the existing `.toast-action` styling).
- Tests: scheduler with injected clock/random; hub change-detection; frame fan-out
  + seed; merge/fence; nag three-state persistence semantics; desktop offer
  dedup/skip/failure; both tsconfigs; vitest + lint per CLAUDE.md.
- Review gate: full-diff code review before commit; an `.agents/notes/` decision
  record lands in the same change.

## Left to the builder

- Backoff/jitter implementation details; module placement; shared-helper decision.
- Frame payload typing details; TTL-bypass mechanism; reconnect seeding mechanics.
- Desktop config-read wiring; verification + gating of desktop `POST /api/update`.
- Desktop skip-store file shape and cap; toast `actions` rendering details.
- Test layout and fixtures.

## Reference

- DSH scheduler: `D:\codes\deepseek-harness\apps\desktop\src\update-schedule.ts`
- DSH coordinator / mandatory policy (NOT adopted): same directory.
- Our checker: `server/update-checker.ts`; routes: `server/routes/update-routes.ts`
- Our client: `src/hooks/useUpdateInfo.ts`, `src/hooks/useUpdateNag.ts`, `src/App.tsx:643`
- Toast surface: `src/hooks/toastContext.ts`, `src/components/ToastHost.tsx`
- Our desktop: `desktop/updater.ts`, `desktop/electron-builder.yml`