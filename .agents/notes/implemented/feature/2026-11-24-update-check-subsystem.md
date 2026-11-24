# Agent Note: Periodic update checking with three-state notification

Status: implemented

## Problem

Both update channels were event-triggered only: the server probed the npm
registry once at startup, the desktop Electron updater checked its feed once at
launch, and a plain `GET /api/update-info` returns the cached snapshot whenever
`checkedAt` exists. A long-running server or desktop app therefore never
spontaneously noticed a new release — the user had to click "Check now",
restart, or run the CLI `update` subcommand. The driving scenario is timeliness:
while the app stays open, a new upstream release should surface on its own.

A second problem surfaced during design: the nag's ✕ silently wrote the
permanent per-version skip key, so "close this notification" and "never tell me
about this version again" were the same gesture — misleading, and impossible to
undo from the UI.

## Decision

One config field, `updateCheckIntervalMs` (default 12 h, `0` disables periodic
checking; startup and manual checks unaffected; non-finite values rejected at
coercion — an Infinity interval would turn the jitter math into NaN and
`setTimeout(NaN)` fires immediately), drives two scheduler instances that share
semantics but not result vocabulary:

- `server/update-schedule.ts` exports a generic `UpdateSchedule<R>` ported from
  DSH's `DesktopUpdateSchedule`: completion-based deadline (armed when the
  previous check settles), failure delay ×2 capped at `max(4 × interval, 1 h)`,
  ±20% uniform jitter, monotonic clock, coalesced concurrent checks.
  `startUpdateSchedule()` wires it around `checkForUpdates(true)` on the web
  host; `cli.ts` arms it after the startup probe settles. Ticks read live
  config, so an unconfigured registry takes the no-network disabled path and
  probing resumes without a restart once the wizard sets one. The desktop host
  never runs `cli.ts`, so the npm schedule is web-only by construction.
- `desktop/updater.ts` instantiates the same class around
  `autoUpdater.checkForUpdates()`, armed after the launch check. A tick is a
  no-op while the offer is busy (dialog pending or download in flight), so
  periodic checks never stack dialogs or supersede a transfer.

Broadcast ownership sits at the **single snapshot-mutation point**, not the
scheduler: `server/update-info-hub.ts` compares each published snapshot against
the last received one on five keys (`latest`, `deprecated`, `error`,
`updateAppliedToDisk`, `disabled`) and fans out meaningful changes. The checker
publishes at all three `cached =` write sites; the update route publishes after
an in-app install flips the on-disk overlay. Manual Check now, install
completion, and registry-disabled transitions therefore reach every tab
immediately — no mutation path can be missed.

The wire is one always-on global frame, `update-info` (canonical in
`shared/ws-protocol.ts`), seeded on every new connection from the hub's latest
snapshot (checker-cache fallback when cold). The client (`useUpdateInfo`)
subscribes only while `enabled` (setup complete) — a seed frame must not arm the
nag over the first-run wizard or clobber SetupPage's override-probe results —
and **merges, never replaces**: a `checkedAt` staleness fence keeps a late GET
response (the route awaits CLI/SDK overlays) from regressing core fields a
fresher frame already delivered, while the GET-only overlays (`repoUrl`,
`claudeCli`, `agentSdk`) survive frames and refresh on GETs
(`src/utils/update-info-merge.ts`).

Notification is three explicit states, on both hosts, with **no ✕ on the nag
toast** (`Toast`/`PushOptions` gained `actions` + `hideDismiss` for this):

- **Update** opens the What's New dialog (web) / starts a confirmed download
  (desktop); writes nothing.
- **Remind me later** closes the reminder and writes NOTHING. The per-mount
  dedup ref is the whole "later" mechanism: the tab stays silent, the next mount
  (reload, new tab, app restart) offers the version again. No snooze storage, no
  expiry timers.
- **Skip this version** owns the persistent dismissal: localStorage on the web
  (cross-tab), a capped JSON list under `userData` on desktop
  (`desktop/update-skip-store.ts`, cross-restart). The dialog's close paths are
  stateless too; its explicit Skip button writes the key.

