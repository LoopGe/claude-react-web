# Built-in App Plugin marketplace entry (bundled into dist)

Date: 2026-08-12

## Problem

The App Plugin Marketplace is clone-only. `AppPluginMarketplaceStore` (persisted at `<stateDir>/app-plugins/marketplaces.json`) only ever contains marketplaces the user explicitly added via `POST /api/app-plugins/marketplaces` (or its UI), and there is no seeding at startup. The project's official plugins (`plugins/translator`, `plugins/idle-compact`) therefore never appear in the Marketplace unless the user knows to add a marketplace URL manually.

We want the official marketplace to show up automatically on a user's first-ever launch, **bundled into the npm package** — no runtime git clone, no network, offline-ready. The official plugins are small and co-versioned with the app, so shipping them inside `dist/` (and updating them with app releases) is the chosen distribution.

## Goal / non-goals

- **Goal:** on first-ever launch (store file absent), the App Plugin Marketplace automatically contains a fully-populated "Bundled" entry whose plugins are read directly from the installed `dist/plugins/` dir — instant, offline, no git.
- **Goal:** removal is respected — if the user deletes the built-in marketplace, it stays deleted (no re-seed on later restarts).
- **Non-goal:** runtime git clone for the built-in marketplace. No `subdir` support (that was only needed for the abandoned host-repo-clone approach).
- **Non-goal:** configurable source (config.json override). The bundled dir is derived from the module location.
- **Non-goal:** resurrecting the built-in entry for existing users (store file already present). They can add the GitHub marketplace URL manually.
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

`AppPluginMarketplaceRecord.source` becomes `AppPluginMarketplaceSource`. `AppPluginMarketplaceInfo` gains `sourceType: 'https' | 'local'` and `url` becomes optional (`url?: string`) so the client can render a "Bundled" label for local entries.

### 3. Store — coerce both sources, seed-once, never delete local dirs

`server/app-plugins/marketplace-store.ts`:

- `coerceRecord`: build the source union — `https` requires a `url` string (preserve optional `ref`); `local` requires a non-empty `path`; anything else → reject the record. `cloneDir` stays required (for `local` it equals `path`).
- `isFirstRun(): boolean` → `!existsSync(this.file)`. `file` is `protected`, so this lives on the store (add `existsSync` to the `node:fs` import).
- `seedBuiltinIfFirstRun(record): Promise<boolean>` — returns `false` when the store file already exists (not first run) or a record with that id is already present; otherwise `upsert(record)` + `await flush()` and return `true`. The explicit flush guarantees the file exists after boot 1, which is exactly the "first run" boundary the next boot checks.
- `removeEntry`: only `rm` the `cloneDir` when `source.type === 'https'`. A local/bundled dir is app code (`dist/plugins/`) and must never be deleted when the marketplace record is removed.

### 4. Parser — unchanged

`server/app-plugins/marketplace-parser.ts` is **not touched**. `parseAppPluginMarketplace(dir)` already reads `app-plugins-marketplace.json` at the root, and the bundled layout is exactly that shape. `pluginDirInClone` is unchanged.

### 5. Routes — branch refresh on source type

`server/app-plugins/marketplace-routes.ts`:

- `POST /` unchanged (https-only user-added marketplaces).
- `POST /:id/refresh`: branch on `record.source.type`:
  - `local`: re-parse `parseAppPluginMarketplace(record.cloneDir)`, update `manifest` + `lastRefreshedAt`, flush, then revalidate every plugin installed from this marketplace (same loop as the https branch). No git.
  - `https`: the existing `gitPull` path.
