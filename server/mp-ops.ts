// Operations over the homegrown git-repo marketplace store, shared by the
// REST routes and first-party tools. Everything here is a pure store/manager
// operation: the route layer keeps HTTP concerns (body parsing, response
// envelopes) and this module owns the DTO shapes and the multi-step flows.

import { mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MpStore, type MpEntry } from './mp-store.js'
import type { SessionManager } from './session-manager.js'
import {
  assertHttpsUrl,
  gitBranchName,
  gitClone,
  gitCloneAtSha,
  gitGetHeadSha,
  gitLsRemoteHead,
} from './git-clone.js'
import {
  parseRepoManifest,
  type ParseWarning,
  type ParsedPlugin,
  type ParsedPluginSource,
} from './marketplace-parser.js'
import { HttpError } from './errors.js'
import { createLogger } from './log.js'
import { LOG_PREVIEW_CAP, ERROR_DETAIL_CAP } from './constants.js'

const log = createLogger('mp-ops')

/** Narrow to just the git-subdir variant of the source union. */
type GitSubdirSource = Extract<ParsedPluginSource, { kind: 'git-subdir' }>

/** Same charset rule the CLI marketplace router uses. Applied to ids and
 *  plugin names so user-supplied values can't escape into the filesystem or
 *  carry shell-meta payloads. */
export function assertSafeName(name: string, label: string): void {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(name) || name.startsWith('.')) {
    throw new HttpError(400, `invalid ${label}: "${name}" — must match [a-zA-Z0-9._-] and not start with a dot`)
  }
}

/** Lightweight DTO for marketplace listings. Strips the cached manifest to
 *  keep the response small; per-plugin detail lives behind /plugins. */
export interface MpListItem {
  id: string
  displayName: string
  source: MpEntry['source'] & { branch?: string }
  addedAt: number
  lastRefreshedAt: number
  lastSha: string
  pluginCount: number
  /** How many of this marketplace's plugins are currently enabled. Enabling a
   *  plugin IS installing it, so this doubles as the "installed" count the UI
   *  shows next to the total. */
  enabledCount: number
  manifestVersion?: string
  ownerName?: string
}

