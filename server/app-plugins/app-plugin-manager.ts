// AppPluginManager — the single orchestration entry point for App Plugins.
//
// Coordinates the store (persistence), manifest-loader (validation),
// contribution-registry (static UI surface), and event-bus (WS broadcast).
// It does NOT duplicate SessionManager's responsibilities and does NOT talk
// to the SDK.
//
// Stage B1 scope: the static state machine — initialize / list / install /
// enable / disable / uninstall — plus WS snapshot+state+contributions
// broadcast. Command execution (subprocess + Host API), configuration,
// storage, and secrets are Stage B2; their methods are present but stubbed
// so the REST surface compiles and the management UI can land against a
// stable shape.

import { promises as fs } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { createLogger } from '../log.js'
import { HttpError } from '../errors.js'
import { AppPluginStore } from './app-plugin-store.js'
import { ContributionRegistry } from './contribution-registry.js'
import { AppPluginEventBus, type AppPluginBroadcaster } from './event-bus.js'
import { loadManifest, resolvePluginDir } from './manifest-loader.js'
import { AppPluginMarketplaceStore } from './marketplace-store.js'
import { pluginDirInClone } from './marketplace-parser.js'
import { PluginProcessManager } from './plugin-process-manager.js'
import { ConfigurationStore } from './configuration-store.js'
import { newInvocationId } from './rpc-peer.js'
import { diffPermissions, normalisePermissions, type PermissionSpec } from '../../shared/app-plugins/permissions.js'
import { canTransition, EPHEMERAL_RUNTIME_STATES, type AppPluginClientInfo, type AppPluginRecord, type PluginRuntimeState, type PluginSourceBase } from '../../shared/app-plugins/runtime-state.js'
import { isPathInside } from '../../shared/app-plugins/path-security.js'
import type { PluginManifest } from '../../shared/app-plugins/manifest.js'
import type { ResolvedPluginContributions } from '../../shared/app-plugins/contributions.js'
import type { PluginCommandContext } from '../../shared/app-plugins/command-context.js'
import type { PluginCommandResult, PluginCommandErrorCode } from '../../shared/app-plugins/command-result.js'
import type { SessionManager } from '../session-manager.js'

const log = createLogger('app-plugins')

export interface AppPluginManagerOptions {
  store: AppPluginStore
  stateDir: string
  hostVersion: string
  hostNodeMajor: number
  /** SessionManager — passed to host adapters (sessions/git/workspace). */
  sm: SessionManager
  /** Whether the host is Windows (path-security + spawn). Defaults to
   *  process.platform check. */
  isWindows?: boolean
  /** When true, the manager loads but refuses to activate any plugin
   *  (CLI --safe-mode). Static contributions still register. */
  safeMode?: boolean
  /** When true, the whole subsystem is off (CLI --disable-app-plugins):
   *  initialize is a no-op, list() is empty. */
  disabled?: boolean
  /** Marketplace store — required to resolve `marketplace` install sources
   *  (the plugin dir lives inside a cloned marketplace repo) and to find
   *  plugins by marketplace on refresh/remove. Optional so tests/local-dir
   *  use work without it. */
  marketplaceStore?: AppPluginMarketplaceStore
}

export type InstallSource =
  | { type: 'local'; path: string }
  | { type: 'marketplace'; marketplaceId: string; pluginName: string }

export interface InstallResult {
  id: string
  version: string
  /** Fresh installs capture consent by the install call itself; this is
   *  always false on first install. An update that broadens permissions
   *  sets this true and leaves the new version disabled. */
  permissionRequired: boolean
}

export class AppPluginManager implements AppPluginBroadcaster {
  private readonly store: AppPluginStore
  private readonly stateDir: string
  private readonly hostVersion: string
  private readonly hostNodeMajor: number
  private readonly isWindows: boolean
  private readonly safeMode: boolean
  readonly disabled: boolean
  private readonly sm: SessionManager
  private readonly marketplaceStore?: AppPluginMarketplaceStore
  private readonly contributions = new ContributionRegistry()
  private readonly bus = new AppPluginEventBus()
  private readonly pm: PluginProcessManager
  /** In-flight commands keyed by invocationId, for cancel-on-session-cleared
   *  and cancel-on-disable. Carries pluginId so cancellation can be scoped
   *  to the plugin being torn down (not every plugin's commands). */
  private readonly inFlight = new Map<string, { pluginId: string; sessionId?: string; controller: AbortController; proc?: { cancelCommand: (invocationId: string) => void }; cancelCode?: PluginCommandErrorCode }>()
  /** Per-plugin ConfigurationStore cache (created lazily on first access). */
  private readonly configStores = new Map<string, ConfigurationStore>()

