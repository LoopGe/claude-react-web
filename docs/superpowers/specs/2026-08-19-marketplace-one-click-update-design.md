# Marketplace 一键更新 (one-click update all)

Date: 2026-08-19

## Problem

The settings UI has two marketplace surfaces, and both only update one item at a time:

- **"Marketplace" tab** (Global Settings, Claude plugins, `/api/mp/*`): a `check-updates` probe already badges each marketplace whose upstream has new commits ("Update"), but applying that update requires clicking the per-marketplace **Refresh** button one by one.
- **"App Plugins" tab** (Marketplace section, App Plugin mods, `/api/app-plugins/marketplaces/*`): each installed plugin shows an "Update" button when its marketplace catalog version differs from the installed version, but the marketplace itself must be refreshed first to discover new versions, and plugins are updated one by one.

When several marketplaces / plugins are behind, updating them individually is tedious. The user wants a single "update everything that has an update" action in both places.

## Goal / non-goals

- **Goal:** a one-click "Update all" action in the **Marketplace tab** that refreshes (git-pulls) exactly the marketplaces currently badged as having an update, then re-checks so badges reflect the new state.
- **Goal:** a one-click "Update all" action in the **App Plugins Marketplace section** that refreshes every `https` marketplace (to discover new catalog versions), then reinstalls exactly the installed plugins whose catalog version differs from the installed version. Bundled (`local`) marketplaces are skipped — they are app code and never update via git.
- **Goal:** partial failures are isolated and reported; one bad marketplace/plugin never blocks the rest.
- **Goal:** permission escalations during App Plugin updates are surfaced (the plugin enters `permission-required` rather than silently enabling).
- **Non-goal:** auto-update on a timer, or running updates in the background without user action — this is an explicit button click.
- **Non-goal:** server-side bulk endpoints. Orchestration stays client-side, reusing the existing per-item routes (see approach decision below).
- **Non-goal:** changing update *detection* logic (the existing `check-updates` badge for Claude plugins and the per-plugin `installedVersion !== version` comparison for App Plugins are reused as-is).

## Approach decision

**Client-side orchestration reusing existing per-item routes** was chosen over server-side bulk endpoints:

- The number of marketplaces / out-of-date plugins is small (typically single digits), so N+1 round-trips are negligible.
- The bulk action is literally "do what the user would have clicked, automatically" — every route it calls (`/mp/marketplaces/:id/refresh`, `/app-plugins/marketplaces/:id/refresh`, `/:id/plugins`, `/:id/plugins/:name/install`) is already tested and used by the existing single-item buttons.
- No server refactor or new route tests; the change is additive UI + two orchestration handlers.
- Per-item progress falls out naturally from sequential execution.

## Design

### 1. Marketplace tab — `src/components/MarketplaceTab.tsx`

**Extract a reusable refresh helper.** The refresh logic currently lives inline in `handleRefresh`. Extract it into `refreshMarketplace(id)`:

```ts
const refreshMarketplace = useCallback(async (id: string): Promise<void> => {
  const r = await api.post<RefreshResponse>(`/mp/marketplaces/${encodeURIComponent(id)}/refresh`)
  setItems((prev) => prev.map((x) => (x.id === id ? r.entry : x)))
  setWarningsById((w) => ({ ...w, [id]: r.warnings }))
  // A refresh pulled local up to upstream HEAD — clear the update badge.
  setUpdateById((prev) => ({ ...prev, [id]: { id, hasUpdate: false } }))
  // Invalidate cached plugin list so a re-expand re-fetches.
  setPlugins((prev) => { const next = { ...prev }; delete next[id]; return next })
  if (expandedId === id) await fetchPlugins(id)
}, [expandedId, fetchPlugins])
```

`handleRefresh` becomes a thin wrapper: set/clear `busyId`, surface errors into `error`, delegate to `refreshMarketplace`. The single-card Refresh button keeps its exact current behavior.

**New bulk handler.**

```ts
const handleUpdateAll = async () => {
  const targets = items.filter((it) => updateById[it.id]?.hasUpdate)
  if (targets.length === 0) return
  setBulkBusy(true); setBulkResult(null); setError(null)
  const failed: string[] = []
  try {
    for (let i = 0; i < targets.length; i++) {
      setBulkProgress({ done: i, total: targets.length })
      try { await refreshMarketplace(targets[i].id) }
      catch (e) { failed.push(`${targets[i].displayName}: ${(e as Error).message}`) }
    }
    // Re-run the update probe so badges reflect the fresh state.
    await fetchUpdates()
  } finally {
    setBulkBusy(false); setBulkProgress(null)
  }
  const ok = targets.length - failed.length
  setBulkResult(failed.length === 0
    ? `Updated ${ok} marketplace${ok === 1 ? '' : 's'}.`
    : `Updated ${ok}/${targets.length}. Failed: ${failed.join('; ')}`)
}
```

New state: `bulkBusy: boolean`, `bulkProgress: { done: number; total: number } | null`, `bulkResult: string | null`.

**UI** — one row between the add form and the marketplace list:

- `updateableCount > 0` (`items.filter(it => updateById[it.id]?.hasUpdate).length`): a primary button `Update all (N)`. While `bulkBusy`, it reads `Updating (done/total)…` and is disabled.
- `updateableCount === 0 && items.length > 0` **and no marketplace has an update-check error** (`updateStatus.error`): a muted "All marketplaces up to date" note (`var(--ok)`). When any check errored, the note is omitted — the per-card error icons already carry that message, and "up to date" would be misleading.
- `bulkResult` shown in muted text beside the button.
- While `bulkBusy`, per-card action buttons are also disabled (pass `disabled = busy || bulkBusy` into `MarketplaceCard`) so a single Refresh/Del can't race the loop.

