// Single plugin subprocess lifecycle.
//
// Wraps an RpcPeer (transport) + the host API (capability surface) with the
// activate / executeCommand / deactivate lifecycle and crash tracking. One
// instance per activated plugin; owned by PluginProcessManager.
//
// The subprocess is `node <entry>` with a cleaned env (authToken/accessToken/
// baseUrl/ANTHROPIC_* stripped) and the plugin's data dir as cwd. stdout is
// JSON-RPC; stderr is captured line-by-line and rate-limited by the manager.

import { resolve as resolvePath } from 'node:path'
import { createLogger } from '../log.js'
import { RpcPeer, RpcError, newInvocationId } from './rpc-peer.js'
import { registerHostApi } from './host/host-api.js'
import { resolvePluginContributions } from '../../shared/app-plugins/manifest-validator.js'
import type { PluginConfigurationProperty } from '../../shared/app-plugins/contributions.js'
import type { AppPluginRecord, PluginRuntimeState } from '../../shared/app-plugins/runtime-state.js'
import type { PluginManifest } from '../../shared/app-plugins/manifest.js'
import type { PluginCommandContext } from '../../shared/app-plugins/command-context.js'
import type { PluginCommandResult } from '../../shared/app-plugins/command-result.js'
import { parseStatGridPayload, type StatGridPayload } from '../../shared/app-plugins/widget.js'
import type { SessionManager } from '../session-manager.js'

const log = createLogger('app-plugins:proc')

const ACTIVATE_TIMEOUT_MS = 10_000
const COMMAND_TIMEOUT_MS = 30_000
const DEACTIVATE_TIMEOUT_MS = 5_000

const EVENT_RATE_PER_MIN = 300

/** Validate the `app.event` notification params → the parsed payload, or null. */
export function parseAppEventNotification(params: unknown): { widgetId: string; payload: StatGridPayload } | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null
  const widgetId = (params as { widgetId?: unknown }).widgetId
  if (typeof widgetId !== 'string' || widgetId.length === 0) return null
  const payload = parseStatGridPayload((params as { payload?: unknown }).payload)
  if (!payload) return null
  return { widgetId, payload }
}

/** Sliding-window rate budget (mirrors the log rate-limiter). */
export class SlidingWindowRate {
  private stamps: number[] = []
  constructor(private readonly max: number, private readonly windowMs: number) {}
  allow(): boolean {
    const now = Date.now()
    this.stamps = this.stamps.filter((t) => now - t < this.windowMs)
    if (this.stamps.length >= this.max) return false
    this.stamps.push(now)
    return true
  }
}

export interface PluginProcessOptions {
  record: AppPluginRecord
  dataDir: string
  stateDir: string
  sm: SessionManager
  isWindows: boolean
  /** Pushed when the child exits unexpectedly (manager records crash). */
  onUnexpectedExit: (code: number | null, signal: NodeJS.Signals | null) => void
  /** Captured stderr line (manager rate-limits + stores as a log). */
  onLog: (line: string) => void
  onEvent?: (pluginId: string, widgetId: string, payload: StatGridPayload) => void
}

export class PluginProcess {
  readonly pluginId: string
  private peer: RpcPeer
  private host: ReturnType<typeof registerHostApi>
  private closed = false
  /** Declared configuration properties (manifest `contributes.configuration`),
   *  resolved once at construction so `config.get` can apply defaults. */
  private readonly configurationProps: PluginConfigurationProperty[]
  private readonly eventRate = new SlidingWindowRate(EVENT_RATE_PER_MIN, 60_000)

