// Git-repo marketplace routes. This is the sole plugin-marketplace
// implementation. It:
//   1. Clones the user's https git URL into our own state-dir cache.
//   2. Parses .claude-plugin/marketplace.json (or plugin.json for a single-
//      plugin repo) ourselves.
//   3. Stores marketplace + per-plugin enabled state in MpStore.
//   4. Pushes enable/disable changes into every live session via the
//      SessionManager so mid-conversation toggles take effect immediately.
//
// All paths live under /api/mp/*.

import { Hono } from 'hono'
import { mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HttpError } from '../errors.js'
import { safeJson } from './index.js'
import type { SessionManager } from '../session-manager.js'
import { MpStore, type MpEntry } from '../mp-store.js'
import {
  assertHttpsUrl,
  gitBranchName,
  gitClone,
  gitCloneAtSha,
  gitGetHeadSha,
  gitLsRemoteHead,
  gitPull,
} from '../git-clone.js'
import { parseRepoManifest, type ParsedPlugin, type ParsedPluginSource } from '../marketplace-parser.js'
import { createLogger } from '../log.js'

const log = createLogger('mp-marketplace')

/** Narrow to just the git-subdir variant of the source union. */
type GitSubdirSource = Extract<ParsedPluginSource, { kind: 'git-subdir' }>

/** Same charset rule the CLI marketplace router uses. Applied to :id and
 *  :plugin so user-supplied path params can't escape into the filesystem
 *  or carry shell-meta payloads. */
function assertSafeName(name: string, label: string): void {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(name) || name.startsWith('.')) {
    throw new HttpError(400, `invalid ${label}: "${name}" — must match [a-zA-Z0-9._-] and not start with a dot`)
  }
}

/** Lightweight DTO for marketplace listings. Strips the cached manifest
 *  to keep the response small; per-plugin detail lives behind /plugins. */
interface MpListItem {
  id: string
  displayName: string
  source: MpEntry['source'] & { branch?: string }
  addedAt: number
  lastRefreshedAt: number
  lastSha: string
  pluginCount: number
  /** How many of this marketplace's plugins are currently enabled. In B,
   *  enabling a plugin IS installing it, so this doubles as the "installed"
   *  count the UI shows next to the total. */
  enabledCount: number
  manifestVersion?: string
  ownerName?: string
}

function toListItem(e: MpEntry, store: MpStore): MpListItem {
  const enabledMap = store.enabledMapFor(e.id)
  const enabledCount = e.manifest.plugins.reduce(
    (n, p) => (enabledMap[p.name] === true ? n + 1 : n),
    0,
  )
  // Surface the branch the clone is actually checked out on, so the UI can
  // show it even when the marketplace was added without an explicit ref (a
  // default-branch clone). The branch is resolved once at clone/refresh time
  // and persisted on MpEntry; for pre-branch records fall back to the
  // user-specified ref so we never hide what the user asked for. NOTE:
  // `branch` is informational for display only — `e.source.ref` remains the
  // source of truth for update checks (gitLsRemoteHead).
  return {
    id: e.id,
    displayName: e.displayName,
    source: { ...e.source, branch: e.branch ?? e.source.ref },
    addedAt: e.addedAt,
    lastRefreshedAt: e.lastRefreshedAt,
    lastSha: e.lastSha,
    pluginCount: e.manifest.plugins.length,
    enabledCount,
    manifestVersion: e.manifest.version,
    ownerName: e.manifest.owner?.name,
  }
}

/** Plugin DTO. The on-disk dir is intentionally NOT exposed — clients
 *  don't need it and surfacing absolute paths from the server's own
 *  state dir leaks irrelevant filesystem details into the API. */
interface PluginListItem {
  name: string
  description?: string
  version?: string
  author?: string
  category?: string
  tags?: string[]
  enabled: boolean
}

function toPluginListItem(p: ParsedPlugin, enabled: boolean): PluginListItem {
  return {
    name: p.name,
    description: p.description,
    version: p.version,
    author: p.author,
    category: p.category,
    tags: p.tags,
    enabled,
  }
}

/** Per-marketplace update-check result. Mirrors `MpUpdateStatus` in
 *  src/types.ts — kept as a server-local interface because the server
 *  doesn't import client types. `hasUpdate` is true when the upstream tip
 *  differs from the stored `lastSha` (a Refresh would move HEAD). */