Uses existing theme CSS variables (no new colors). Because the button lives inside `MarketplaceTab`, it appears in both mounting surfaces (Global Settings and the per-session Settings panel) with no further wiring.

### 2. App Plugins marketplace section — `src/components/AppPluginMarketplaceSection.tsx`

**New bulk handler** (only `https` marketplaces; `local`/bundled entries are skipped):

1. **Refresh** — for each `mp.sourceType === 'https'` marketplace, `POST /app-plugins/marketplaces/:id/refresh`; failures recorded and skipped. Note that this step already git-pulls the clone (so plugin *code* on disk becomes the new version) and revalidates each installed plugin from that marketplace (updating `manifest`/`manifestHash`, and setting `permission-required` on escalation). It does **not** bump `installedVersion`.
2. **Discover** — for each https marketplace, `GET /app-plugins/marketplaces/:id/plugins`; collect `{ mpId, name }` where `p.installed && p.version && p.installedVersion && p.installedVersion !== p.version`. Because step 1 leaves `installedVersion` stale, every genuinely-updated plugin is correctly found here.
3. **None found** → `setBulkResult('All plugins up to date.')` and stop.
4. **Reinstall** — sequentially `POST /app-plugins/marketplaces/:id/plugins/:name/install` (the same route the per-plugin Update button uses). **This step is required, not redundant**: it is what bumps the record's `installedVersion` to the new version and re-broadcasts; skipping it would leave `installedVersion` stale and every updated plugin perpetually showing an "Update" button. Capture each response's `permissionRequired`; failures recorded and skipped. The response is typed inline on the client (`{ ok: true; result: { permissionRequired: boolean } }`) — the browser bundle never imports server types.
5. `await refreshList()` — the installed list in `AppPluginsTab` syncs via the WS `state-changed` frame emitted by `manager.install`.

Result summary: `Updated N plugins.` + `M need permission review (see Installed).` when any install reported `permissionRequired` + `Failed: …` when any refresh/install threw.

New state: `bulkBusy: boolean`, `bulkProgress: string | null`, `bulkResult: string | null`.

**UI** — one row between the add form and the marketplace list: an `Update all` button (no count, since discovery requires the refresh step); while `bulkBusy` it shows the current phase (`Refreshing marketplaces…` / `Checking for updates…` / `Updating <name> (i/N)…`) and is disabled; `bulkResult` in muted text beside it. While `bulkBusy`, the per-row Refresh/Remove buttons are also disabled (pass `busy || bulkBusy` into `MarketplaceRow`) so a single-row operation can't race the loop.

### Edge cases

- **Partial failure isolation:** each refresh/install is individually try/caught; failures are aggregated into the result summary, and the loop continues. This mirrors the server's own `Promise.allSettled` isolation in `check-updates`.
- **App Plugin permission escalation:** `manager.install` puts an escalated plugin in `permission-required` (not enabled). The bulk summary explicitly points the user at the Installed list.
- **Stale Claude-plugin badges:** the button targets marketplaces badged `hasUpdate` at click time (state populated on tab open). Running the bulk action re-probes at the end so badges are fresh afterwards; a marketplace that gains a new commit after the tab opened is picked up on the next probe.
- **`check-updates` re-probe failure:** `fetchUpdates` already swallows errors (leaves badges empty) — unchanged behavior.

## Files touched

| File | Change |
|---|---|
| `src/components/MarketplaceTab.tsx` | extract `refreshMarketplace`; add `handleUpdateAll` + `bulkBusy`/`bulkProgress`/`bulkResult`; "Update all (N)" row |
| `src/components/AppPluginMarketplaceSection.tsx` | add `handleUpdateAll` + `bulkBusy`/`bulkProgress`/`bulkResult`; "Update all" row |

No server, shared-type, or route changes.

## Testing

1. `npm run typecheck` (both tsconfigs) and `npm run lint`.
2. Manual verification:
   - Marketplace tab: two test marketplaces, one with an upstream commit beyond `lastSha` (badge) and one up to date — `Update all (1)` pulls only the badged one, the badge clears, the summary reads `Updated 1 marketplace.`; an unreachable third marketplace shows the failure summary while the others still update.
   - App Plugins: install a plugin pinned at an older catalog version, then add a newer version upstream — `Update all` refreshes the marketplace, reinstalls the changed plugin, and reports `Updated 1 plugin.`; a plugin whose new version escalates permissions reports `1 need permission review (see Installed).` and shows `permission-required` in the Installed list.
3. Optional component tests (vitest + jsdom, mocking `api`):
   - `src/components/MarketplaceTab.test.tsx` — asserts the button count reflects badged marketplaces, `refresh` is called per badged id, a failing refresh is isolated and reported, and `check-updates` re-runs afterwards.
   - `src/components/AppPluginMarketplaceSection.test.tsx` — asserts the refresh → discover → reinstall sequence and that local marketplaces are skipped.

## Open questions / decisions

- **Confirmed:** both marketplace surfaces get the one-click action.
- **Confirmed:** only items detected as out-of-date are *applied*; for App Plugins the discovery step still refreshes all https marketplaces (that refresh is the detection mechanism).
- **Confirmed:** client-side orchestration (Approach A) over server-side bulk endpoints; no new routes.
- The bulk progress indicator reuses the tabs' existing inline-style conventions with theme CSS variables; no new CSS tokens.