  constructor(private readonly opts: PluginProcessOptions) {
    this.pluginId = opts.record.id
    const manifest = opts.record.manifest as PluginManifest
    const servicePath = resolvePath(opts.record.source.path, manifest.runtime.service)
    const env = cleanEnv()
    this.configurationProps =
      resolvePluginContributions(manifest.id, manifest.contributes ?? {}).configuration.properties

    this.peer = new RpcPeer({
      command: process.execPath,
      args: [servicePath],
      cwd: opts.dataDir,
      env,
      onLog: opts.onLog,
      onExit: (code, signal) => {
        if (this.closed) return // expected (deactivate/close)
        opts.onUnexpectedExit(code, signal)
      },
    })
    this.host = registerHostApi(this.peer, {
      pluginId: opts.record.id,
      dataDir: opts.dataDir,
      stateDir: opts.stateDir,
      grants: opts.record.grantedPermissions,
      sm: opts.sm,
      onStructuredLog: (line) => opts.onLog(line),
      configurationProps: this.configurationProps,
    })
    this.peer.registerHandler('app.event', async (params) => {
      const parsed = parseAppEventNotification(params)
      if (!parsed) {
        log.warn(`[${this.pluginId}] dropped invalid app.event`)
        return
      }
      if (!this.eventRate.allow()) {
        log.warn(`[${this.pluginId}] app.event rate limited`)
        return
      }
      this.opts.onEvent?.(this.pluginId, parsed.widgetId, parsed.payload)
    })
    this.peer.start()
  }

  /** Update grants without re-spawning (called when the user adjusts
   *  permissions while the plugin is active). */
  refreshGrants(grants: AppPluginRecord['grantedPermissions']): void {
    this.host.checker.setGrants(grants)
  }

  async activate(): Promise<void> {
    const configuration = await this.host.config.get(this.configurationProps)
    const result = (await this.peer.call(
      'activate',
      {
        pluginId: this.pluginId,
        version: this.opts.record.installedVersion,
        dataDir: this.opts.dataDir,
        permissions: this.opts.record.grantedPermissions.map((g) => g.permission),
        configuration,
      },
      { timeoutMs: ACTIVATE_TIMEOUT_MS },
    )) as { ok: true } | { ok: false; error: string }
    if (!result.ok) throw new Error(`activate failed: ${result.error}`)
  }

  async executeCommand(commandId: string, context: PluginCommandContext, signal?: AbortSignal): Promise<PluginCommandResult> {
    const invocationId = (context as { invocationId?: string }).invocationId ?? newInvocationId()
    const result = (await this.peer.call(
      'executeCommand',
      { invocationId, commandId, context },
      { timeoutMs: COMMAND_TIMEOUT_MS, signal },
    )) as PluginCommandResult
    return result
  }

  async deactivate(reason: 'disable' | 'uninstall' | 'shutdown' | 'reload'): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await this.peer.call('deactivate', { reason }, { timeoutMs: DEACTIVATE_TIMEOUT_MS })
    } catch (err) {
      // Deactivate timeout/error is non-fatal — we kill anyway. At host
      // shutdown an already-dead child (the console signal killed it before
      // deactivate ran — see PluginProcessManager.shuttingDown) is expected
      // and quiet; a still-alive child that failed to answer (wedged or
      // throwing handler) is the one diagnostic naming a slow-shutdown
      // culprit, so it logs even at shutdown.
      if (reason !== 'shutdown' || !this.peer.childExited) {
        log.warn(`[${this.pluginId}] deactivate did not complete cleanly: ${(err as Error).message}`)
      }
    }
    this.host.subscriptions.dropPeer(this.peer)
    await this.peer.close()
  }

  /** Hard kill without deactivate (quarantine / shutdown fallback). */
  async kill(): Promise<void> {
    this.closed = true
    this.host.subscriptions.dropPeer(this.peer)
    await this.peer.close()
  }

  /** Notify the child a command was cancelled (best-effort). */
  cancelCommand(invocationId: string): void {
    this.peer.cancel(invocationId)
  }
}

/** Build a minimal env for the subprocess, stripping every credential the
 *  host holds. The plugin gets PATH + HOME + locale + temp so its own
 *  subprocesses work, but NEVER the Anthropic token or web-access token. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const allow = new Set(['PATH', 'Path', 'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'OS', 'SHELL', 'ComSpec', 'SystemRoot', 'APPDATA'])
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (allow.has(k)) env[k] = v
  }
  // Defensive: strip anything that looks credentialish even if it slipped
  // past the allowlist (it can't, but defense in depth).
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC|CLAUDE|CRW|AUTH|TOKEN|BASE_URL)/i.test(key)) delete env[key]
  }
  return env
}

export { RpcError }
export type { PluginRuntimeState }
