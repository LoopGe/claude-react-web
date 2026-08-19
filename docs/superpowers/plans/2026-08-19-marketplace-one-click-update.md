# Marketplace 一键更新 (One-click Update All) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click "Update all" action to both marketplace settings surfaces — the "Marketplace" tab (Claude plugins, `/api/mp/*`) refreshes every marketplace currently badged as having an update; the "App Plugins" Marketplace section refreshes all `https` marketplaces then reinstalls every installed plugin whose catalog version differs from its installed version.

**Architecture:** Pure client-side orchestration reusing existing per-item routes. `MarketplaceTab` extracts its per-card refresh into a shared `refreshMarketplace(id)` helper; a new `handleUpdateAll` loops over the badged marketplaces and re-runs the update probe afterwards. `AppPluginMarketplaceSection` gets a `handleUpdateAll` that runs the three-phase sequence (refresh `https` marketplaces → discover out-of-date installed plugins → reinstall each via the existing install route), capturing `permissionRequired`. Both tabs add a progress + summary row and disable per-item controls while the bulk run is in flight. No server, shared-type, or route changes.

**Tech Stack:** React 19, TypeScript, Vite, vitest + jsdom + @testing-library/react.

## Global Constraints

- Client-only change — do not modify anything under `server/` or `shared/`.
- The browser bundle never imports server types. Type the App Plugin install response inline as `{ ok: true; result: { permissionRequired: boolean } }`.
- CSS uses existing theme variables only (`var(--ok)`, `var(--fg-muted)`, `var(--border)`, …). No new colors, no new CSS files.
- Typecheck: `npm run typecheck` (runs both `tsconfig.json` and `tsconfig.node.json`) — must pass after each task.
- Lint: `npm run lint` — must pass after each task.
- Targeted tests: `npx vitest run src/components/MarketplaceTab.test.tsx` and `npx vitest run src/components/AppPluginMarketplaceSection.test.tsx` (jsdom).
- react-hooks: never call setState synchronously in an effect body (the existing mount effects use an async IIFE or `void fn()`); event handlers set state freely.
- Every git commit ends with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- `git add` only the exact files each task touches. An uncommitted spec (`docs/superpowers/specs/2026-08-19-marketplace-one-click-update-design.md`) may exist in the worktree — leave it out of feature commits.

---

### Task 1: MarketplaceTab — "Update all (N)" bulk refresh

**Files:**
- Create: `src/components/MarketplaceTab.test.tsx`
- Modify: `src/components/MarketplaceTab.tsx`

**Interfaces:**
- Consumes: existing `api` from `../hooks/useApi` (`.get` / `.post`), existing component-local types `RefreshResponse` / `CheckUpdatesResponse`, existing state `items` / `updateById` / `warningsById` / `plugins` / `expandedId` / `busyId`, existing `fetchPlugins(id)` callback, existing `fetchUpdates(signal?)` callback.
- Produces:
  - `refreshMarketplace(id: string): Promise<void>` — refreshes one marketplace and folds the result into local state; **throws** on failure so callers decide how to surface it.
  - `handleUpdateAll(): Promise<void>` — bulk handler.
  - `updateableCount: number`, `anyCheckError: boolean` — derived render values.
  - `MarketplaceCard` gains a `bulkBusy: boolean` prop (disables its action buttons while the bulk loop runs).
  - Later consumed by nothing in this plan; the two tabs are independent.

- [ ] **Step 1: Write the failing test**

Create `src/components/MarketplaceTab.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { MarketplaceTab } from './MarketplaceTab'
import type { MpListItem } from '../types'

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}))

import { api } from '../hooks/useApi'

const mkItem = (id: string, displayName: string): MpListItem => ({
  id,
  displayName,
  source: { type: 'https', url: `https://github.com/x/${id}` },
  addedAt: 0,
  lastRefreshedAt: 0,
  lastSha: 'abc',
  pluginCount: 2,
  enabledCount: 1,
})

const refreshCalls = () =>
  (api.post as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => c[0] as string)
    .filter((u) => u.endsWith('/refresh'))

