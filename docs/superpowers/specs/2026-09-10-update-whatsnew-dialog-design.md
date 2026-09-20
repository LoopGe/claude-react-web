# Version-update toast + What's New dialog

Date: 2026-09-10

## Problem

The only proactive update surface today is `UpdateBanner` — a top-of-page inline
banner shown when the npm registry reports a newer version. It is easy to miss,
carries no release notes, and its dismiss semantics (sessionStorage, per-tab)
re-nag on every reload. Users have no way to see *what changed* before deciding
whether to upgrade.

The update **plumbing** is already complete and stays untouched:
`server/update-checker.ts` (registry probe, 6h TTL), `GET /api/update-info`,
`POST /api/update` (in-place `npm i -g` for global installs), the version
switcher, and the About tab. What's missing is a higher-signal notification
surface and a dialog that shows release notes.

## Goal / non-goals

**Goals**

- Replace the banner with a **sticky toast** notification carrying an "Update"
  action button; clicking it (or the toast body) opens a **What's New dialog**
  with GitHub-release-sourced changelog entries for every version in
  `(current, latest]`.
- One proactive nag per version across the whole browser profile (localStorage),
  not per-tab-per-reload.
- The deprecation notice (`npm deprecate` on the running version) reuses the
  same toast + dialog mechanism.
- Graceful degradation everywhere: no GitHub release / GitHub unreachable /
  private-registry fork → dialog still shows version numbers, just no notes.
- npx / dev installs get the copy-command fallback exactly as today.

**Non-goals**

- No change to the probe/cache layer in `update-checker.ts` or to
  `POST /api/update` semantics.
- No auto-restart after an in-app update (still "restart the server to apply",
  surfaced via the existing toast.success copy).
- No "restart to apply" nag dialog for the `updateAppliedToDisk` state — that
  state stays silent (the in-app update path already toasts "restart to apply"
  at the moment the update lands).
- No periodic re-poll of the registry; the mount-time probe + manual "Check
  now" in About remain the only triggers, as today.
- About tab is unchanged except for adopting the shared update-result helper.

## Decisions already made (product)

| Decision | Choice |
|---|---|
| Content positioning | What's New dialog with release notes |
| Release-notes source | GitHub Releases API (maintainer creates a Release per version; missing Release degrades gracefully) |
| Banner | Removed entirely |
| Entry surface | Toast notification with an "Update" action button |
| Toast lifetime | Sticky (`durationMs: 0`) until acted on or dismissed |
| Dismiss persistence | localStorage keyed by the offered `latest` version; a new `latest` re-notifies |
| Deprecation notice | Reuses the same toast + dialog mechanism with different copy |

## Design

### 1. Server: `GET /api/release-notes`

New module `server/release-notes.ts`, route mounted in
`server/routes/update-routes.ts` alongside the existing update endpoints.

```
GET /api/release-notes?from=<ver>&to=<ver>
→ {
    from: string
    to: string
    releases: Array<{
      version: string        // parsed from tag_name (leading "v" stripped)
      name: string
      body: string           // release markdown, verbatim
      publishedAt: string    // ISO timestamp
      url: string            // html_url
    }>                       // DESC by version, filtered to (from, to]
    error?: string           // set when the GitHub fetch failed; releases: []
    checkedAt?: number
  }
```

- Fetches `https://api.github.com/repos/LoopGe/claude-react-web/releases?per_page=30`.
  The repo slug is read from the **build-time** `package.json` `repository` URL
  (same trust boundary as `packageName` in `update-checker.ts`) — never from the
  request, so this is not an SSRF surface. No GitHub token; unauthenticated
  60 req/h per IP is ample given caching.
- Version filtering uses `parseSemver` from `shared/update-info.ts` (the same
  parser the whole update stack uses). Tags that don't parse (e.g. `latest`,
  `nightly`) are skipped. Drafts and prereleases (per the API's
  `prerelease: true`) are skipped — matching `isVersionNewer`'s stable-only
  policy. An "unavailable" release (asset-only, no notes) still counts if it
  parses and is in range; its `body` is just empty.
- **Caching** mirrors `update-checker.ts`: successful responses cached 6h
  (`RELEASES_CACHE_TTL_MS`), failures cached briefly (5 min retry window) with
  the `error` preserved, in-flight dedupe via a shared promise, 5s fetch
  timeout. Cache key is the full `(from, to)` pair — the About tab never calls
  this, so key cardinality stays at "one entry per running version", and the
  6h TTL is refreshed on every dialog-open while a nag is live.
- `from`/`to` are validated as parseable semver; malformed → 400. The route
  short-circuits to `{ releases: [], error: 'update checks are not configured' }`
  equivalent behaviour only when `config.updateCheckRegistry` is empty — a user
  who disabled update checks shouldn't be poked by GitHub either. (The toast
  gate `isUpdateNagNeeded` already returns false for `disabled` snapshots, so
  this is belt-and-braces for direct callers.)

No WS frame is needed: the dialog fetches on open (below).