- `GET /` / `GET /:id/plugins` / install route / `DELETE /:id`: unchanged (the delete route already uninstalls the marketplace's plugins; `removeEntry` now guards the local dir).
- `toInfo`: set `sourceType: r.source.type` and `url` only when present.

### 6. New module — `server/app-plugins/builtin-marketplace.ts`

Constants:

```ts
export const BUILTIN_MARKETPLACE_ID = 'claude-react-web-plugins'
export const BUILTIN_MARKETPLACE_DISPLAY_NAME = 'Claude React Web Plugins'
```

- `resolveBundledPluginsDir(): string | null` — walk candidates (mirror `resolveClientDir` in `server/app.ts`), marker = `app-plugins-marketplace.json`:
  - `join(here, 'plugins')` — when bundled as `dist/cli.mjs` → `dist/plugins`
  - `join(here, '..', 'plugins')` — when running `tsx server/cli.ts` from `server/` → `<repo>/plugins`
  where `here = dirname(fileURLToPath(import.meta.url))`.
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

### 8. Client — "Bundled" label

`src/components/AppPluginMarketplaceSection.tsx`, `MarketplaceRow` meta line: when `mp.sourceType === 'local'`, render "Bundled with app" instead of `mp.url` (keep the `{mp.pluginCount} plugins` count). Everything else — expand / Install / Refresh / Remove — is unchanged.

### Behavior matrix

| Scenario | Behavior |
|---|---|
| Fresh state dir, first launch | Seed a fully-populated local marketplace from `dist/plugins/` — instant, offline |
| Later launches | Record persists with manifest; no re-seed |
| User removes the built-in entry | Record removed and its installed plugins uninstalled (existing marketplace-delete semantics); `dist/plugins/` untouched; no resurrection |
| `dist/plugins/` missing (broken install) | Seed warns and skips; boot unaffected |
| Existing user (store file already present) | Not auto-seeded; they can add the GitHub marketplace URL manually |
| App updated to a new version | Installed bundled plugins revalidate against the new `dist/plugins/` on next `initialize()` (existing path) |
| `--disable-app-plugins` | No seeding (routes absent) |

## Files touched

| File | Change |
|---|---|
| `build.mjs` | `cpSync('plugins', 'dist/plugins', …)` after the esbuild bundle |
| `shared/app-plugins/marketplace.ts` | `AppPluginMarketplaceSource` union; `source` typed as it; `AppPluginMarketplaceInfo.sourceType`, `url?` |
| `server/app-plugins/marketplace-store.ts` | `coerceRecord` handles both sources; `isFirstRun()`; `seedBuiltinIfFirstRun()`; `removeEntry` guards local dir; `existsSync` import |
| `server/app-plugins/marketplace-routes.ts` | refresh branches on source type; `toInfo` adds `sourceType` / optional `url` |
| `server/app-plugins/builtin-marketplace.ts` | **new** — constants, `resolveBundledPluginsDir`, `buildBuiltinRecord`, `seedBuiltinMarketplace` |
| `server/cli.ts` | call `seedBuiltinMarketplace` after store load (gated on `!disableAppPlugins`) |
| `src/components/AppPluginMarketplaceSection.tsx` | "Bundled" label for `sourceType === 'local'` |
| `server/app-plugins/marketplace-store.test.ts` | **new** — seed-once + `removeEntry` local-guard tests |
| `server/app-plugins/builtin-marketplace.test.ts` | **new** — dir resolution, record shape, seed no-op tests |
| `server/app-plugins/marketplace-routes.test.ts` | refresh for a `local` record (re-parse, no git) |

No parser, manager, or `package.json` changes.

## Testing (TDD)

1. **Store — seed-once.** `seedBuiltinIfFirstRun` seeds + persists when the store file is absent; returns `false` (no-op) when the file exists after a flush; returns `false` when a record with the same id is already present.
2. **Store — `removeEntry` keeps local dirs.** A `local` record's `cloneDir` survives `removeEntry`; an `https` record's `cloneDir` is deleted.
3. **builtin-marketplace — dir resolution.** `resolveBundledPluginsDir` finds a fixture dir containing `app-plugins-marketplace.json`; returns `null` when absent.
4. **builtin-marketplace — record shape + seed.** `buildBuiltinRecord` yields `source.type === 'local'`, `cloneDir === pluginsDir`, and a parsed non-empty manifest (fixture). `seedBuiltinMarketplace` with a pre-existing store file adds nothing.
5. **Routes — local refresh.** Pre-populate a `local` record pointing at a fixture dir; `POST /:id/refresh` re-parses and returns the fresh plugin count without invoking git and without mutating `cloneDir`.
6. **Regression — existing marketplace tests pass** (routing / install / parser) with the new source union (`https` records unchanged).

## Open questions / decisions

- **Confirmed:** bundled-into-`dist` is the chosen approach; no runtime git, no `subdir`.
- **Verified:** official plugins write through the host storage service, not their own source dir (the translator uses `storage.get` / `storage.set` for its cache), so a potentially read-only `dist/plugins/` is safe.
- The catalog (`plugins/app-plugins-marketplace.json`) currently lists only `translator`; `idle-compact` is on disk but not in the catalog. It will appear once added there — the built-in and the GitHub marketplace share the same catalog, so the fix is one file.