describe('MarketplaceTab Update all', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces') {
        return Promise.resolve({ marketplaces: [mkItem('mp1', 'MP One'), mkItem('mp2', 'MP Two')] })
      }
      return Promise.resolve({})
    })
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces/check-updates') {
        return Promise.resolve({
          ok: true,
          updates: [
            { id: 'mp1', hasUpdate: true },
            { id: 'mp2', hasUpdate: false },
          ],
        })
      }
      if (url === '/mp/marketplaces/mp1/refresh') {
        return Promise.resolve({ ok: true, entry: mkItem('mp1', 'MP One'), updated: true, warnings: [] })
      }
      if (url === '/mp/marketplaces/mp2/refresh') {
        return Promise.resolve({ ok: true, entry: mkItem('mp2', 'MP Two'), updated: true, warnings: [] })
      }
      return Promise.resolve({})
    })
  })

  it('renders Update all (1) and refreshes only the badged marketplace', async () => {
    const { container } = render(<MarketplaceTab />)
    await waitFor(() => expect(container.textContent).toContain('Update all (1)'))

    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Update all'),
    )!
    fireEvent.click(btn)

    await waitFor(() => expect(refreshCalls()).toEqual(['/mp/marketplaces/mp1/refresh']))
    await waitFor(() => expect(container.textContent).toContain('Updated 1 marketplace.'))
  })

  it('shows an up-to-date note when nothing is badged and nothing errored', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces/check-updates') {
        return Promise.resolve({
          ok: true,
          updates: [
            { id: 'mp1', hasUpdate: false },
            { id: 'mp2', hasUpdate: false },
          ],
        })
      }
      return Promise.resolve({})
    })
    const { container } = render(<MarketplaceTab />)
    await waitFor(() => expect(container.textContent).toContain('All marketplaces up to date'))
    expect(container.textContent).not.toContain('Update all (')
  })

  it('isolates a failing refresh and reports the partial result', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces/check-updates') {
        return Promise.resolve({
          ok: true,
          updates: [
            { id: 'mp1', hasUpdate: true },
            { id: 'mp2', hasUpdate: true },
          ],
        })
      }
      if (url === '/mp/marketplaces/mp1/refresh') return Promise.reject(new Error('boom'))
      if (url === '/mp/marketplaces/mp2/refresh') {
        return Promise.resolve({ ok: true, entry: mkItem('mp2', 'MP Two'), updated: true, warnings: [] })
      }
      return Promise.resolve({})
    })
    const { container } = render(<MarketplaceTab />)
    await waitFor(() => expect(container.textContent).toContain('Update all (2)'))

    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Update all'),
    )!
    fireEvent.click(btn)

    await waitFor(() =>
      expect(container.textContent).toContain('Updated 1/2. Failed: MP One: boom'),
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/MarketplaceTab.test.tsx`
Expected: FAIL — `MarketplaceTab` has no "Update all" button; the first test's `waitFor(() => expect(container.textContent).toContain('Update all (1)'))` times out.

- [ ] **Step 3: Add state, extract `refreshMarketplace`, rewrite `handleRefresh`**

In `src/components/MarketplaceTab.tsx`, after the `updateById` state (near line 62), add the bulk state:

```tsx
  // Bulk "Update all" — one click refreshes every marketplace currently
  // badged as having an update. `bulkProgress` drives the button label;
  // `bulkResult` is the completion summary shown beside it.
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null)
  const [bulkResult, setBulkResult] = useState<string | null>(null)