interface MpUpdateStatusItem {
  id: string
  hasUpdate: boolean
  remoteSha?: string
  error?: string
}

export function buildMpRouter(sm: SessionManager, store: MpStore): Hono {
  const app = new Hono()

  // ─── Marketplace listing ─────────────────────────────────────────

  app.get('/mp/marketplaces', (c) => {
    // Pure in-memory read: toListItem no longer hits git (the branch is
    // persisted on MpEntry at clone/refresh time), so a slow/hung clone dir
    // can't block the listing, and there's no per-entry async failure to
    // isolate.
    const items = store.list().map((e) => toListItem(e, store))
    items.sort((a, b) => a.displayName.localeCompare(b.displayName))
    return c.json({ marketplaces: items })
  })

  // ─── Check for updates (non-mutating) ─────────────────────────────

  app.post('/mp/marketplaces/check-updates', async (c) => {
    const entries = store.list()
    // `git ls-remote` each upstream and compare to the stored lastSha.
    // Promise.allSettled isolates per-marketplace failures (dead URL,
    // auth-required repo, timeout) so one bad marketplace doesn't blank
    // the result for the rest. No disk / store mutation here — pure read.
    const settled = await Promise.allSettled(
      entries.map(async (e) => {
        const remoteSha = await gitLsRemoteHead(e.source.url, e.source.ref)
        return { id: e.id, hasUpdate: remoteSha !== e.lastSha, remoteSha } satisfies MpUpdateStatusItem
      }),
    )
    const updates: MpUpdateStatusItem[] = settled.map((r, i) => {
      const id = entries[i].id
      if (r.status === 'fulfilled') return r.value
      // Distinguish abort/timeout/network from a thrown HttpError message.
      const reason = r.reason
      const msg =
        reason instanceof HttpError
          ? reason.message
          : reason instanceof Error
            ? reason.message
            : String(reason)
      log.warn(`check-updates failed for ${id}: ${msg.slice(0, 200)}`)
      return { id, hasUpdate: false, error: msg.slice(0, 300) }
    })
    return c.json({ ok: true, updates })
  })

  // ─── Add ─────────────────────────────────────────────────────────

  app.post('/mp/marketplaces', async (c) => {
    const body = await safeJson<{ url?: unknown; ref?: unknown }>(c.req)
    const url = typeof body.url === 'string' ? body.url.trim() : ''
    if (!url) throw new HttpError(400, 'url is required')
    assertHttpsUrl(url)
    const ref = typeof body.ref === 'string' && body.ref.trim() ? body.ref.trim() : undefined

    const id = store.generateId(url)
    const cloneDir = store.cloneDirFor(id)

    // Mkdir the parent (cache root) before clone — git itself creates the
    // final dest dir. If the user wiped their state dir mid-session, the
    // base JsonFileStore won't have re-created the cache subdir for us.
    await mkdir(dirname(cloneDir), { recursive: true })

    // Clone failures leave nothing behind (git's clone is atomic w.r.t.
    // the dest dir — failure means the dir wasn't created or was
    // partial; either way we don't track the entry, so the HttpError
    // from gitClone propagates straight out.
    await gitClone(url, cloneDir, { ref })

    let parseResult
    try {
      parseResult = await parseRepoManifest(cloneDir)
    } catch (err) {
      // Parse failure means we've cloned a repo that isn't a plugin source we
      // recognise (no marketplace.json and no plugin.json, or a malformed
      // manifest). Tear down the clone before rethrowing — keeping it around
      // would orphan disk space and confuse the user.
      try {
        const { rm } = await import('node:fs/promises')
        await rm(cloneDir, { recursive: true, force: true })
      } catch { /* best-effort cleanup */ }
      throw new HttpError(400, `plugin source parse failed: ${(err as Error).message}`)
    }

    const sha = await gitGetHeadSha(cloneDir)
    // Resolve the checked-out branch once here (not per list request). A
    // default-branch clone has no explicit ref, so this is what the UI shows.
    // Falls back to the user's ref on a failed resolve (detached HEAD, etc.).
    const branch = (await gitBranchName(cloneDir)) || ref || undefined
    const now = Date.now()
    const entry: MpEntry = {
      id,
      displayName: parseResult.manifest.name || id,
      source: { type: 'https', url, ref },
      cloneDir,
      addedAt: now,
      lastRefreshedAt: now,
      lastSha: sha,
      branch,
      manifest: parseResult.manifest,
    }
    store.upsert(entry)
    await store.flush()

    return c.json({
      ok: true,
      entry: toListItem(entry, store),
      warnings: parseResult.warnings,
    })
  })

  // ─── Refresh ─────────────────────────────────────────────────────

  app.post('/mp/marketplaces/:id/refresh', async (c) => {
    const id = c.req.param('id')
    assertSafeName(id, 'marketplace id')
    const entry = store.get(id)
    if (!entry) throw new HttpError(404, `marketplace ${id} not found`)
    const { newSha, updated } = await gitPull(entry.cloneDir)
    const parseResult = await parseRepoManifest(entry.cloneDir)
    const next: MpEntry = {
      ...entry,
      lastRefreshedAt: Date.now(),
      lastSha: newSha,
      manifest: parseResult.manifest,
      // Update displayName from manifest in case the upstream renamed.
      displayName: parseResult.manifest.name || entry.displayName,
      // Re-resolve the branch after the pull (the remote may have switched
      // its default branch; --ff-only keeps us on the same one either way).
      branch: (await gitBranchName(entry.cloneDir)) || entry.source.ref || undefined,
    }
    store.upsert(next)
    await store.flush()
    // A refresh may bump pinned shas in the manifest. For any git-subdir
    // plugin still enabled, re-materialise its clone at the NEW sha before
    // pruning — otherwise the plugin would silently drop from sessions
    // (its old-sha clone gets GC'd and the new one was never cloned).
    const enabledMap = store.enabledMapFor(id)
    for (const p of next.manifest.plugins) {
      if (p.source?.kind === 'git-subdir' && enabledMap[p.name] === true) {
        try {
          await ensureExternalClone(store, p.source)
        } catch (err) {
          log.warn(`refresh re-clone failed for ${p.name}@${id}: ${(err as Error).message}`)
        }
      }
    }
    // GC external clones no longer referenced by any enabled plugin.
    await store.pruneExternalClones()
    return c.json({
      ok: true,
      entry: toListItem(next, store),
      updated,
      warnings: parseResult.warnings,
    })
  })

  // ─── Remove ──────────────────────────────────────────────────────

  app.delete('/mp/marketplaces/:id', async (c) => {
    const id = c.req.param('id')
    assertSafeName(id, 'marketplace id')
    const confirm = c.req.query('confirm')
    if (confirm !== 'true') {
      throw new HttpError(400, 'confirm=true required for destructive remove')
    }
    if (!store.has(id)) throw new HttpError(404, `marketplace ${id} not found`)

    // Best-effort: tell every live session to disable the plugins from
    // this marketplace BEFORE we drop the entry, so the SDK doesn't
    // briefly see stale enabled flags pointing at a deleted dir.
    const removedKeys = store.enabledKeys().filter((k) => k.endsWith(`@${id}`))
    for (const key of removedKeys) {
      await applyToggleToLiveSessions(sm, key, false)
    }

    await store.removeEntry(id)
    return c.json({ ok: true })
  })

  // ─── Plugin list ─────────────────────────────────────────────────

  app.get('/mp/marketplaces/:id/plugins', (c) => {
    const id = c.req.param('id')
    assertSafeName(id, 'marketplace id')
    const entry = store.get(id)
    if (!entry) throw new HttpError(404, `marketplace ${id} not found`)
    const enabledMap = store.enabledMapFor(id)
    const plugins = entry.manifest.plugins.map((p) => toPluginListItem(p, enabledMap[p.name] === true))
    plugins.sort((a, b) => a.name.localeCompare(b.name))
    return c.json({ plugins })
  })

  // ─── Toggle plugin enable/disable ────────────────────────────────

  app.post('/mp/marketplaces/:id/plugins/:plugin/toggle', async (c) => {
    const id = c.req.param('id')
    const plugin = c.req.param('plugin')
    assertSafeName(id, 'marketplace id')
    assertSafeName(plugin, 'plugin name')
    const entry = store.get(id)
    if (!entry) throw new HttpError(404, `marketplace ${id} not found`)
    if (!entry.manifest.plugins.find((p) => p.name === plugin)) {
      throw new HttpError(404, `plugin ${plugin} not in marketplace ${id}`)
    }
    const body = await safeJson<{ enabled?: unknown }>(c.req)
    if (typeof body.enabled !== 'boolean') {
      throw new HttpError(400, 'enabled boolean required')
    }
    const enabled = body.enabled

    // For git-subdir plugins, enabling IS installing: the plugin's files
    // live in a SEPARATE repo that hasn't been cloned yet. Clone + checkout
    // the pinned sha BEFORE persisting the enable flag, so a successful
    // toggle always corresponds to an on-disk plugin. Clone failure aborts
    // the toggle (the HttpError propagates; nothing is enabled).
    const pluginEntry = entry.manifest.plugins.find((p) => p.name === plugin)!
    if (enabled && pluginEntry.source?.kind === 'git-subdir') {
      await ensureExternalClone(store, pluginEntry.source)
    }

    // Persist FIRST so a server restart mid-toggle leaves the store in
    // a coherent state. The live-session push is best-effort and can
    // miss without losing user intent.
    store.setEnabled(plugin, id, enabled)
    await store.flush()

    // Push to every live session. We use the SDK's "<plugin>@<marketplace>"
    // key shape directly — applyFlagSettings forwards the dict to the CLI
    // subprocess which interprets it identically to the disk-based
    // enabledPlugins setting.
    const key = MpStore.keyOf(plugin, id)
    await applyToggleToLiveSessions(sm, key, enabled)

    // Disabling a git-subdir plugin may free its (full, no-depth) external
    // clone. GC it if nothing else still references that (url, sha).
    if (!enabled && pluginEntry.source?.kind === 'git-subdir') {
      await store.pruneExternalClones()
    }

    return c.json({
      ok: true,
      plugin: toPluginListItem(
        entry.manifest.plugins.find((p) => p.name === plugin)!,
        enabled,
      ),
    })
  })

  // ─── Enabled plugins (flat list for plugin picker) ──────────────

  app.get('/mp/enabled-plugins', (c) => {
    const plugins = store.enabledPluginEntries()
    return c.json({ plugins })
  })

  return app
}

