# Built-in App Plugin marketplace entry (bundled into dist)

Date: 2026-08-12

## Problem

The App Plugin Marketplace is clone-only. `AppPluginMarketplaceStore` (persisted at `<stateDir>/app-plugins/marketplaces.json`) only ever contains marketplaces the user explicitly added via `POST /api/app-plugins/marketplaces` (or its UI), and there is no seeding at startup. The project's official plugins (`plugins/translator`, `plugins/idle-compact`) therefore never appear in the Marketplace unless the user knows to add a marketplace URL manually.

We want the official marketplace to show up automatically on a user's first-ever launch, **bundled into the npm package** — no runtime git clone, no network, offline-ready. The official plugins are small and co-versioned with the app, so shipping them inside `dist/` (and updating them with app releases) is the chosen distribution.

## Goal / non-goals

- **Goal:** on first-ever launch (store file absent), the App Plugin Marketplace automatically contains a fully-populated "Bundled" entry whose plugins are read directly from the installed `dist/plugins/` dir — instant, offline, no git.
- **Goal:** removal is respected — if the user deletes the built-in marketplace, it stays deleted (no re-seed on later restarts).
- **Goal:** marketplaces whose catalog lives in a **subdirectory** of their root work end-to-end (`subdir` on records, threaded through parser / install / refresh / add-API), so existing users can add `https://github.com/LoopGe/claude-react-web` with `subdir: 'plugins'`.
- **Non-goal:** runtime git clone for the built-in marketplace itself (the bundled entry is `local`-source, never cloned).
- **Non-goal:** configurable source (config.json override). The bundled dir is derived from the module location.
- **Non-goal:** auto-resurrecting the built-in entry for existing users (store file already present). They can add the GitHub marketplace URL + `subdir` manually.
- **Non-goal:** changing `package.json` — `"files": ["dist"]` already ships everything under `dist/`, so a `dist/plugins` produced at build time ships automatically.

## Design

### 1. Build — copy `plugins/` into `dist/plugins/`

`build.mjs`, after the esbuild bundle + chmod step:

```js
import { cpSync } from 'node:fs'

// Ship the official App Plugin marketplace with the package so the built-in
// marketplace works offline without a runtime git clone. Test files excluded.
cpSync('plugins', 'dist/plugins', {
  recursive: true,
  filter: (src) => !/\.test\.(ts|js|tsx|jsx)$/.test(src),
})
```

The copied layout matches what the parser already expects: `dist/plugins/app-plugins-marketplace.json` at the root, one subdirectory per plugin (`dist/plugins/translator/` with `crw-plugin.json` + prebuilt `dist/service.mjs`).

### 2. Shared types — local source variant

`shared/app-plugins/marketplace.ts`:

```ts
export type AppPluginMarketplaceSource =
  | { type: 'https'; url: string; ref?: string }
  | { type: 'local'; path: string }
```

`AppPluginMarketplaceRecord.source` becomes `AppPluginMarketplaceSource`, and the record gains an optional `subdir?: string` — a contained relative path within `cloneDir` that holds the marketplace content (the official host repo keeps its catalog in `plugins/`, so a marketplace seeded from it uses `subdir: 'plugins'`; absent = content at the clone root). `AppPluginMarketplaceInfo` gains `sourceType: 'https' | 'local'`, optional `url` / `ref` / `subdir` so the client can render a "Bundled" label for local entries and show the subdir on https entries.

### 3. Store — coerce both sources, seed-once, never delete local dirs

`server/app-plugins/marketplace-store.ts`:

- `coerceRecord`: build the source union — `https` requires a `url` string (preserve optional `ref`); `local` requires a non-empty `path`; anything else → reject the record. `cloneDir` stays required (for `local` it equals `path`). Optional `subdir` is validated with `validateRelativePath` (rejecting escaping / absolute values); an invalid subdir drops the whole record.
- `isFirstRun(): boolean` → `!existsSync(this.file)`. `file` is `protected`, so this lives on the store (add `existsSync` to the `node:fs` import).
- `seedBuiltinIfFirstRun(record): Promise<boolean>` — returns `false` when the store file already exists (not first run) or a record with that id is already present; otherwise `upsert(record)` + `await flush()` and return `true`. The explicit flush guarantees the file exists after boot 1, which is exactly the "first run" boundary the next boot checks.
- `removeEntry`: only `rm` the `cloneDir` when `source.type === 'https'`. A local/bundled dir is app code (`dist/plugins/`) and must never be deleted when the marketplace record is removed.

### 4. Parser — subdir threading

`server/app-plugins/marketplace-parser.ts` gains an optional `subdir` parameter on both public functions so a marketplace can keep its catalog in a nested dir:

- `parseAppPluginMarketplace(repoRoot, subdir?)` — parses `subdir ? join(repoRoot, subdir) : repoRoot` (manifest + auto-scan).
- `pluginDirInClone(repoRoot, dir, subdir?)` — resolves `dir` inside the effective root.
- Private `marketplaceRoot(repoRoot, subdir?)` is the single validation point: validates `subdir` via `validateRelativePath` and throws on invalid (defense-in-depth; the record layer also validates on persist).