```

After the `fetchPlugins` useCallback (currently lines 129-136), add the shared refresh helper:

```tsx
  // Refresh a single marketplace and fold the result into local state. Shared
  // by the per-card Refresh button (handleRefresh) and the bulk "Update all"
  // loop. Throws on failure so callers decide how to surface it.
  const refreshMarketplace = useCallback(async (id: string): Promise<void> => {
    const r = await api.post<RefreshResponse>(`/mp/marketplaces/${encodeURIComponent(id)}/refresh`)
    setItems((prev) => prev.map((x) => (x.id === id ? r.entry : x)))
    setWarningsById((w) => ({ ...w, [id]: r.warnings }))
    // A refresh pulled local up to upstream HEAD — clear the update badge.
    setUpdateById((prev) => ({ ...prev, [id]: { id, hasUpdate: false } }))
    // Invalidate cached plugin list so a re-expand re-fetches.
    setPlugins((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    if (expandedId === id) {
      await fetchPlugins(id)
    }
  }, [expandedId, fetchPlugins])
```

Replace the existing `handleRefresh` body with a thin wrapper:

```tsx
  const handleRefresh = async (id: string) => {
    setBusyId(id)
    setError(null)
    try {
      await refreshMarketplace(id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }
```

- [ ] **Step 4: Add `handleUpdateAll`, derived counts, the toolbar row, and thread `bulkBusy` into the card**

After `handleRefresh`, add:

```tsx
  const handleUpdateAll = async () => {
    const targets = items.filter((it) => updateById[it.id]?.hasUpdate)
    if (targets.length === 0) return
    setBulkBusy(true)
    setBulkResult(null)
    setError(null)
    const failed: string[] = []
    try {
      for (let i = 0; i < targets.length; i++) {
        setBulkProgress({ done: i, total: targets.length })
        try {
          await refreshMarketplace(targets[i].id)
        } catch (e) {
          failed.push(`${targets[i].displayName}: ${(e as Error).message}`)
        }
      }
      // Re-probe so badges reflect the freshly-pulled state.
      await fetchUpdates()
    } finally {
      setBulkBusy(false)
      setBulkProgress(null)
    }
    const ok = targets.length - failed.length
    setBulkResult(
      failed.length === 0
        ? `Updated ${ok} marketplace${ok === 1 ? '' : 's'}.`
        : `Updated ${ok}/${targets.length}. Failed: ${failed.join('; ')}`,
    )
  }
```

Immediately before `return (` (after `handleTogglePlugin`, near line 263), add the derived values:

```tsx
  const updateableCount = items.filter((it) => updateById[it.id]?.hasUpdate).length
  const anyCheckError = items.some((it) => !!updateById[it.id]?.error)
```

Insert the toolbar row between the error block and the marketplace list — i.e. after the `{error && (...)}` block and before the `{/* Marketplace list ... */}` comment:

```tsx
      {!loading && items.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          {updateableCount > 0 ? (
            <button
              className="btn btn-primary"
              onClick={() => void handleUpdateAll()}
              disabled={bulkBusy}
              title="Refresh every marketplace that has an update available"
            >
              {bulkBusy && bulkProgress
                ? `Updating ${bulkProgress.done}/${bulkProgress.total}…`
                : `Update all (${updateableCount})`}
            </button>
          ) : !anyCheckError ? (
            <span style={{ fontSize: 12, color: 'var(--ok)' }}>All marketplaces up to date</span>
          ) : null}
          {bulkResult && (
            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{bulkResult}</span>
          )}
        </div>
      )}
```

Thread `bulkBusy` into the card. In `MarketplaceCard`'s JSX call site, add the prop:

```tsx
            onTogglePlugin={(name, enabled) => void handleTogglePlugin(item.id, name, enabled)}
            togglingPlugins={togglingKeys}
            bulkBusy={bulkBusy}
```

In `CardProps`, add the field:

```tsx
  /** Set of `<mpId>:<plugin>` keys with an in-flight toggle request. */
  togglingPlugins: Set<string>
  /** True while the bulk "Update all" loop runs — disables card actions. */
  bulkBusy: boolean
```

In the `MarketplaceCard` function signature, destructure `bulkBusy`:

```tsx
function MarketplaceCard({
  item, warnings, plugins, expanded, busy, confirmRemove, updateStatus, bulkBusy,
  onToggleExpand, onRefresh, onRequestRemove, onCancelRemove, onConfirmRemove, onTogglePlugin,
  togglingPlugins,
}: CardProps) {
```

Replace the four `disabled={busy}` uses with `disabled={busy || bulkBusy}` (Refresh button, Del button, Confirm button, Cancel button) and the card opacity `busy ? 0.7 : 1` with `busy || bulkBusy ? 0.7 : 1`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/components/MarketplaceTab.test.tsx`
Expected: PASS — all three tests.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck` and `npm run lint`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/components/MarketplaceTab.tsx src/components/MarketplaceTab.test.tsx
git commit -m "feat: add one-click update all to plugin marketplace tab

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: AppPluginMarketplaceSection — "Update all" bulk refresh + reinstall

**Files:**
- Create: `src/components/AppPluginMarketplaceSection.test.tsx`
- Modify: `src/components/AppPluginMarketplaceSection.tsx`

**Interfaces:**
- Consumes: existing `api` from `../hooks/useApi`, existing `refreshList()` callback (re-fetches `/app-plugins/marketplaces` into `marketplaces`), `marketplaces: AppPluginMarketplaceInfo[]` (has `id`, `displayName`, `sourceType: 'https' | 'local'`), `AppPluginMarketplacePlugin` type from `../../shared/app-plugins/marketplace.js`.
- Produces:
  - `handleUpdateAll(): Promise<void>` — three-phase bulk update. Skips `local` marketplaces.
  - `bulkBusy: boolean`, `bulkProgress: string | null`, `bulkResult: string | null` — new state.
  - Row buttons disable during the bulk run (`busy={busy || bulkBusy}` passed to `MarketplaceRow`).
  - Later consumed by nothing in this plan.

- [ ] **Step 1: Write the failing test**

Create `src/components/AppPluginMarketplaceSection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { AppPluginMarketplaceSection } from './AppPluginMarketplaceSection'
import type { AppPluginMarketplaceInfo } from '../../shared/app-plugins/marketplace.js'

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  apiRequest: vi.fn(),
}))

import { api } from '../hooks/useApi'

const mkMp = (id: string, sourceType: 'https' | 'local'): AppPluginMarketplaceInfo => ({
  id,
  displayName: `MP ${id}`,
  sourceType,
  url: sourceType === 'https' ? `https://github.com/x/${id}` : undefined,
  addedAt: 0,
  lastRefreshedAt: 0,
  lastSha: 'abc',
  pluginCount: 1,
})

const postCalls = () =>
  (api.post as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string)

describe('AppPluginMarketplaceSection Update all', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/app-plugins/marketplaces') {
        return Promise.resolve({
          marketplaces: [mkMp('mp1', 'https'), mkMp('mp2', 'local')],
        })
      }
      if (url === '/app-plugins/marketplaces/mp1/plugins') {
        return Promise.resolve({
          plugins: [
            { name: 'plugA', dir: 'plugA', version: '2.0', installed: true, installedVersion: '1.0' },
          ],
        })
      }
      return Promise.resolve({ plugins: [] })
    })
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/app-plugins/marketplaces/mp1/refresh') {
        return Promise.resolve({ ok: true, updated: true, marketplace: mkMp('mp1', 'https') })
      }
      if (url === '/app-plugins/marketplaces/mp1/plugins/plugA/install') {
        return Promise.resolve({ ok: true, result: { id: 'plugA', version: '2.0', permissionRequired: false } })
      }
      return Promise.resolve({})
    })
  })

  it('refreshes https marketplaces, discovers, and reinstalls the updated plugin; skips local', async () => {
    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(container.textContent).toContain('MP mp1'))

    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Update all'),
    )!
    fireEvent.click(btn)

    await waitFor(() =>
      expect(postCalls()).toContain('/app-plugins/marketplaces/mp1/refresh'),
    )
    expect(postCalls()).not.toContain('/app-plugins/marketplaces/mp2/refresh')
    await waitFor(() =>
      expect(postCalls()).toContain('/app-plugins/marketplaces/mp1/plugins/plugA/install'),
    )
    await waitFor(() => expect(container.textContent).toContain('Updated 1 plugin.'))
  })

  it('reports permission-required installs in the summary', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/app-plugins/marketplaces/mp1/refresh') {
        return Promise.resolve({ ok: true, updated: true, marketplace: mkMp('mp1', 'https') })
      }
      if (url === '/app-plugins/marketplaces/mp1/plugins/plugA/install') {
        return Promise.resolve({ ok: true, result: { id: 'plugA', version: '2.0', permissionRequired: true } })
      }
      return Promise.resolve({})
    })
    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(container.textContent).toContain('MP mp1'))

    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Update all'),
    )!
    fireEvent.click(btn)

    await waitFor(() =>
      expect(container.textContent).toContain('Updated 1 plugin. 1 need permission review (see Installed).'),
    )
  })

  it('shows an up-to-date note when no installed plugin has a newer catalog version', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/app-plugins/marketplaces') {
        return Promise.resolve({ marketplaces: [mkMp('mp1', 'https')] })
      }
      if (url === '/app-plugins/marketplaces/mp1/plugins') {
        return Promise.resolve({
          plugins: [
            { name: 'plugA', dir: 'plugA', version: '1.0', installed: true, installedVersion: '1.0' },
          ],
        })
      }
      return Promise.resolve({ plugins: [] })
    })
    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(container.textContent).toContain('MP mp1'))

    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Update all'),
    )!
    fireEvent.click(btn)

    await waitFor(() => expect(container.textContent).toContain('All plugins up to date.'))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/AppPluginMarketplaceSection.test.tsx`
Expected: FAIL — no "Update all" button exists; the first test's `find(b => b.textContent?.includes('Update all'))` throws (`btn` is `undefined`).

- [ ] **Step 3: Add state and the bulk handler**

In `src/components/AppPluginMarketplaceSection.tsx`, after the existing state declarations (near line 18), add:

```tsx
  // Bulk "Update all" — refresh every https marketplace to discover new
  // catalog versions, then reinstall each installed plugin whose version
  // changed. `bulkProgress` shows the current phase; `bulkResult` is the
  // completion summary.
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkProgress, setBulkProgress] = useState<string | null>(null)
  const [bulkResult, setBulkResult] = useState<string | null>(null)