export function toMpListItem(e: MpEntry, store: MpStore): MpListItem {
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

/** Plugin DTO. The on-disk dir is intentionally NOT exposed — clients don't
 *  need it and surfacing absolute paths from the server's own state dir leaks
 *  irrelevant filesystem details into the API. */
export interface PluginListItem {
  name: string
  description?: string
  version?: string
  author?: string
  category?: string
  tags?: string[]
  enabled: boolean
}

export function toPluginListItem(p: ParsedPlugin, enabled: boolean): PluginListItem {
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
 *  src/types.ts — kept as a server-local interface because the server doesn't
 *  import client types. `hasUpdate` is true when the upstream tip differs from
 *  the stored `lastSha` (a Refresh would move HEAD). */
export interface MpUpdateStatusItem {
  id: string
  hasUpdate: boolean
  remoteSha?: string
  error?: string
}

/** Every marketplace as a display DTO, sorted by display name. Pure in-memory
 *  read: the branch is persisted on MpEntry at clone/refresh time, so no git
 *  process runs here and a slow/hung clone dir can't block the listing. */
export function listMarketplaces(store: MpStore): MpListItem[] {
  const items = store.list().map((e) => toMpListItem(e, store))
  items.sort((a, b) => a.displayName.localeCompare(b.displayName))
  return items
}

/** Plugin DTOs for one marketplace, sorted by name. */
export function listMarketplacePlugins(store: MpStore, id: string): PluginListItem[] {
  const entry = store.get(id)
  if (!entry) throw new HttpError(404, `marketplace ${id} not found`)
  const enabledMap = store.enabledMapFor(id)
  const plugins = entry.manifest.plugins.map((p) => toPluginListItem(p, enabledMap[p.name] === true))
  plugins.sort((a, b) => a.name.localeCompare(b.name))
  return plugins
}

/** `git ls-remote` each upstream and compare to the stored lastSha.
 *  Promise.allSettled isolates per-marketplace failures (dead URL,
 *  auth-required repo, timeout) so one bad marketplace doesn't blank the
 *  result for the rest. No disk / store mutation here — pure read. */
export async function checkMarketplaceUpdates(store: MpStore): Promise<MpUpdateStatusItem[]> {
  const entries = store.list()
  const settled = await Promise.allSettled(
    entries.map(async (e) => {
      const remoteSha = await gitLsRemoteHead(e.source.url, e.source.ref)
      return { id: e.id, hasUpdate: remoteSha !== e.lastSha, remoteSha } satisfies MpUpdateStatusItem
    }),
  )
  return settled.map((r, i) => {
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
    log.warn(`check-updates failed for ${id}: ${msg.slice(0, LOG_PREVIEW_CAP)}`)
    return { id, hasUpdate: false, error: msg.slice(0, ERROR_DETAIL_CAP) }
  })
}

/** Walk every live session and push the plugin toggle through. Failures on a
 *  single session are swallowed (logged) so one stuck session can't block
 *  toggles for the rest. The next spawn of any failed session will pick up the
 *  persisted state via spawn-time injection anyway. */
export async function applyPluginToggleToLiveSessions(
  sm: SessionManager,
  pluginKey: string,
  enabled: boolean,
): Promise<void> {
  // Iterate via the SessionManager's public surface. We need ids of running
  // sessions only — list() returns hibernated ones too.
  const ids: string[] = []
  for (const info of sm.list()) {
    if (info.running) ids.push(info.id)
  }
  for (const id of ids) {
    try {
      await sm.togglePlugin(id, pluginKey, enabled)
      // togglePlugin already calls applyFlagSettings; reloadPlugins picks up
      // changes that came from disk-side plugin path mutations. For a pure
      // enable-flag toggle on a path the SDK already knows, it's a no-op — but
      // cheap, and required when the underlying plugin set changed (e.g.
      // immediately after `marketplace refresh` adds a new plugin).
      await sm.reloadPlugins(id)
    } catch (err) {
      log.warn(`live toggle failed for session ${id}: ${(err as Error).message}`)
    }
  }
}

/** Enable/disable one plugin of one marketplace. This is the tool-facing
 *  entry point, so it validates the ids itself instead of trusting the caller's
 *  route params. */
export async function setMarketplacePluginEnabled(
  store: MpStore,
  sm: SessionManager,
  id: string,
  plugin: string,
  enabled: boolean,
): Promise<PluginListItem> {
  assertSafeName(id, 'marketplace id')
  assertSafeName(plugin, 'plugin name')
  const entry = store.get(id)
  if (!entry) throw new HttpError(404, `marketplace ${id} not found`)
  const pluginEntry = entry.manifest.plugins.find((p) => p.name === plugin)
  if (!pluginEntry) {
    throw new HttpError(404, `plugin ${plugin} not in marketplace ${id}`)
  }

  // For git-subdir plugins, enabling IS installing: the plugin's files live in
  // a SEPARATE repo that hasn't been cloned yet. Clone + checkout the pinned
  // sha BEFORE persisting the enable flag, so a successful toggle always
  // corresponds to an on-disk plugin. Clone failure aborts the toggle (the
  // HttpError propagates; nothing is enabled).
  if (enabled && pluginEntry.source?.kind === 'git-subdir') {
    await ensureExternalClone(store, pluginEntry.source)
  }

  // Persist FIRST so a server restart mid-toggle leaves the store in a
  // coherent state. The live-session push is best-effort and can miss without
  // losing user intent.
  store.setEnabled(plugin, id, enabled)
  await store.flush()

  // Push to every live session. We use the SDK's "<plugin>@<marketplace>" key
  // shape directly — applyFlagSettings forwards the dict to the CLI subprocess
  // which interprets it identically to the disk-based enabledPlugins setting.
  const key = MpStore.keyOf(plugin, id)
  await applyPluginToggleToLiveSessions(sm, key, enabled)

  // Disabling a git-subdir plugin may free its (full, no-depth) external
  // clone. GC it if nothing else still references that (url, sha).
  if (!enabled && pluginEntry.source?.kind === 'git-subdir') {
    await store.pruneExternalClones()
  }

  return toPluginListItem(pluginEntry, enabled)
}

/** Ensure the external repo backing a git-subdir plugin is cloned and checked
 *  out at the pinned sha. Idempotent:
 *   - clone dir absent → full clone + checkout sha
 *   - clone dir present at the right sha → no-op
 *   - clone dir present but stale/corrupt → wipe + re-clone
 *  On failure the partial clone is removed and the error propagates so the
 *  caller leaves the plugin disabled. */
export async function ensureExternalClone(store: MpStore, src: GitSubdirSource): Promise<void> {
  const cloneDir = store.externalCloneDir(src.url, src.sha)
  if (existsSync(cloneDir)) {
    // A complete clone at the right sha → reuse. Anything else (wrong sha, or a
    // partial clone with no/.broken .git) → wipe so the clone below doesn't
    // fail on a non-empty destination.
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

export interface AddMarketplaceResult {
  entry: MpEntry
  warnings: ParseWarning[]
}

/** Clone a git-repo plugin marketplace by URL, parse its manifest, and
 *  persist the entry. Shared by the REST route and the CLI. */
export async function addMarketplaceByUrl(
  store: MpStore,
  opts: { url: string; ref?: string },
): Promise<AddMarketplaceResult> {
  const { url, ref } = opts
  assertHttpsUrl(url)
  const id = store.generateId(url)
  const cloneDir = store.cloneDirFor(id)
  await mkdir(dirname(cloneDir), { recursive: true })
  await gitClone(url, cloneDir, { ref })
  let parseResult
  try {
    parseResult = await parseRepoManifest(cloneDir)
  } catch (err) {
    try { await rm(cloneDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    throw new HttpError(400, `plugin source parse failed: ${(err as Error).message}`)
  }
  const sha = await gitGetHeadSha(cloneDir)
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
  return { entry, warnings: parseResult.warnings }
}