The bundled layout (`dist/plugins/app-plugins-marketplace.json` at the root) is exactly the no-subdir shape, so the built-in entry calls the parser without a subdir.

`server/app-plugins/app-plugin-manager.ts` `resolveInstallSource` passes `mp.subdir` into `pluginDirInClone` so installs from subdir marketplaces resolve correctly — the existing realpath containment check still holds, because a subdir-resolved dir is inside the clone.

### 5. Routes — branch refresh on source type + subdir in add/refresh/info

`server/app-plugins/marketplace-routes.ts`:

- `POST /` accepts an optional validated `subdir` in the body, stores it on the record, and parses the clone with `parseAppPluginMarketplace(cloneDir, subdir)` (so existing users can add the official GitHub URL + `subdir: 'plugins'`).
- `POST /:id/refresh`: branch on `record.source.type`:
  - `local`: re-parse `parseAppPluginMarketplace(record.cloneDir, record.subdir)`, update `manifest` + `lastRefreshedAt`, flush, then revalidate every plugin installed from this marketplace (same loop as the https branch). No git.
  - `https`: the existing `gitPull` path, then re-parse with `record.subdir`.
- `GET /` / `GET /:id/plugins` / install route / `DELETE /:id`: unchanged (the delete route already uninstalls the marketplace's plugins; `removeEntry` now guards the local dir; install delegates to the manager, which threads `mp.subdir`).
- `toInfo`: set `sourceType: r.source.type`, `url` / `ref` only when the source is `https`, and `subdir` when present.

### 6. New module — `server/app-plugins/builtin-marketplace.ts`

Constants:

```ts
export const BUILTIN_MARKETPLACE_ID = 'claude-react-web-plugins'
export const BUILTIN_MARKETPLACE_DISPLAY_NAME = 'Claude React Web Plugins'
```

- `resolveBundledPluginsDir(): string | null` — walk candidates (mirror `resolveClientDir` in `server/app.ts`), marker = `app-plugins-marketplace.json`:
  - `join(here, 'plugins')` — when bundled as `dist/cli.mjs` → `dist/plugins`
  - `join(here, '..', '..', 'plugins')` — when running `tsx server/cli.ts` from `server/app-plugins/` → `<repo>/plugins`
  where `here = dirname(fileURLToPath(import.meta.url))`. (The dev candidate is `../..` because the module lives at `server/app-plugins/`.)
- `buildBuiltinRecord(store, pluginsDir): Promise<AppPluginMarketplaceRecord>` — `manifest = await parseAppPluginMarketplace(pluginsDir)` (synchronous local read, fully populated from the start), `source: { type: 'local', path: pluginsDir }`, `cloneDir: pluginsDir`, `lastSha: ''`, timestamps `Date.now()`.
- `seedBuiltinMarketplace(store): Promise<void>` — resolve the dir (warn + return if absent, e.g. a broken install), `buildBuiltinRecord`, then `await store.seedBuiltinIfFirstRun(record)`. Any error is caught and logged — seeding must never break boot. **No background clone**: the local parse is instant.

### 7. CLI wiring

`server/cli.ts`, right after `await appPluginMarketplaceStore.load()` (≈ line 356):

```ts
if (!args.disableAppPlugins) {
  await seedBuiltinMarketplace(appPluginMarketplaceStore)
}
```

Gated on `--disable-app-plugins` because in that mode the marketplace routes are not mounted and seeding is pointless.

### 8. Client — "Bundled" label + subdir

`src/components/AppPluginMarketplaceSection.tsx`, `MarketplaceRow`: when `mp.sourceType === 'local'`, render a `Bundled` chip next to the name and "Bundled with app" instead of `mp.url` (keep the `{mp.pluginCount} plugins` count); for `https` entries render `{mp.url}{mp.subdir ? ` / ${mp.subdir}` : ''}`. Everything else — expand / Install / Refresh / Remove — is unchanged.

### Behavior matrix

| Scenario | Behavior |
|---|---|
| Fresh state dir, first launch | Seed a fully-populated local marketplace from `dist/plugins/` — instant, offline |
| Later launches | Record persists with manifest; no re-seed |
| User removes the built-in entry | Record removed and its installed plugins uninstalled (existing marketplace-delete semantics); `dist/plugins/` untouched; no resurrection |
| `dist/plugins/` missing (broken install) | Seed warns and skips; boot unaffected |
| Existing user (store file already present) | Not auto-seeded; can add `https://github.com/LoopGe/claude-react-web` + `subdir: 'plugins'` manually |
| Marketplace catalog in a subdir | Parser / install / refresh resolve `cloneDir/subdir`; invalid `subdir` rejected at add-time and at load-time |
| App updated to a new version | Installed bundled plugins revalidate against the new `dist/plugins/` on next `initialize()` (existing path) |
| `--disable-app-plugins` | No seeding (routes absent) |

## Files touched

| File | Change |
|---|---|
| `build.mjs` | `cpSync('plugins', 'dist/plugins', …)` after the esbuild bundle |
| `shared/app-plugins/marketplace.ts` | `AppPluginMarketplaceSource` union; `source` typed as it; record gains `subdir?`; `AppPluginMarketplaceInfo.sourceType`, `url?`, `subdir?` |
| `server/app-plugins/marketplace-store.ts` | `coerceRecord` handles both sources + validates `subdir`; `isFirstRun()`; `seedBuiltinIfFirstRun()`; `removeEntry` guards local dir; `existsSync` + `validateRelativePath` imports |
| `server/app-plugins/marketplace-parser.ts` | optional `subdir` on `parseAppPluginMarketplace` / `pluginDirInClone`; private `marketplaceRoot` validation |
| `server/app-plugins/app-plugin-manager.ts` | `resolveInstallSource` passes `mp.subdir` to `pluginDirInClone` |
| `server/app-plugins/marketplace-routes.ts` | POST `/` accepts `subdir`; refresh branches on source type + passes `record.subdir`; `toInfo` adds `sourceType` / optional `url` / `subdir` |
| `server/app-plugins/builtin-marketplace.ts` | **new** — constants, `resolveBundledPluginsDir`, `buildBuiltinRecord`, `seedBuiltinMarketplace` |
| `server/cli.ts` | call `seedBuiltinMarketplace` after store load (gated on `!disableAppPlugins`) |
| `src/components/AppPluginMarketplaceSection.tsx` | "Bundled" label for `sourceType === 'local'`; subdir shown on https entries |
| `server/app-plugins/marketplace-store.test.ts` | **new** — seed-once + `removeEntry` local-guard + subdir-coerce tests |
| `server/app-plugins/builtin-marketplace.test.ts` | **new** — dir resolution, record shape, seed no-op tests |
| `server/app-plugins/marketplace-parser.test.ts` | subdir parser tests (manifest / auto-scan / invalid throw / dir resolution) |
| `server/app-plugins/marketplace-install.test.ts` | subdir install test (content under `clone/subdir/pluginName`) |
| `server/app-plugins/marketplace-routing.test.ts` | refresh for a `local` record (re-parse, no git) + refresh for a subdir marketplace |

No `package.json` changes.

## Testing (TDD)

1. **Store — seed-once.** `seedBuiltinIfFirstRun` seeds + persists when the store file is absent; returns `false` (no-op) when the file exists after a flush; returns `false` when a record with the same id is already present.
2. **Store — `removeEntry` keeps local dirs.** A `local` record's `cloneDir` survives `removeEntry`; an `https` record's `cloneDir` is deleted.
3. **builtin-marketplace — dir resolution.** `resolveBundledPluginsDir` finds a fixture dir containing `app-plugins-marketplace.json`; returns `null` when absent.
4. **builtin-marketplace — record shape + seed.** `buildBuiltinRecord` yields `source.type === 'local'`, `cloneDir === pluginsDir`, and a parsed non-empty manifest (fixture). `seedBuiltinMarketplace` with a pre-existing store file adds nothing.
5. **Routes — local refresh.** Pre-populate a `local` record pointing at a fixture dir; `POST /:id/refresh` re-parses and returns the fresh plugin count without invoking git and without mutating `cloneDir`.
6. **Regression — existing marketplace tests pass** (routing / install / parser) with the new source union (`https` records unchanged).
7. **Store — subdir coerce.** A persisted record with a valid `subdir` loads with it; a record with an escaping `subdir` (`../escape`) is dropped.
8. **Parser — subdir.** `parseAppPluginMarketplace(root, 'plugins')` reads a manifest at `root/plugins`; auto-scan works in the subdir; an invalid subdir throws; `pluginDirInClone` resolves inside the subdir.
9. **Manager — subdir install.** `install({ type: 'marketplace', marketplaceId, pluginName })` resolves the plugin from `cloneDir/subdir/pluginName`.
10. **Routes — subdir refresh.** `POST /:id/refresh` on a subdir record re-parses inside the subdir and returns `subdir` in the response.

## Open questions / decisions

- **Confirmed:** bundled-into-`dist` is the chosen approach; the built-in entry uses no runtime git and no `subdir` (its catalog is at `dist/plugins/` root).
- **Confirmed:** `subdir` is supported end-to-end for https (and local) marketplaces — parser / install / refresh / add-API — so existing users can add the official GitHub URL manually.
- **Verified:** official plugins write through the host storage service, not their own source dir (the translator uses `storage.get` / `storage.set` for its cache), so a potentially read-only `dist/plugins/` is safe.
- The catalog (`plugins/app-plugins-marketplace.json`) currently lists only `translator`; `idle-compact` is on disk but not in the catalog. It will appear once added there — the built-in and the GitHub marketplace share the same catalog, so the fix is one file.