```

After the `removeMp` callback (near line 60), add the handler:

```tsx
  const handleUpdateAll = async () => {
    const https = marketplaces.filter((m) => m.sourceType === 'https')
    if (https.length === 0) return
    setBulkBusy(true)
    setError(null)
    setBulkResult(null)
    const refreshErrors: string[] = []
    const installErrors: string[] = []
    const installs: { mpId: string; name: string }[] = []
    let permissionRequired = 0
    try {
      // Phase 1 — git-pull every https marketplace. This makes the new
      // catalog (and plugin code) available on disk, and revalidates each
      // installed plugin from that marketplace, but it does NOT bump the
      // record's installedVersion.
      setBulkProgress('Refreshing marketplaces…')
      for (const m of https) {
        try {
          await api.post(`/app-plugins/marketplaces/${encodeURIComponent(m.id)}/refresh`)
        } catch (e) {
          refreshErrors.push(`${m.displayName}: ${(e as Error).message}`)
        }
      }
      // Phase 2 — discover installed plugins with a newer catalog version.
      setBulkProgress('Checking for updates…')
      for (const m of https) {
        try {
          const res = await api.get<{ plugins: AppPluginMarketplacePlugin[] }>(
            `/app-plugins/marketplaces/${encodeURIComponent(m.id)}/plugins`,
          )
          for (const p of res.plugins ?? []) {
            if (p.installed && p.version && p.installedVersion && p.installedVersion !== p.version) {
              installs.push({ mpId: m.id, name: p.name })
            }
          }
        } catch {
          // A marketplace whose plugin list can't be read is skipped; its
          // per-plugin Update buttons remain available for manual updates.
        }
      }
      if (installs.length === 0) {
        setBulkResult(refreshErrors.length === 0 ? 'All plugins up to date.' : 'No updates found.')
        return
      }
      // Phase 3 — reinstall each changed plugin. This is what bumps the
      // record's installedVersion to the new version (the refresh above left
      // it stale) and surfaces permission escalations.
      for (let i = 0; i < installs.length; i++) {
        const it = installs[i]
        setBulkProgress(`Updating ${it.name} (${i + 1}/${installs.length})…`)
        try {
          const res = await api.post<{ ok: true; result: { permissionRequired: boolean } }>(
            `/app-plugins/marketplaces/${encodeURIComponent(it.mpId)}/plugins/${encodeURIComponent(it.name)}/install`,
          )
          if (res.result?.permissionRequired) permissionRequired++
        } catch (e) {
          installErrors.push(`${it.name}: ${(e as Error).message}`)
        }
      }
      await refreshList()
      const parts: string[] = []
      const ok = installs.length - installErrors.length
      parts.push(
        installErrors.length === 0
          ? `Updated ${ok} plugin${ok === 1 ? '' : 's'}.`
          : `Updated ${ok}/${installs.length}. Failed: ${installErrors.join('; ')}`,
      )
      if (permissionRequired > 0) {
        parts.push(`${permissionRequired} need permission review (see Installed).`)
      }
      if (refreshErrors.length > 0) {
        parts.push(`${refreshErrors.length} marketplace${refreshErrors.length === 1 ? '' : 's'} couldn't be refreshed: ${refreshErrors.join('; ')}`)
      }
      setBulkResult(parts.join(' '))
    } finally {
      setBulkBusy(false)
      setBulkProgress(null)
    }
  }