A live nag whose offer becomes invalid (registry disabled, update applied to
disk) is **withdrawn**, and a newer version **replaces** the previous toast
rather than stacking — sticky toasts are exempt from capacity eviction, so
without withdrawal a long-running tab would accumulate one stale offer per
release. Withdrawal also clears the per-mount dedup, so a re-enabled registry
re-nags the same version.

The desktop offer (`desktop/update-offer.ts`) adds one rule beyond the web: a
**failed download is not a dismissal** — the user explicitly chose Download, so
the failure clears the in-memory dedup and the next periodic tick re-offers
(one "Remind me later" stops it). `autoDownload = false` and
`autoInstallOnAppQuit = true` are unchanged; the npm self-update route answers
400 on the desktop host, and the web nag chain is gated off there
(`hostCaps.npxSelfUpdate`).

## Alternatives considered

**DSH's mandatory-update policy.** A server-side endpoint that can block old
clients, with its own polling and a blocking overlay window. Rejected: we have
no account backend and no blocking scenario; the whole subsystem is
discovery + notification, never coercion.

**DSH's coordinator (revision fences, channel switching).** Their download /
install confirmations carry version + revision fences and a stable/nightly
switch. Rejected: our install flow stays as-is (one channel, user-confirmed);
the minimal offer state machine (dedup + busy + persisted skip) covers what
periodic checking actually needs.

**Time-boxed snooze for "Remind me later".** A `{version, until}` record plus
expiry timers (in-tab `setTimeout`, mount-time re-evaluation). Built on paper
and rejected by the user: "later" should equal closing the reminder with no
operation. Stateless Later is simpler and honest about its consequence (reload
re-nags); Skip remains the persistent escape hatch.

**Scheduler-side broadcast diffing.** Comparing before/after each scheduled
probe. Rejected: a manual Check now or an install completion mutates the
snapshot outside the scheduler, so a probe-local diff never broadcasts them.
The single write point covers every trigger with no last-broadcast bookkeeping.

**Wholesale frame replacement in the client.** Simpler, but the About tab reads
GET-only overlays from the same hook instance — a periodic frame would blank
them until the next GET. Merge + fence keeps both surfaces correct.

**✕ as the skip gesture (the old behavior).** Rejected as misleading: a bare
close silently meant "never again", with no undo. The persistent choice now
has a name; ✕ is gone from the nag entirely.

**10-minute (DSH) or 3-hour cadence.** 10 min was rejected as too fast for a
local tool; 3 h was proposed during design and raised to 12 h by the user.

## Consequences

Bought: a running host discovers a release within ~one interval and every
connected tab heals without user action (including reconnects, via the
connection seed); refusal is explicit and reversible-by-naming; the two update
channels are cleanly host-separated (the npm nag no longer leaks onto desktop).

Given up, knowingly:

- "Remind me later" re-nags on every reload / new tab until Skip or a newer
  release — the deliberate cost of stateless Later.
- Desktop "Later" re-offers after a restart (in-memory dedup only); only Skip
  persists.
- No settings UI for the interval — a `config.json` knob beside
  `updateCheckRegistry`.
- A manual Check now does not reset the scheduler deadline; checker-level
  in-flight dedup makes the worst case one redundant probe per interval.
- A downloaded desktop update still installs on quit even if the user picks
  "Later" on the restart dialog (`autoInstallOnAppQuit` unchanged); a
  discard-downloaded-update affordance remains an open product question.
- No forced-update path exists; a deprecated version nags but never blocks.

## Related

- Design spec: `docs/superpowers/specs/2026-11-24-update-check-subsystem-design.md`
- Implementation plan: `docs/superpowers/plans/2026-11-24-update-check-subsystem.md`
- Prior art studied: DeepSeek Harness `apps/desktop/src/update-schedule.ts`,
  `update-coordinator.ts`, `mandatory-update-policy.ts`.