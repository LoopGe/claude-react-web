# Built-in App Plugin marketplace entry

Date: 2026-08-12

## Problem

The App Plugin Marketplace is clone-only. `AppPluginMarketplaceStore` (persisted at `<stateDir>/app-plugins/marketplaces.json`) only ever contains marketplaces the user explicitly added via `POST /api/app-plugins/marketplaces` (or its UI), and there is no seeding at startup. The project's official plugins (`plugins/translator`, `plugins/idle-compact`) therefore never appear in the Marketplace unless the user knows to add a marketplace URL manually.

We want the official marketplace to show up automatically on a user's first-ever launch, without bundling plugin source into the npm package (`package.json` `"files": ["dist"]` stays untouched). The chosen source is the host repo itself (`https://github.com/LoopGe/claude-react-web`), which requires resolving the catalog from the `plugins/` subdirectory because:

- `marketplace-parser.ts` reads `app-plugins-marketplace.json` at the **clone root** (or auto-scans **top-level** subdirectories for `crw-plugin.json`).
- The host repo root has no `app-plugins-marketplace.json`; the catalog lives at `plugins/app-plugins-marketplace.json`, and plugin manifests are two levels deep (`plugins/translator/crw-plugin.json`). A plain clone of the host repo parses to **zero plugins**.

## Goal / non-goals

- **Goal:** on a user's first-ever launch (store file absent), the App Plugin Marketplace automatically contains an "official" entry pointing at the host repo, resolving the catalog from `plugins/`. The clone+parse happens in the background so the list is already populated by the time the UI is opened. No plugin source is bundled into the npm package.
- **Goal:** removal is respected — if the user deletes the built-in marketplace, it stays deleted (no re-seed on later restarts).
- **Non-goal:** bundling `plugins/` into `dist/` or changing `package.json` `files` / `build.mjs`. The marketplace remains a runtime clone.
- **Non-goal:** client changes. The built-in entry is an ordinary marketplace row (expand / install / Refresh / Remove all work through the existing UI). `AppPluginMarketplaceSection.tsx` is untouched.
- **Non-goal:** configurable URL (`config.json` override). The URL is a hardcoded constant per the decision.
- **Non-goal:** resurrecting the built-in entry for existing users (store file already present). They can add the URL manually.

## Design

### 1. Shared type — `source.subdir`

`shared/app-plugins/marketplace.ts` — extend the marketplace record source to optionally point at a subdirectory of the cloned repo:

```ts
source: { type: 'https'; url: string; ref?: string; subdir?: string }
```

`AppPluginMarketplaceInfo` (the client DTO) is **unchanged** — the UI does not need `subdir`.

### 2. Store — first-run seed + preserve subdir

`server/app-plugins/marketplace-store.ts`:

- `coerceRecord`: preserve `r.source.subdir` (a non-empty string) into the coerced record so a persisted built-in record round-trips through restart correctly.
- `isFirstRun(): boolean` — returns `!existsSync(this.file)`. `file` is `protected`, so this lives on the store (add `existsSync` to the `node:fs` import).
- `seedBuiltinIfFirstRun(record): Promise<boolean>` — returns `false` when the store file already exists (not first run) or a record with that id is already present; otherwise `upsert(record)` + `await flush()` and return `true`. The explicit flush guarantees the file exists after boot 1, which is exactly the "first run" boundary the next boot checks.

### 3. Parser — subdir variants

`server/app-plugins/marketplace-parser.ts`:

- `parseAppPluginMarketplace(repoRoot, subdir?)`: when `subdir` is given, resolve the catalog root as `join(repoRoot, subdir)` for both the `app-plugins-marketplace.json` read and the auto-scan fallback. `subdir` is trusted for the built-in constant; the user-facing POST route validates it (below).
- `pluginDirInClone(repoRoot, dir, subdir?)`: `resolvePath(repoRoot, subdir ?? '.', dir)` so install resolves `cloneDir/plugins/<name>`.

### 4. Routes — accept and thread subdir

`server/app-plugins/marketplace-routes.ts`:

- `POST /`: accept optional `subdir` in the body; validate it with `validateRelativePath(subdir, { isWindows })` (rejects absolute / `..` / traversal) and include it in `record.source.subdir`; pass it to `parseAppPluginMarketplace`.
- `POST /:id/refresh`: `parseAppPluginMarketplace(record.cloneDir, record.source.subdir)`.
- `GET /` / `GET /:id/plugins` / install route: unchanged (install reads `record.manifest.plugins`; the manager resolves the dir).

### 5. Manager — thread subdir into install resolution

`server/app-plugins/app-plugin-manager.ts`, `resolveInstallSource` (marketplace branch):

```ts
const dir = pluginDirInClone(mp.cloneDir, entry.dir, mp.source.subdir)
```

The existing symlink-escape check (`realpath` both sides + `isPathInside` against `mp.cloneDir`) is unchanged and still holds: `cloneDir/plugins/<name>` is inside `cloneDir`.

### 6. New module — `server/app-plugins/builtin-marketplace.ts`

Constants:

```ts
export const BUILTIN_MARKETPLACE_ID = 'claude-react-web-plugins'
export const BUILTIN_MARKETPLACE_DISPLAY_NAME = 'Claude React Web Plugins'
export const BUILTIN_MARKETPLACE_URL = 'https://github.com/LoopGe/claude-react-web'
export const BUILTIN_MARKETPLACE_SUBDIR = 'plugins'
```

Functions:

- `buildBuiltinRecord(store)`: a full `AppPluginMarketplaceRecord` with `id` / `displayName` / `source: { type: 'https', url, subdir }`, `cloneDir = store.cloneDirFor(id)`, empty `manifest: { plugins: [] }`, `lastSha: ''`, timestamps `0`.
- `seedBuiltinMarketplace(store)`:
  1. `await store.seedBuiltinIfFirstRun(buildBuiltinRecord(store))`.
  2. `const existing = store.get(BUILTIN_MARKETPLACE_ID)`.
  3. If `existing` and `existing.manifest.plugins.length === 0`, kick off `void populateBuiltin(store)`. This means: first run seeds empty and populates in the background; a later boot that finds the record still-empty (e.g. the first-run clone was offline) retries the populate once more; a deleted record (`get` → undefined) is left alone. Fire-and-forget, never blocks boot.
- `populateBuiltin(store)`:
  1. `rm` any stale `cloneDir` (the built-in cache is throwaway), then `gitClone(BUILTIN_MARKETPLACE_URL, cloneDir)`.
  2. `parseAppPluginMarketplace(cloneDir, BUILTIN_MARKETPLACE_SUBDIR)` and `gitGetHeadSha(cloneDir)`.
  3. Re-fetch the record (the user may have removed it mid-clone — if gone, return); `upsert({ ...record, manifest, lastRefreshedAt: Date.now(), lastSha })` + `await flush()`.
  4. Any error is `log.warn` and non-fatal — the empty record stays visible and the user can hit Refresh.

### 7. CLI wiring

`server/cli.ts`, right after `await appPluginMarketplaceStore.load()` (≈ line 356):

```ts
if (!args.disableAppPlugins) {
  await seedBuiltinMarketplace(appPluginMarketplaceStore)
}
```

Gated on `--disable-app-plugins` because in that mode the marketplace routes are not mounted and seeding is pointless.

### Behavior matrix

| Scenario | Behavior |
|---|---|
| Fresh state dir, first launch | Seed empty record → background clone+parse → Marketplace already populated when opened |
| First launch but offline | Empty record appears; user can Refresh; the next launch retries the background populate while the manifest is still empty (self-healing) |
| Later launches | Record persists with manifest; no re-seed, no re-clone |
| User removes the built-in entry | Deleted; later launches do not resurrect it (store file exists) |
| Existing user (store file already present) | Not auto-seeded; they can add the URL manually |
| `--disable-app-plugins` | No seeding (routes absent) |

## Files touched

| File | Change |
|---|---|
| `shared/app-plugins/marketplace.ts` | `source.subdir?: string` on `AppPluginMarketplaceRecord` |
| `server/app-plugins/marketplace-store.ts` | `coerceRecord` preserves `subdir`; `isFirstRun()`; `seedBuiltinIfFirstRun()`; `existsSync` import |
| `server/app-plugins/marketplace-parser.ts` | `subdir` params on `parseAppPluginMarketplace` and `pluginDirInClone` |
| `server/app-plugins/marketplace-routes.ts` | `POST /` accepts+validates `subdir`; refresh threads `record.source.subdir` |
| `server/app-plugins/app-plugin-manager.ts` | `resolveInstallSource` passes `mp.source.subdir` to `pluginDirInClone` |
| `server/app-plugins/builtin-marketplace.ts` | **new** — constants + `buildBuiltinRecord` / `seedBuiltinMarketplace` / `populateBuiltin` |
| `server/cli.ts` | call `seedBuiltinMarketplace` after store load (gated on `!args.disableAppPlugins`) |
| `server/app-plugins/marketplace-store.test.ts` | first-run seed tests |
| `server/app-plugins/marketplace-parser.test.ts` | subdir parse + containment tests |
| `server/app-plugins/builtin-marketplace.test.ts` | **new** — record shape + seed no-op tests |
| `server/app-plugins/marketplace-routing.test.ts` | POST with `subdir` against a local git repo fixture |

No client, `package.json`, or `build.mjs` changes.

## Testing (TDD)

1. **Store — first-run seed.** `seedBuiltinIfFirstRun` returns `true` and persists when the store file is absent; returns `false` (no-op) when the file exists after a flush; returns `false` when a record with the same id is already present.
2. **Parser — subdir catalog.** `parseAppPluginMarketplace(dir, 'plugins')` reads `plugins/app-plugins-marketplace.json`; without `subdir` the same fixture parses to zero plugins (guards the regression this feature fixes).
3. **Parser — `pluginDirInClone` containment.** With `subdir`, resolving a relative `dir` stays under `cloneDir`; `..` / absolute are rejected by the existing `validateRelativePath` used at catalog-coercion time.
4. **builtin-marketplace — record shape.** `buildBuiltinRecord` yields the right `id` / `source.url` / `source.subdir` / `cloneDir` under the store's cache dir / empty manifest.
5. **builtin-marketplace — seed no-op.** With a store whose file already exists, `seedBuiltinMarketplace` does not add a record and does not kick off a populate.
6. **Routing — subdir clone/parse.** Mirror the existing `marketplace-routing.test.ts` local git-repo fixture: `POST /marketplaces { url, subdir: 'plugins' }` clones, parses the subdir catalog, and `GET /:id/plugins` lists the plugins; `POST /:id/refresh` re-parses through `source.subdir`.
7. **Regression — existing marketplace tests still pass** (routing / install / parser) with the new optional `subdir` field absent.

## Open questions / decisions

- **Confirmed:** the built-in URL is a hardcoded constant (`https://github.com/LoopGe/claude-react-web`) pointing at the host repo, resolving the catalog from the `plugins/` subdir. No config override.
- **Confirmed:** seeding only happens when the store file is absent (first-ever launch); a deleted built-in stays deleted.
- The `plugins/app-plugins-marketplace.json` catalog lists `translator` today; `idle-compact` is in the directory but not yet in the catalog. That catalog is the source of truth — no change needed here, but worth noting that `idle-compact` will only appear once added there.