```

No import change needed — line 11 already imports both types:

```tsx
import type { AppPluginMarketplaceInfo, AppPluginMarketplacePlugin } from '../../shared/app-plugins/marketplace.js'
```

- [ ] **Step 4: Add the toolbar row and disable row actions during the bulk run**

Insert the toolbar row between the add-form block and the list — i.e. after the `{error && <div className="modal-error">{error}</div>}` line and before the `<ul className="app-plugins-list">`:

```tsx
      {marketplaces.length > 0 && (
        <div className="app-plugins-update-all" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <button
            className="btn btn-primary"
            onClick={() => void handleUpdateAll()}
            disabled={bulkBusy}
            title="Refresh marketplaces and update every installed plugin that has a new version"
          >
            {bulkBusy ? (bulkProgress ?? 'Updating…') : 'Update all'}
          </button>
          {bulkResult && <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{bulkResult}</span>}
        </div>
      )}
```

In the marketplace map, pass the combined busy flag to `MarketplaceRow`:

```tsx
        {marketplaces.map((mp) => (
          <MarketplaceRow
            key={mp.id}
            mp={mp}
            expanded={expanded === mp.id}
            onToggle={() => setExpanded(expanded === mp.id ? null : mp.id)}
            onRefresh={() => refreshMp(mp.id)}
            onRemove={() => removeMp(mp.id)}
            busy={busy || bulkBusy}
          />
        ))}