/** Ensure the external repo backing a git-subdir plugin is cloned and
 *  checked out at the pinned sha. Idempotent:
 *   - clone dir absent → full clone + checkout sha
 *   - clone dir present at the right sha → no-op
 *   - clone dir present but stale/corrupt → wipe + re-clone
 *  On failure the partial clone is removed and the error propagates so the
 *  caller leaves the plugin disabled. */
async function ensureExternalClone(store: MpStore, src: GitSubdirSource): Promise<void> {
  const cloneDir = store.externalCloneDir(src.url, src.sha)
  if (existsSync(cloneDir)) {
    // A complete clone at the right sha → reuse. Anything else (wrong sha,
    // or a partial clone with no/.broken .git) → wipe so the clone below
    // doesn't fail on a non-empty destination.
    if (existsSync(join(cloneDir, '.git'))) {
      try {
        const head = await gitGetHeadSha(cloneDir)
        // src.sha may be abbreviated; accept a prefix match.
        if (head === src.sha || head.startsWith(src.sha)) return
      } catch {
        /* fall through to re-clone */
      }
    }
    await rm(cloneDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  }
  await mkdir(dirname(cloneDir), { recursive: true })
  try {
    await gitCloneAtSha(src.url, cloneDir, { sha: src.sha, ref: src.ref })
  } catch (err) {
    await rm(cloneDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

/** Walk every live session and push the plugin toggle through. Failures
 *  on a single session are swallowed (logged) so one stuck session can't
 *  block toggles for the rest. The next spawn of any failed session will
 *  pick up the persisted state via spawn-time injection anyway. */
async function applyToggleToLiveSessions(
  sm: SessionManager,
  pluginKey: string,
  enabled: boolean,
): Promise<void> {
  // Iterate via the SessionManager's public surface. We need ids of
  // running sessions only — list() returns hibernated ones too.
  const ids: string[] = []
  for (const info of sm.list()) {
    if (info.running) ids.push(info.id)
  }
  for (const id of ids) {
    try {
      await sm.togglePlugin(id, pluginKey, enabled)
      // togglePlugin already calls applyFlagSettings; reloadPlugins picks
      // up changes that came from disk-side plugin path mutations. For a
      // pure enable-flag toggle on a path the SDK already knows, it's a
      // no-op — but cheap, and required when the underlying plugin set
      // changed (e.g. immediately after `marketplace refresh` adds a
      // new plugin).
      await sm.reloadPlugins(id)
    } catch (err) {
      log.warn(`live toggle failed for session ${id}: ${(err as Error).message}`)
    }
  }
}