  constructor(opts: AppPluginManagerOptions) {
    this.store = opts.store
    this.stateDir = opts.stateDir
    this.hostVersion = opts.hostVersion
    this.hostNodeMajor = opts.hostNodeMajor
    this.isWindows = opts.isWindows ?? (typeof process !== 'undefined' && process.platform === 'win32')
    this.safeMode = !!opts.safeMode
    this.disabled = !!opts.disabled
    this.sm = opts.sm
    this.marketplaceStore = opts.marketplaceStore
    this.pm = new PluginProcessManager({
      stateDir: this.stateDir,
      sm: opts.sm,
      isWindows: this.isWindows,
      onCrash: (pluginId, crashes) => this.handleCrash(pluginId, crashes),
      onActivated: (pluginId) => this.markActive(pluginId),
      onEvent: (pluginId, widgetId, payload) => this.bus.emitPluginEvent(pluginId, widgetId, payload),
    })
  }

  /** Transition a plugin inactive → active after its subprocess activated.
   *  No-op if the plugin was disabled/uninstalled in the meantime. */
  private markActive(pluginId: string): void {
    const record = this.store.get(pluginId)
    if (!record || !record.enabled) return
    if (record.runtimeState === 'active') return
    if (!canTransition(record.runtimeState, 'active')) return
    const next = this.transition({ ...record }, 'active', undefined)
    this.store.upsert(next)
    void this.store.flush().catch((err) => log.warn(`markActive flush: ${(err as Error).message}`))
    this.refreshSnapshot()
    this.broadcastChanged(next)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /** Load the registry and re-validate every record against its on-disk
   *  manifest. Records whose manifest vanished or no longer validates
   *  transition to `corrupted`/`incompatible`; enabled+compatible plugins
   *  get their static contributions registered (no subprocess in B1). */
  async initialize(): Promise<void> {
    if (this.disabled) return
    const records = await this.store.load()
    let dirty = false
    for (const record of records) {
      // No subprocess survives a restart: clamp ephemeral persisted states
      // (live-process states + crashed) back to `inactive`; the full
      // rationale — and why `quarantined` is excluded — lives on
      // EPHEMERAL_RUNTIME_STATES in runtime-state.ts.
      let r = record
      if (r.enabled && EPHEMERAL_RUNTIME_STATES.has(r.runtimeState)) {
        r = this.transition({ ...r }, 'inactive', undefined)
      }
      r = await this.revalidateRecord(r)
      if (r !== record) {
        // Persist the clamped/revalidated record back into the in-memory
        // index (the loop mutates a local; without this upsert the store
        // keeps the stale loaded state and the next flush would rewrite it).
        this.store.upsert(r)
        dirty = true
      }
      this.maybeRegisterContributions(r)
    }
    if (dirty) await this.store.flush()
    this.refreshSnapshot()
    log.info(`initialized with ${records.length} app plugin(s)${this.safeMode ? ' (safe mode)' : ''}`)
    await this.activateStartupPlugins()
  }

  /** Activate every enabled plugin that declares `onStartup` in its
   *  activationEvents, so background watchers start without a command being
   *  invoked. Called once at boot (end of initialize()) and from enable() for
   *  newly-enabled onStartup plugins. Gated on `runtimeState === 'inactive'`:
   *  quarantined, permission-required, incompatible, or corrupted records are
   *  skipped — a quarantined plugin (3 crashes in 5 min) stays down until the
   *  user intervenes. (A stale persisted `crashed` was already clamped to
   *  `inactive` earlier in initialize().) Failures are logged, never fatal
   *  — one bad plugin must not block boot or enable. */
  private async activateStartupPlugins(): Promise<void> {
    if (this.safeMode) return
    for (const record of this.store.list()) {
      if (!record.enabled) continue
      if (record.runtimeState !== 'inactive') continue
      const manifest = record.manifest as PluginManifest | undefined
      if (!manifest?.activationEvents?.includes('onStartup')) continue
      try {
        await this.pm.ensureActive(record)
        log.info(`[${record.id}] activated onStartup`)
      } catch (err) {
        log.warn(`[${record.id}] onStartup activation failed: ${(err as Error).message}`)
      }
    }
  }

  /** Re-validate a record's manifest from disk. Returns the same record
   *  reference when nothing changed (so initialize doesn't spurious-flush),
   *  or a new record with updated manifest/state. Missing dir / failed
   *  parse → `corrupted`; engines/manifestVersion mismatch → `incompatible`. */
  private async revalidateRecord(record: AppPluginRecord): Promise<AppPluginRecord> {
    let dir: string
    try {
      dir = await resolvePluginDir(record.source.path)
    } catch (err) {
      if (record.runtimeState === 'corrupted' && record.lastError === (err as Error).message) return record
      return this.transition({ ...record }, 'corrupted', (err as Error).message)
    }
    let loaded
    try {
      loaded = await loadManifest(dir, { hostVersion: this.hostVersion, hostNodeMajor: this.hostNodeMajor })
    } catch (err) {
      if (record.runtimeState === 'corrupted' && record.lastError === (err as Error).message) return record
      return this.transition({ ...record }, 'corrupted', (err as Error).message)
    }
    const { manifest, hash, validation } = loaded
    const manifestChanged = hash !== record.manifestHash
    const pathChanged = dir !== record.source.path

    if (!validation.ok) {
      const msg = `manifest invalid: ${validation.errors.join('; ')}`
      if (!manifestChanged && record.runtimeState === 'incompatible' && record.lastError === msg) return record
      return this.transition({ ...record, manifest, manifestHash: hash, source: { ...record.source, path: dir } }, 'incompatible', msg)
    }
    // Compatible. Clear incompatible/corrupted if previously set; otherwise
    // only mutate if the manifest actually changed.
    const wasBad = record.runtimeState === 'incompatible' || record.runtimeState === 'corrupted'
    if (!manifestChanged && !pathChanged && !wasBad) return record

    // If the manifest changed (e.g. a marketplace `gitPull` pulled a new
    // version), diff permissions: an escalation → permission-required so the
    // plugin doesn't (re-)activate with new code that needs capabilities the
    // user hasn't consented to. Checked regardless of `enabled` — a disabled
    // plugin that absorbed an escalated manifest during refresh must still
    // gate enable() on re-consent (canTransition disabled→permission-required
    // is legal). Mirrors the install update path.
    if (manifestChanged) {
      const diff = diffPermissions(record.grantedPermissions, validation.permissions)
      if (diff.isEscalation) {
        return this.transition(
          { ...record, manifest, manifestHash: hash, source: { ...record.source, path: dir } },
          'permission-required',
          'new version requires additional permissions',
        )
      }
    }
    return this.transition(
      { ...record, manifest, manifestHash: hash, source: { ...record.source, path: dir } },
      record.enabled ? 'inactive' : 'disabled',
      undefined,
    )
  }

  private maybeRegisterContributions(record: AppPluginRecord): void {
    if (!record.enabled) return
    if (record.runtimeState !== 'inactive' && record.runtimeState !== 'active' && record.runtimeState !== 'crashed' && record.runtimeState !== 'quarantined') return
    const resolved = this.resolveContributions(record)
    if (resolved) this.contributions.register(record.id, resolved)
  }

  private resolveContributions(record: AppPluginRecord): ResolvedPluginContributions | null {
    const loaded = record.manifest as PluginManifest | undefined
    if (!loaded) return null
    // Resolve contributions directly from the manifest's `contributes`
    // block — independent of the engines compatibility check, so an
    // incompatible plugin still shows what it WOULD contribute in the UI.
    return resolvePluginContributions(loaded.id, loaded.contributes ?? {}, this.isWindows)
  }

  // ── Public state machine ───────────────────────────────────────────

  list(): AppPluginClientInfo[] {
    if (this.disabled) return []
    return this.store.list().map((r) => this.toClientInfo(r))
  }

  get(id: string): AppPluginClientInfo | undefined {
    if (this.disabled) return undefined
    const r = this.store.get(id)
    return r ? this.toClientInfo(r) : undefined
  }

  /** Raw record (server-internal — used by the asset route to resolve the
   *  plugin's install dir). */
  getRecord(id: string): AppPluginRecord | undefined {
    if (this.disabled) return undefined
    return this.store.get(id)
  }

  async install(source: InstallSource): Promise<InstallResult> {
    this.guardEnabled()
    // Resolve the on-disk plugin dir + the source record (without addedAt;
    // addedAt is filled per-branch below). `local` realpath-resolves a path
    // the caller supplied; `marketplace` looks up the cloned marketplace +
    // resolves the plugin's subdir within it.
    const { dir, sourceBase } = await this.resolveInstallSource(source)
    const { manifest, hash, validation } = await loadManifest(dir, {
      hostVersion: this.hostVersion,
      hostNodeMajor: this.hostNodeMajor,
    })
    if (!validation.ok) {
      throw new HttpError(400, `manifest invalid: ${validation.errors.join('; ')}`)
    }
    const existing = this.store.get(manifest.id)
    if (existing && existing.installedVersion === manifest.version) {
      // Same-version reinstall (e.g. the dir was edited without a version
      // bump, or the user re-ran install). Refresh the manifest/path WITHOUT
      // resetting enabled state or granted permissions — falling through to
      // the fresh-install path would silently disable the plugin and wipe
      // consent decisions. Preserve the existing source's provenance/type.
      const refreshed = await this.revalidateRecord({
        ...existing,
        source: { ...existing.source, path: dir },
        manifest,
        manifestHash: hash,
      })
      this.store.upsert(refreshed)
      await this.store.flush()
      this.maybeRegisterContributions(refreshed)
      this.refreshSnapshot()
      this.broadcastChanged(refreshed)
      return { id: manifest.id, version: manifest.version, permissionRequired: false }
    }
    if (existing && existing.installedVersion !== manifest.version) {
      // Update path: diff permissions. Escalation → permission-required,
      // new version NOT enabled. Route through transition() so the state
      // machine (and B2's deactivate-before-permission-required) stays the
      // single authority on runtimeState. Preserve source provenance.
      const diff = diffPermissions(existing.grantedPermissions, validation.permissions)
      const base: AppPluginRecord = {
        ...existing,
        installedVersion: manifest.version,
        source: { ...sourceBase, addedAt: existing.source.addedAt },
        manifest,
        manifestHash: hash,
      }
      const record = diff.isEscalation
        ? this.transition(base, 'permission-required', 'new version requires additional permissions')
        : base
      this.store.upsert(record)
      await this.store.flush()
      this.maybeRegisterContributions(record)
      this.refreshSnapshot()
      this.broadcastChanged(record)
      return { id: manifest.id, version: manifest.version, permissionRequired: diff.isEscalation }
    }

    // Fresh install: consent is captured by the install call (the UI shows
    // the declared permissions before POSTing). grantedPermissions = declared.
    const now = Date.now()
    const record: AppPluginRecord = {
      id: manifest.id,
      installedVersion: manifest.version,
      enabled: false,
      source: { ...sourceBase, addedAt: now },
      manifestHash: hash,
      manifest,
      grantedPermissions: validation.permissions,
      runtimeState: 'disabled',
    }
    this.store.upsert(record)
    await this.store.flush()
    this.refreshSnapshot()
    this.broadcastChanged(record)
    log.info(`installed ${manifest.id}@${manifest.version} from ${dir}`)
    return { id: manifest.id, version: manifest.version, permissionRequired: false }
  }

  /** Resolve an InstallSource to the on-disk plugin dir + a source record
   *  (without `addedAt`, which the install branches fill). */
  private async resolveInstallSource(source: InstallSource): Promise<{ dir: string; sourceBase: PluginSourceBase }> {
    if (source.type === 'local') {
      const dir = await resolvePluginDir(source.path)
      return { dir, sourceBase: { type: 'local', path: dir } }
    }
    // marketplace
    if (!this.marketplaceStore) throw new HttpError(400, 'marketplace install is not available (no marketplace store)')
    const mp = this.marketplaceStore.get(source.marketplaceId)
    if (!mp) throw new HttpError(404, `marketplace not found: ${source.marketplaceId}`)
    const entry = mp.manifest.plugins.find((p) => p.name === source.pluginName)
    if (!entry) throw new HttpError(404, `plugin '${source.pluginName}' not found in marketplace '${source.marketplaceId}'`)
    const dir = await resolvePluginDir(pluginDirInClone(mp.cloneDir, entry.dir, mp.subdir))
    // Defense against symlink escape: the marketplace clone is untrusted
    // (arbitrary GitHub repo, and git commits symlinks), so a plugin subdir
    // could be a symlink pointing outside the clone. resolvePluginDir
    // realpaths the target but doesn't re-check containment — do it here so
    // the plugin's manifest/code can't be loaded from an unintended path.
    const cloneReal = await fs.realpath(mp.cloneDir).catch(() => mp.cloneDir)
    if (!isPathInside(dir, cloneReal, { isWindows: this.isWindows })) {
      throw new HttpError(400, `marketplace plugin '${source.pluginName}' dir escapes the clone`)
    }
    return {
      dir,
      sourceBase: { type: 'marketplace', marketplaceId: source.marketplaceId, pluginName: source.pluginName, path: dir },
    }
  }

  /** Re-validate a single plugin's manifest from disk + broadcast. Used by
   *  the marketplace refresh path (after a `gitPull` pulls new content into
   *  the clone, each installed plugin from that marketplace is re-validated
   *  so version/permission changes surface). */
  async revalidatePlugin(id: string): Promise<AppPluginClientInfo | undefined> {
    this.guardEnabled()
    const record = this.requireRecord(id)
    const r = await this.revalidateRecord(record)
    if (r !== record) {
      this.store.upsert(r)
      await this.store.flush()
      this.maybeRegisterContributions(r)
    }
    this.refreshSnapshot()
    this.broadcastChanged(r)
    return this.toClientInfo(r)
  }

  /** List records installed from a given marketplace (for refresh/remove). */
  recordsForMarketplace(marketplaceId: string): AppPluginRecord[] {
    return this.store.list().filter((r) => r.source.type === 'marketplace' && r.source.marketplaceId === marketplaceId)
  }

  async enable(id: string): Promise<void> {
    this.guardEnabled()
    const record = this.requireRecord(id)
    if (record.enabled) return
    // Re-validate before flipping on — the dir may have changed since install.
    const revalidated = await this.revalidateRecord(record)
    if (revalidated.runtimeState === 'incompatible' || revalidated.runtimeState === 'corrupted') {
      this.store.upsert(revalidated)
      await this.store.flush()
      this.refreshSnapshot()
      this.broadcastChanged(revalidated)
      throw new HttpError(409, `cannot enable: ${revalidated.runtimeState} (${revalidated.lastError})`)
    }
    if (revalidated.runtimeState === 'permission-required') {
      throw new HttpError(409, 'new version requires re-consent; grant permissions first')
    }
    const next = this.transition({ ...revalidated, enabled: true }, 'inactive', undefined)
    this.store.upsert(next)
    await this.store.flush()
    this.maybeRegisterContributions(next)
    this.refreshSnapshot()
    this.broadcastChanged(next)
    log.info(`enabled ${id}`)
    // onStartup plugins activate immediately on enable (no command needed) so
    // background watchers start without user interaction. Fire-and-forget:
    // activation is async and must not block the enable HTTP response; failures
    // are logged, and ensureActive's own teardown-race handling covers disable
    // landing while activation is in flight.
    const manifest = next.manifest as PluginManifest | undefined
    if (manifest?.activationEvents?.includes('onStartup')) {
      void this.pm.ensureActive(next).catch((err) =>
        log.warn(`[${id}] onStartup activation after enable failed: ${(err as Error).message}`),
      )
    }
  }

  async disable(id: string): Promise<void> {
    this.guardEnabled()
    const record = this.requireRecord(id)
    if (!record.enabled) return
    // Teardown: stop accepting new commands (the state flip does that),
    // cancel in-flight commands for this plugin, deactivate the subprocess
    // (5s) then kill. In-flight command results are discarded as
    // CommandError('disabled').
    this.cancelPluginCommands(id, 'disabled')
    await this.pm.deactivate(id, 'disable').catch((err) => log.warn(`[${id}] deactivate: ${(err as Error).message}`))
    const next = this.transition({ ...record, enabled: false }, 'disabled', undefined)
    this.store.upsert(next)
    await this.store.flush()
    this.contributions.unregister(id)
    this.bus.clearPluginEvents(id)
    this.refreshSnapshot()
    this.broadcastChanged(next)
    log.info(`disabled ${id}`)
  }

  async uninstall(id: string, opts: { deleteData?: boolean }): Promise<void> {
    this.guardEnabled()
    this.requireRecord(id)
    this.cancelPluginCommands(id, 'disabled')
    await this.pm.kill(id).catch((err) => log.warn(`[${id}] kill: ${(err as Error).message}`))
    this.contributions.unregister(id)
    this.bus.clearPluginEvents(id)
    this.store.remove(id)
    await this.store.flush()
    if (opts.deleteData) {
      await this.deletePluginData(id).catch((err) => log.warn(`failed to delete data for ${id}: ${(err as Error).message}`))
    }
    this.refreshSnapshot()
    // Emit a full snapshot (not a state-changed for the removed plugin) so
    // existing tabs evict the entry — a state-changed carrying a now-absent
    // plugin would leave a ghost (no `app-plugin-removed` frame in v1).
    this.bus.emitSnapshot()
    log.info(`uninstalled ${id}${opts.deleteData ? ' (data deleted)' : ''}`)
  }

  // ── Command execution (Stage B2) ───────────────────────────────────

  async executeCommand(req: { pluginId: string; commandId: string; context: PluginCommandContext }): Promise<PluginCommandResult> {
    this.guardEnabled()
    if (this.safeMode) throw new HttpError(503, 'app plugins are in safe mode (no subprocess activation)')
    const record = this.requireRecord(req.pluginId)
    if (!record.enabled) throw this.commandError('plugin-not-enabled', 'plugin is not enabled')
    if (record.runtimeState === 'quarantined') throw this.commandError('plugin-quarantined', 'plugin is quarantined after repeated crashes')
    if (record.runtimeState === 'permission-required') throw this.commandError('plugin-not-enabled', 'plugin requires re-consent')
    if (record.runtimeState === 'incompatible' || record.runtimeState === 'corrupted') {
      throw this.commandError('plugin-not-enabled', `plugin is ${record.runtimeState}`)
    }

    // invocationId is ALWAYS server-generated — a client-supplied id could
    // collide across tabs and orphan an in-flight command's controller.
    const invocationId = newInvocationId()
    const context = { ...req.context, invocationId } as PluginCommandContext
    const sessionId = 'sessionId' in context ? (context as { sessionId?: string }).sessionId : undefined

    const controller = new AbortController()
    const entry: { pluginId: string; sessionId?: string; controller: AbortController; proc?: { cancelCommand: (invocationId: string) => void }; cancelCode?: PluginCommandErrorCode } = {
      pluginId: req.pluginId,
      sessionId,
      controller,
    }
    this.inFlight.set(invocationId, entry)

    // If the session is cleared mid-flight, cancel the command (the SDK
    // truncated the transcript; a late Popover would anchor to a dead msg).
    let clearedSub: { iterable: AsyncIterable<unknown>; unsubscribe: () => void } | null = null
    if (sessionId) {
      clearedSub = this.sm.subscribeSessionCleared(sessionId)
      if (clearedSub) {
        void (async () => {
          for await (const _ev of clearedSub!.iterable) {
            void _ev
            this.cancelInvocation(invocationId, 'session-cleared')
            clearedSub?.unsubscribe()
            clearedSub = null
            return
          }
        })()
      }
    }

    try {
      const proc = await this.pm.ensureActive(record)
      entry.proc = proc
      // Wire the host-side abort to a best-effort cancel notification so the
      // child stops working (and stops spending ai.request quota) instead of
      // running to the 30s timeout.
      controller.signal.addEventListener('abort', () => proc.cancelCommand(invocationId), { once: true })
      const result = await proc.executeCommand(req.commandId, context, controller.signal)
      return result
    } catch (err) {
      // On any failure (timeout/crash/cancel) abort the controller so the
      // child receives a `cancel` notification — otherwise a timed-out
      // command keeps running and its late Host API side effects still land.
      controller.abort()
      throw this.mapCommandError(err, entry.cancelCode)
    } finally {
      this.inFlight.delete(invocationId)
      clearedSub?.unsubscribe()
    }
  }

  /** Abort an in-flight command and notify the child to stop. Used by
   *  session-cleared and disable/uninstall teardown. `code` is the typed
   *  error code the caller will see (vs the generic command-cancelled). */
  private cancelInvocation(invocationId: string, code: PluginCommandErrorCode): void {
    const entry = this.inFlight.get(invocationId)
    if (!entry) return
    entry.cancelCode = code
    entry.controller.abort()
    // The abort listener added in executeCommand forwards to proc.cancelCommand.
  }

  /** Cancel every in-flight command for a plugin (disable/uninstall). Scoped
   *  to the plugin being torn down — disabling plugin A must not cancel
   *  plugin B's running command. Records `code` so the caller sees a typed
   *  error instead of generic `command-cancelled`. */
  private cancelPluginCommands(pluginId: string, code: PluginCommandErrorCode): void {
    for (const [invocationId, entry] of this.inFlight) {
      if (entry.pluginId !== pluginId) continue
      entry.cancelCode = code
      entry.controller.abort()
      void invocationId
    }
  }

  /** Called by the process manager when a subprocess exits unexpectedly. */
  private handleCrash(pluginId: string, crashes: number): void {
    const record = this.store.get(pluginId)
    if (!record) return
    // A disabled plugin shouldn't have a subprocess; if a crash callback
    // arrives for one, leave it disabled rather than forcing it to crashed.
    if (record.runtimeState === 'disabled') return
    const to: PluginRuntimeState = crashes >= 3 ? 'quarantined' : 'crashed'
    const next = this.transition({ ...record }, to, crashes >= 3 ? `quarantined after ${crashes} crashes` : `subprocess exited (${crashes} crashes)`)
    this.store.upsert(next)
    void this.store.flush().catch((err) => log.warn(`handleCrash flush: ${(err as Error).message}`))
    this.refreshSnapshot()
    this.broadcastChanged(next)
  }

  private mapCommandError(err: unknown, overrideCode?: PluginCommandErrorCode): HttpError {
    const msg = err instanceof Error ? err.message : String(err)
    // A caller-supplied code (from cancelInvocation/cancelPluginCommands:
    // 'disabled' / 'session-cleared') wins over message-regex classification.
    let code: PluginCommandErrorCode = overrideCode ?? 'unknown'
    if (!overrideCode) {
      // Anchor to host-generated message prefixes so a benign error containing
      // "exited" (e.g. a plugin returning "user exited the flow") isn't
      // misclassified as a crash.
      if (/^rpc call .* timed out/.test(msg)) code = 'command-timeout'
      else if (/^rpc call .* cancelled/.test(msg)) code = 'command-cancelled'
      else if (/^plugin process exited/.test(msg) || /spawn|ENOENT/.test(msg)) code = 'plugin-crashed'
      else if (/^permission denied/.test(msg)) code = 'permission-denied'
    }
    return this.commandError(code, msg)
  }

  private commandError(code: PluginCommandErrorCode, message: string): HttpError {
    // 422 carries a typed PluginCommandError body (HttpError.body) the client
    // branches on by `code` — NOT a stringified JSON in `error`.
    return new HttpError(422, message, { error: { code, message } })
  }

  // ── Configuration (Stage B2) ───────────────────────────────────────

  private configStoreFor(id: string): ConfigurationStore {
    let s = this.configStores.get(id)
    if (!s) {
      s = new ConfigurationStore(id, resolvePath(this.stateDir, 'app-plugins', 'data', id))
      this.configStores.set(id, s)
    }
    return s
  }

  async getConfiguration(id: string): Promise<Record<string, unknown>> {
    this.guardEnabled()
    const record = this.requireRecord(id)
    const props = this.resolveContributions(record)?.configuration.properties ?? []
    return this.configStoreFor(id).get(props)
  }

  async putConfiguration(id: string, values: Record<string, unknown>): Promise<void> {
    this.guardEnabled()
    const record = this.requireRecord(id)
    const props = this.resolveContributions(record)?.configuration.properties ?? []
    const { errors, changed } = await this.configStoreFor(id).set(props, values)
    if (errors.length > 0) throw new HttpError(400, `invalid configuration: ${errors.join('; ')}`)
    // A no-op PUT (the incoming values leave the stored config identical) must
    // not tear down and respawn the subprocess — there is nothing new for it to
    // pick up. The stored config is the source of truth for the next activation,
    // so the running service already has these values.
    if (!changed) return
    // Apply the new config to a running service immediately: reload (deactivate
    // → fresh activate) so it sees the new values without a manual disable/
    // enable. v1 has no live config-changed RPC, so a restart is the simple
    // equivalent — `deactivate` accepts a `reload` reason. Only reload when the
    // subprocess is live. `waitForActive` covers a save landing while `enable()`
    // is still spawning (get() returns undefined mid-activation) so the new
    // value isn't silently dropped. The record is re-read AFTER the deactivate
    // and only re-activated if still enabled, so a concurrent disable that
    // lands in the gap can't be resurrected by our reload (the ensureActive
    // teardown-race check covers a disable landing during the re-spawn). Reload
    // failures are logged, never surfaced: the value is persisted and will be
    // picked up on the next enable/startup either way.
    const running = this.pm.get(id) ?? (await this.pm.waitForActive(id))
    if (running) {
      // Cancel in-flight commands with a typed code so a reload that tears the
      // subprocess down doesn't surface as a misleading `plugin-crashed`.
      this.cancelPluginCommands(id, 'command-cancelled')
      await this.pm.deactivate(id, 'reload')
      const live = this.store.get(id)
      if (live?.enabled) {
        try {
          await this.pm.ensureActive(live)
        } catch (err) {
          log.warn(`[${id}] reload after configuration change failed: ${(err as Error).message}`)
        }
      }
    }
  }

  getPermissions(id: string): { declared: AppPluginClientInfo['declaredPermissions']; granted: AppPluginClientInfo['grantedPermissions'] } {
    const record = this.requireRecord(id)
    return { declared: this.declaredPermissions(record), granted: record.grantedPermissions }
  }

  async setPermissions(id: string, granted: PermissionSpec[]): Promise<void> {
    this.guardEnabled()
    const record = this.requireRecord(id)
    // Re-normalise the incoming grant so a hand-crafted or stale payload
    // (unknown permissions, malformed hosts) is cleaned before it's stored —
    // the registry file is hand-editable, and consent should only ever
    // honour well-formed permissions the host recognises.
    const { permissions } = normalisePermissions(granted)
    // Only clear `permission-required` → `inactive` when the plugin is
    // actually enabled. A disabled/corrupted plugin keeps its runtime state;
    // flipping it to `inactive` while `enabled:false` would be inconsistent
    // (isEnabledState('inactive') is true). Permission grants still persist
    // for the next enable attempt.
    const next =
      record.enabled && record.runtimeState === 'permission-required'
        ? this.transition({ ...record, grantedPermissions: permissions }, 'inactive', undefined)
        : { ...record, grantedPermissions: permissions }
    this.store.upsert(next)
    await this.store.flush()
    this.maybeRegisterContributions(next)
    // Push the new grants to a live subprocess so Host API checks see them
    // immediately (no re-activate needed). Fire-and-forget — refreshGrants
    // awaits any in-flight activation, which we don't want to block setPermissions on.
    void this.pm.refreshGrants(id, permissions).catch(() => {})
    this.refreshSnapshot()
    this.broadcastChanged(next)
  }

  /** Mark host shutdown in progress so plugin child exits are classified as
   *  expected teardown, not crashes. MUST be called synchronously before ANY
   *  await of the shutdown signal handler — see
   *  PluginProcessManager.shuttingDown for the Windows-signal rationale. */
  prepareForShutdown(): void {
    this.pm.markShuttingDown()
  }

  async shutdown(): Promise<void> {
    // Tear down every subprocess (deactivate + kill), then flush + close
    // the event bus. Runs before sessionManager.shutdown() in cli.ts.
    try {
      await this.pm.shutdown()
    } catch (err) {
      log.warn(`subprocess shutdown error: ${(err as Error).message}`)
    }
    try {
      await this.store.flush()
    } catch (err) {
      log.warn(`shutdown flush failed: ${(err as Error).message}`)
    }
    this.bus.closeAll()
  }

  // ── Broadcaster (consumed by ws.ts) ────────────────────────────────

  subscribeAppPlugins() {
    return this.bus.subscribeAppPlugins()
  }

  // ── Internals ──────────────────────────────────────────────────────

  private guardEnabled(): void {
    if (this.disabled) throw new HttpError(503, 'app plugins are disabled (--disable-app-plugins)')
  }

  private requireRecord(id: string): AppPluginRecord {
    const r = this.store.get(id)
    if (!r) throw new HttpError(404, `app plugin not found: ${id}`)
    return r
  }

  /** Validate + apply a state transition. Throws on illegal transitions
   *  (a programming error — the state machine should make them impossible). */
  private transition(record: AppPluginRecord, to: PluginRuntimeState, lastError?: string): AppPluginRecord {
    if (!canTransition(record.runtimeState, to)) {
      // Don't crash the server over a stale persisted state; log and force.
      log.warn(`illegal transition ${record.runtimeState}→${to} for ${record.id}; forcing`)
    }
    return { ...record, runtimeState: to, lastError }
  }

  private declaredPermissions(record: AppPluginRecord): AppPluginClientInfo['declaredPermissions'] {
    const m = record.manifest as PluginManifest | undefined
    if (!m) return []
    // Re-normalise from the manifest so `declared` reflects the current
    // manifest, not a stale snapshot.
    return normaliseFromManifest(m)
  }

  private toClientInfo(record: AppPluginRecord): AppPluginClientInfo {
    const m = record.manifest as PluginManifest | undefined
    const declared = m ? normaliseFromManifest(m) : []
    const diff = diffPermissions(record.grantedPermissions, declared)
    const compatible = record.runtimeState !== 'incompatible' && record.runtimeState !== 'corrupted'
    // Resolve contributions from the manifest directly — the registry only
    // holds ENABLED plugins, but the client info must show contributions for
    // disabled/incompatible plugins too (so the UI can preview what enabling
    // would add).
    const resolved = this.resolveContributions(record) ?? emptyContributions()
    return {
      id: record.id,
      name: m?.name ?? record.id,
      description: m?.description,
      version: record.installedVersion,
      publisher: m?.publisher,
      license: m?.license,
      enabled: record.enabled,
      runtimeState: record.runtimeState,
      lastError: record.lastError,
      declaredPermissions: declared,
      grantedPermissions: record.grantedPermissions,
      permissionRequired: diff.isEscalation || record.runtimeState === 'permission-required',
      compatible,
      secretsBackend: 'none', // B2: 'plaintext' | 'keychain'
      contributions: resolved,
    }
  }

  private refreshSnapshot(): void {
    this.bus.setSnapshot(this.list())
  }

  private broadcastChanged(record: AppPluginRecord): void {
    this.bus.emitStateChanged(this.toClientInfo(record))
  }

  private async deletePluginData(id: string): Promise<void> {
    const dataDir = resolvePath(this.stateDir, 'app-plugins', 'data', id)
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

// ── Module-level helpers (kept out of the class to avoid import cycles) ──

import { resolvePluginContributions } from '../../shared/app-plugins/manifest-validator.js'

function normaliseFromManifest(m: PluginManifest): AppPluginClientInfo['declaredPermissions'] {
  return normalisePermissions(m.permissions).permissions
}

function emptyContributions(): ResolvedPluginContributions {
  return { commands: [], contextMenus: [], actions: [], configuration: { properties: [] }, statusIndicators: [], widgets: [], diagnostics: [] }
}