### 2. Client: toast entry (App layer)

Mounted in `App.tsx` next to the existing `useUpdateInfo(isConfigured === true)`
call. A small effect + refs:

- **Gate**: `isUpdateNagNeeded(info)` (mandatory — suppresses the nag once an
  in-app update is on disk pending restart). Deprecation is a separate,
  independently-gated branch: `!!info.deprecated && !isUpdateAppliedToDisk(info)`
  (identical to `UpdateBanner`'s current condition).
- **Dismiss store**: `localStorage` key
  `claude-react-web:update-nag-dismissed-version`, value = the dismissed
  `latest` version (or, for the deprecation branch, a
  `deprecated:<current>` sentinel so the two dismissals don't collide).
  A new `latest` (or a new deprecation target) naturally differs from the stored
  value → re-notify.
- **Dedup within a tab**: a `useRef<string>` records the version already
  toasted this mount; React StrictMode double-effects and `info` identity
  churn must not stack two toasts.
- **Toast push** (sticky, `durationMs: 0`):

  ```
  title:   "New version available"        (update)
           "This version is deprecated"   (deprecation)
  message: "0.7.2 → 0.8.0 — see what changed" / deprecation message
  actionLabel: "Update"
  onClick: → open UpdateDialog
  ```

  Dismissal rules — one nag per version, so *any* closure of the nag counts as
  "seen" and writes the localStorage key:
  - toast ✕ dismiss → writes the key;
  - toast action click → opens the dialog, dismisses the toast, does **not**
    write the key yet;
  - dialog closed by any means ("Later", backdrop click, Escape, successful
    update) → writes the key.

  Rationale: with the banner gone, re-nagging a user who already opened and
  closed the dialog is pure noise.
- When `info.checking` is true / `checkedAt` is absent, the effect simply does
  nothing; it re-runs when the probe lands (the effect depends on `info`).

### 3. Client: `UpdateDialog` (What's New)

New component `src/components/UpdateDialog.tsx`, mounted once in `App.tsx`
(app-level — App can host up to 3 chat panels, the dialog is global).

**Shell**: reuses the `Overlay` perm-variant pattern (`.perm-overlay` /
`.perm-card`, `modal-header` / `modal-section` family) exactly like
`UploadsManagerDialog` — dark/light theming comes from the shared sheets; only
the dialog's own layout gets scoped CSS (`src/styles/update-dialog.css`, all
colours via theme CSS variables per the CLAUDE.md rule).

**Data**: new hook `src/hooks/useReleaseNotes.ts` — fetch-on-open (the dialog
is `null`-rendered when closed, so the hook's `enabled` flag is just `open`).
Calls `GET /api/release-notes?from=<current>&to=<latest>`; concurrent-call
dedupe mirrors `useUpdateInfo`'s in-flight guard. While loading: spinner in the
dialog body. On `error` / empty `releases`: an inline muted note ("Release
notes are unavailable right now.") above the version header — the dialog is
still useful without notes.

**Layout**:

```
┌──────────────────────────────────────────┐
│ What's new in 0.8.0                   ✕ │  ← modal-header
├──────────────────────────────────────────┤
│ 0.8.0 · 2026-09-10                       │
│ <Markdown body of release 0.8.0>         │  ← one modal-section per release
│ ─────────────────────────────            │
│ 0.7.3 · 2026-09-05                       │
│ <Markdown body of release 0.7.3>         │
├──────────────────────────────────────────┤
│ [Update now]  [Copy command]   [Later]   │  ← modal-footer
└──────────────────────────────────────────┘
```

- Markdown rendering via the existing `src/components/Markdown.tsx`
  (react-markdown + remark-gfm + lowlight). Release bodies are maintainer-
  authored, and the parser enables no raw-HTML passthrough — same trust level
  as assistant output rendered today.
- Header line: `What's new in <latest>` for the update branch;
  `Version <current> is deprecated` for the deprecation branch, with the
  maintainer's deprecation message rendered above the release list.
- Footer buttons:
  - **Update now** — shown only when `info.installMethod === 'global'`. Runs
    the in-app update, spinner-while-running, then:
    - success (`updateApplied`) → toast.success (existing copy: "Installed X on
      disk — restart the server to apply."), dismiss-key written, dialog closes.
    - no-op (`performed` but not `updateApplied`) → toast.info (existing copy),
      dialog stays open.
    - server declined (`!performed`) → toast.info pointing at the copy-command.
    - thrown → inline error in the dialog footer (About-tab `updateError`
      pattern), dialog stays open.
  - **Copy command** — copies `buildUpgradeCommand(packageName, registry)`;
    button flips to "Copied" for 2s (same UX as the banner). Always shown.
  - **Later** — closes the dialog and writes the dismiss key.
  - Backdrop click / Escape also close and write the dismiss key (see §2).
- After a successful in-app update the dialog closes; the nag gate
  (`isUpdateNagNeeded`) flips false so no new toast appears.

**Shared helper** (small refactor, part of this change): the update-result
handling (`res.performed` → three toasts) is currently duplicated in
`UpdateBanner.runUpdate` and `AboutTab.runUpdate`. Extract
`src/utils/update-action.ts#reportUpdateResult(toast, res)` and use it from the
dialog and the About tab. The banner's copy dies with the banner.

### 4. Banner removal

Delete `src/components/UpdateBanner.tsx` + its test + the `.update-banner*`
CSS block(s). Remove the `<UpdateBanner …/>` mount and its import from
`App.tsx`. The `error-bar` / reconnecting banner is unrelated and stays.

### 5. Edge cases

| Case | Behaviour |
|---|---|
| Registry disabled (`updateCheckRegistry: ''`) | `isUpdateNagNeeded` false → no toast; release-notes route also refuses (belt-and-braces) |
| `checking: true` (cold cache) | effect no-ops; re-fires when the probe lands |
| `updateAppliedToDisk` (update installed, restart pending) | nag suppressed (`isUpdateNagNeeded`); no toast, no dialog |
| No GitHub release in range / GitHub 403 / offline | dialog renders with the "notes unavailable" note + version header + buttons |
| npx / dev install | no "Update now"; "Copy command" is the primary footer action |
| Multiple tabs | each tab toasts once (per-tab ref) but they share the localStorage dismiss — dismissing in one tab means the next mount in any tab stays quiet |
| Version switcher / About "Check now" | unchanged; they never touch the dialog |
| `hasUpdate` but `latest` unparseable | cannot happen for the toast path — `isVersionNewer` gates `hasUpdate` server-side; release-notes filtering uses the same parser |

## Testing

- `server/release-notes.test.ts` — route + parser:
  range filtering (exclusive `from`, inclusive `to`), `v`-prefix stripping,
  prerelease/draft/unparseable-tag skipping, disabled-registry short-circuit,
  malformed query → 400, fetch-failure → `{ releases: [], error }`, cache TTL
  behaviour and in-flight dedupe (follow `update-routes.test.ts` conventions).
- `src/components/UpdateDialog.test.tsx` — render with/without notes, loading
  state, update/npx footer branches, Update-now result paths (applied / no-op /
  declined / thrown), Copy-command flip, Later-dismisses-and-writes-key,
  backdrop-dismiss-writes-key, deprecation-branch copy (follow
  `ConfirmDialog.test.tsx` / `UploadsManagerDialog.test.tsx` conventions;
  portal + `useFocusTrap` cleanup like `PermissionDialog.test.tsx`).
- `src/hooks/useReleaseNotes.test.ts` — fetch-on-open, no fetch while closed,
  in-flight dedupe.
- App-level nag effect — extract into a testable unit (hook
  `src/hooks/useUpdateNag.ts`) covering: pushes once per version, dedupes
  StrictMode double-invoke, respects the localStorage dismiss value, re-notifies
  on a newer `latest`, deprecation sentinel branch, silent when
  `isUpdateNagNeeded` false / `checking`.
- `shared/update-info.test.ts` — untouched.
- The floating-surface invariant test (`src/styles/floating-surface-anchor.test.ts`)
  must keep passing for the new dialog (it's a portaled overlay; follow the
  `portal-test-utils.ts` pattern).
- Full `npm run typecheck` + `npm run test` + `npm run lint` green.
- Delete `UpdateBanner` tests with the component.

## Files

| Action | Path |
|---|---|
| add | `server/release-notes.ts` |
| add | `server/release-notes.test.ts` |
| edit | `server/routes/update-routes.ts` (mount the release-notes route) |
| add | `src/components/UpdateDialog.tsx` |
| add | `src/components/UpdateDialog.test.tsx` |
| add | `src/hooks/useReleaseNotes.ts` |
| add | `src/hooks/useReleaseNotes.test.ts` |
| add | `src/hooks/useUpdateNag.ts` |
| add | `src/hooks/useUpdateNag.test.ts` |
| add | `src/utils/update-action.ts` (`reportUpdateResult` shared helper) |
| add | `src/styles/update-dialog.css` (+ import wherever the other overlay sheets live) |
| edit | `src/App.tsx` (drop banner mount; wire `useUpdateNag` + `UpdateDialog`) |
| edit | `src/components/GlobalSettingsModal.tsx` (About tab adopts `reportUpdateResult`) |
| edit | `src/styles/index.css` (`@import './update-dialog.css'`, same as the other overlay sheets) |
| delete | `src/components/UpdateBanner.tsx`, `src/components/UpdateBanner.test.tsx` (if present), `.update-banner*` CSS |

## Release-process note (maintainer)

This feature's notes quality depends on a GitHub Release existing per published
version. The release body should be the version's CHANGELOG section. A missing
Release degrades to "no notes", never to a broken UI — but the toast copy
promises "see what changed", so the release checklist should include
`gh release create vX.Y.Z` (a follow-up nicety, out of scope here: a
`scripts/release.mjs` reminder or a CONTRIBUTING note).
