// Built-in ("Bundled") App Plugin marketplace seeding.
//
// The official plugins ship inside the npm package at dist/plugins/ (copied
// there by build.mjs). On the very first launch the marketplace store is
// seeded with a single `local`-source record pointing at that bundled dir, so
// the App Plugin Marketplace shows the official plugins immediately, offline,
// with no runtime git clone. Seeding is failure-safe: any error is logged and
// never blocks boot.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from '../log.js'
import { parseAppPluginMarketplace } from './marketplace-parser.js'
import type { AppPluginMarketplaceStore } from './marketplace-store.js'
import type { AppPluginMarketplaceRecord } from '../../shared/app-plugins/marketplace.js'

const log = createLogger('app-plugins:builtin')

export const BUILTIN_MARKETPLACE_ID = 'claude-react-web-plugins'
export const BUILTIN_MARKETPLACE_DISPLAY_NAME = 'Claude React Web Plugins'

/** Marker file that identifies a directory as an App Plugin marketplace. */
const MARKETPLACE_FILE = 'app-plugins-marketplace.json'

/** Locate the bundled plugins dir at runtime. Mirrors resolveClientDir in
 *  server/app.ts: walk a few candidates so both the bundled dist/cli.mjs
 *  (sibling dist/plugins/) and source `tsx server/cli.ts` (repo-root
 *  plugins/) work without config. */
export function resolveBundledPluginsDir(): string | null {
  return resolvePluginsDirFrom(dirname(fileURLToPath(import.meta.url)))
}

/** Candidate walk, exported for tests. `here` is a module dir. */
export function resolvePluginsDirFrom(here: string): string | null {
  const candidates = [
    join(here, 'plugins'),            // bundled as dist/cli.mjs → dist/plugins
    join(here, '..', '..', 'plugins'), // tsx dev from server/app-plugins → <repo>/plugins
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, MARKETPLACE_FILE))) return dir
  }
  return null
}

/** Build the seeded built-in marketplace record from the bundled dir. The
 *  manifest is parsed eagerly (a local read) so the entry is fully populated
 *  from the very first render. No subdir — the bundled dir already has the
 *  catalog at its root. */
export async function buildBuiltinRecord(pluginsDir: string): Promise<AppPluginMarketplaceRecord> {
  const manifest = await parseAppPluginMarketplace(pluginsDir)
  const now = Date.now()
  return {
    id: BUILTIN_MARKETPLACE_ID,
    displayName: BUILTIN_MARKETPLACE_DISPLAY_NAME,
    source: { type: 'local', path: pluginsDir },
    cloneDir: pluginsDir,
    addedAt: now,
    lastRefreshedAt: now,
    lastSha: '',
    manifest,
  }
}

/** Seed the built-in marketplace on first launch. No-op when the store file
 *  already exists (later launches — the record persists, and a removed
 *  built-in stays removed). `pluginsDir` is optional for tests; it defaults
 *  to the runtime-resolved bundled dir. Any error is logged, never fatal. */
export async function seedBuiltinMarketplace(store: AppPluginMarketplaceStore, pluginsDir?: string): Promise<void> {
  const dir = pluginsDir ?? resolveBundledPluginsDir()
  if (!dir) {
    log.warn('bundled app plugins marketplace not found; skipping built-in seed')
    return
  }
  if (!existsSync(dir)) {
    log.warn(`bundled plugins dir does not exist: ${dir}; skipping built-in seed`)
    return
  }
  try {
    const record = await buildBuiltinRecord(dir)
    await store.seedBuiltinIfFirstRun(record)
  } catch (err) {
    log.warn(`failed to seed built-in marketplace: ${(err as Error).message}`)
  }
}