```

Also disable the Add button during the bulk run (its existing `disabled` is `busy || !addUrl.trim()`):

```tsx
        <button className="btn btn-primary" disabled={busy || bulkBusy || !addUrl.trim()} onClick={add}>Add</button>
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/components/AppPluginMarketplaceSection.test.tsx`
Expected: PASS — all three tests.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck` and `npm run lint`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/components/AppPluginMarketplaceSection.tsx src/components/AppPluginMarketplaceSection.test.tsx
git commit -m "feat: add one-click update all to app plugin marketplace section

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Full verification

**Files:**
- No code changes.

**Interfaces:**
- Consumes: the finished `MarketplaceTab` and `AppPluginMarketplaceSection` from Tasks 1-2.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass (server + client).

- [ ] **Step 2: Typecheck and lint the whole repo**

Run: `npm run typecheck` and `npm run lint`
Expected: both exit 0.

- [ ] **Step 3: Manual verification**

Launch the app (`npm run dev`), open Settings → Marketplace, and:

1. With at least one marketplace whose upstream has a commit beyond its `lastSha` and one up to date: the toolbar shows `Update all (1)`; clicking it pulls only the badged marketplace, clears its badge, and the summary reads `Updated 1 marketplace.`; the card stays usable after the run.
2. With an unreachable marketplace badged for update and a reachable one: clicking Update all pulls the reachable one, the summary reads `Updated 1/2. Failed: <name>: <error>`, and the unreachable card's error surface is unchanged.
3. Open Settings → App Plugins: with an installed plugin whose marketplace catalog has a newer version upstream, click `Update all` — it refreshes the marketplace, reinstalls the plugin, and reports `Updated 1 plugin.`; the installed list's version reflects the new version.
4. With a plugin whose new version escalates permissions: the summary includes `1 need permission review (see Installed).` and the plugin appears as `permission-required` in the Installed list.
5. With no updates available anywhere: the Marketplace tab shows `All marketplaces up to date`; the App Plugins section reports `All plugins up to date.`

- [ ] **Step 4: Commit any leftover files (none expected)**

If any fix was needed during verification, commit it with a message describing the fix. Otherwise no commit.
