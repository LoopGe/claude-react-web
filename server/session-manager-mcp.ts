// MCP server management for live sessions — dynamic add/remove, first-party
// (in-process) server injection, and the merge-with-global-config helpers
// used by the create/resume/fork/clear spawn paths.
//
// Extracted from session-manager.ts for modularity. Mirrors the
// PermissionBroker/ElicitationBroker/DialogBroker pattern: SessionManager
// constructs one SessionMcpManager, injecting the handful of its own methods
// this module needs (session lookup, handle-method wrapping, persistence,
// broadcast), and keeps thin proxy methods on its own public API so routes
// and other callers see no change.
//
// SessionMcpManager owns:
//   - Dynamic MCP server add/remove on a live session (setMcpServers)
//   - Per-server reconnect / toggle / permission-mode override passthrough
//   - First-party (in-process) server injection + effective-enabled resolution
//   - toolServerStatus (per-session first-party server status projection)
//   - mergeMcpServers / mergeMcpServersAsync (global + session config merge)
//
// SessionManager retains:
//   - injectAll's call site inside spawn() (still calls into this module)
//   - Persisting mcpServerNames as part of the Session/SessionMeta shape

import type { FirstPartyToolDef } from '../shared/first-party.js'
import { APP_TOOLS_SERVER_NAME } from './sdk-tools/app-tools.js'
import { firstPartyRegistry } from './sdk-tools/registry.js'
import { config as defaultConfig } from './config.js'
import type { McpConfigStore } from './mcp-config.js'
import type { GlobalSessionEvent, Session, SessionInfo } from './session-types.js'
import type { ProviderCapabilities, ProviderSessionHandle } from './providers/types.js'
import { createLogger } from './log.js'

const log = createLogger('mcp-manager')

/** Callbacks the MCP manager needs from its owner (SessionManager). Kept
 *  minimal and generic (no SessionManager import) so this module stays
 *  independently testable, same convention as HealthMonitorDeps. */
export interface McpManagerDeps {
  /** Resolve a session by id, requiring it to be alive (running Query). */
  requireLive(id: string): Session
  /** Resolve a session by id without any liveness requirement. */
  require(id: string): Session
  /** Bind + capability-gate + error-wrap a provider handle method. */
  requireHandleMethod<T extends (...args: never[]) => unknown>(
    s: Session,
    method: keyof ProviderSessionHandle,
    action: string,
    capability?: keyof ProviderCapabilities,
  ): T
  /** Persist session metadata without a global broadcast. */
  writeStore(s: Session): void
  /** Broadcast a global session event (used after a live MCP mutation so
   *  the sidebar's "available tools" projection stays in sync). */
  broadcastGlobal(ev: GlobalSessionEvent): void
  /** Project a live session into its public SessionInfo shape. */
  info(s: Session): SessionInfo
  /** Persist + broadcast (used by setFirstPartyTool's dormant-session path). */
  persist(s: Session): void
  /** Global MCP config store (undefined when no persistence configured). */
  mcpStore?: McpConfigStore
  /** Time an SDK control round-trip, logging slow (>=1s) calls and
   *  wrapping a plain failure into a semantic 502. Same wrapper
   *  SessionManager uses for every other SDK control call. */
  timeSdkControl<T>(id: string, label: string, fn: () => Promise<T>): Promise<T>
}

export class SessionMcpManager {
  constructor(private deps: McpManagerDeps) {}

  async mcpServerStatus(id: string) {
    const s = this.deps.requireLive(id)
    const fn = this.deps.requireHandleMethod<() => Promise<unknown>>(
      s,
      'mcpServerStatus',
      'MCP status',
      'supportsMcp',
    )
    return this.deps.timeSdkControl(id, 'mcpServerStatus', fn)
  }

  async reconnectMcpServer(id: string, serverName: string): Promise<void> {
    const s = this.deps.requireLive(id)
    await this.deps.requireHandleMethod<(name: string) => Promise<void>>(
      s,
      'reconnectMcpServer',
      'MCP reconnect',
      'supportsMcp',
    )(serverName)
  }

  async toggleMcpServer(id: string, serverName: string, enabled: boolean): Promise<void> {
    const s = this.deps.requireLive(id)
    await this.deps.requireHandleMethod<(name: string, enabled: boolean) => Promise<void>>(
      s,
      'toggleMcpServer',
      'MCP toggle',
      'supportsMcp',
    )(serverName, enabled)
  }

  /** Add/remove MCP servers on a live session via the SDK's setMcpServers API. */
  async setMcpServers(id: string, servers: Record<string, unknown>) {
    const s = this.deps.requireLive(id)
    // Inject first-party servers so a live setMcpServers (replace semantics)
    // doesn't drop what spawn installed — same single code path as the spawn
    // injection, so on/off is consistent between spawn and live.
    const injected = this.injectAll(servers, s)
    const result = await this.deps.requireHandleMethod<(servers: Record<string, unknown>) => Promise<unknown>>(
      s,
      'setMcpServers',
      'dynamic MCP servers',
      'supportsMcp',
    )(injected ?? servers)

    // Update the tracked MCP server names + the runtime dynamic map so the
    // client's "available" computation stays in sync and an immediate
    // first-party toggle can re-run injection. Both keep the user-configured
    // set (pre-injection) — first-party servers are surfaced separately.
    s.mcpServerNames = Object.keys(servers)
    s.dynamicMcpServers = servers
    this.deps.writeStore(s)
    this.deps.broadcastGlobal({ kind: 'update', session: this.deps.info(s) })

    return result
  }

  /** Pin (or clear, mode:null) a per-MCP-server permission-mode override on a
   *  live session (SDK Query.setMcpPermissionModeOverride — tighten-only:
   *  'default' | 'auto' | null). Resolves `{ warning? }`; the warning is
   *  informational (server-name typo detection) and is forwarded to the client.
   *  NOTE: the override is per-process and the SDK does not report the pinned
   *  value back, so it is NOT persisted — a resume/reconnect starts clean. */
  async setMcpPermissionModeOverride(
    id: string,
    serverName: string,
    mode: 'default' | 'auto' | null,
  ): Promise<{ warning?: string }> {
    const s = this.deps.requireLive(id)
    return this.deps.requireHandleMethod<(n: string, m: 'default' | 'auto' | null) => Promise<{ warning?: string }>>(
      s,
      'setMcpPermissionModeOverride',
      'MCP permission mode',
      'supportsMcp',
    )(serverName, mode)
  }

  /** Effective first-party server enabled state: per-session override (null =
   *  inherit), legacy session `appToolsGit`, global structured config, legacy
   *  global `appToolsGit`, then the server's own default. */
  firstPartyEnabled(s: Session, name: string): boolean {
    const so = s.firstPartyTools?.[name]
    if (so !== undefined && so !== null) return so
    if (name === APP_TOOLS_SERVER_NAME && s.appToolsGit !== undefined) return s.appToolsGit
    const go = defaultConfig.firstPartyTools?.[name]?.enabled
    if (go !== undefined) return go
    if (name === APP_TOOLS_SERVER_NAME && defaultConfig.appToolsGit !== undefined) return defaultConfig.appToolsGit
    return firstPartyRegistry.get(name)?.defaultEnabled ?? false
  }

  /** Append the enabled first-party in-process MCP servers to an mcpServers
   *  map (per-session cwd-bound). Returns the input unchanged when nothing is
   *  injected; first-party servers override same-named user servers. Per-server
   *  build failures are recorded on the session for toolServerStatus. Called
   *  both from setMcpServers above and from SessionManager.spawn(). */
  injectAll(
    servers: Record<string, unknown> | undefined,
    s: Session,
  ): Record<string, unknown> | undefined {
    const injected = firstPartyRegistry.injectAll(
      s.cwd ?? null,
      (name) => this.firstPartyEnabled(s, name),
      (name, message) => {
        s.firstPartyErrors = { ...(s.firstPartyErrors ?? {}), [name]: message }
        log.error(`[session ${s.id}] first-party server ${name} build failed: ${message}`)
      },
    )
    if (!injected) return servers
    return { ...(servers ?? {}), ...injected }
  }

  /** Status of each registered first-party server for a session (independent
   *  of the SDK's mcpServerStatus, which is unreliable for in-process
   *  servers). `injected` = would be injected under the current effective
   *  state; `error` = last build/registration failure. Each entry also
   *  embeds the server's static tool definitions (the registry's listToolDefs
   *  output for that server) so one fetch paints status AND the tool list. */
  toolServerStatus(id: string): Array<{ name: string; description: string; enabled: boolean; injected: boolean; requiresCwd: boolean; hasCwd: boolean; tools: FirstPartyToolDef[]; error?: string }> {
    const s = this.deps.require(id)
    const toolDefs = new Map(firstPartyRegistry.listToolDefs().map((info) => [info.name, info]))
    const out: Array<{ name: string; description: string; enabled: boolean; injected: boolean; requiresCwd: boolean; hasCwd: boolean; tools: FirstPartyToolDef[]; error?: string }> = []
    for (const server of firstPartyRegistry.list()) {
      const enabled = this.firstPartyEnabled(s, server.name)
      const hasCwd = !!s.cwd
      const injected = enabled && (!server.requiresCwd || hasCwd)
      out.push({
        name: server.name,
        description: server.description,
        enabled,
        injected,
        requiresCwd: server.requiresCwd,
        hasCwd,
        tools: toolDefs.get(server.name)?.tools ?? [],
        error: s.firstPartyErrors?.[server.name],
      })
    }
    return out
  }

  /** Set a per-session first-party tool server override. `enabled: null`
   *  clears the override so the session re-inherits the global default.
   *  IMMEDIATE on live sessions: after persisting the override, re-runs the
   *  injection path (setMcpServers with the stored user map) so the SDK picks
   *  up the change now, not at the next spawn. If the re-injection's SDK call
   *  fails, the override is reverted and the error rethrown (never leave the
   *  UI showing a state the session isn't actually in). Dormant sessions just
   *  persist the override — it applies at the next spawn. */
  async setFirstPartyTool(id: string, name: string, enabled: boolean | null): Promise<SessionInfo> {
    const s = this.deps.require(id)
    const prev = s.firstPartyTools?.[name] ?? null
    const next: Record<string, boolean | null> = { ...(s.firstPartyTools ?? {}) }
    if (enabled === null) delete next[name]
    else next[name] = enabled
    s.firstPartyTools = Object.keys(next).length > 0 ? next : undefined
    // Keep the legacy appToolsGit surface coherent for the apptools entry.
    if (name === APP_TOOLS_SERVER_NAME) s.appToolsGit = enabled ?? undefined
    s.lastActivityAt = Date.now()

    if (s.running) {
      try {
        await this.setMcpServers(id, s.dynamicMcpServers ?? {})
      } catch (err) {
        // Revert the override so UI (server-backed session info) and reality
        // stay consistent.
        const revert: Record<string, boolean | null> = { ...(s.firstPartyTools ?? {}) }
        if (prev === null) delete revert[name]
        else revert[name] = prev
        s.firstPartyTools = Object.keys(revert).length > 0 ? revert : undefined
        if (name === APP_TOOLS_SERVER_NAME) s.appToolsGit = prev ?? undefined
        throw err
      }
    } else {
      this.deps.persist(s)
    }
    return this.deps.info(s)
  }

  /** Merge global MCP configs with session-specific overrides.
   *  enabledGlobal: names of global servers the user selected.
   *  sessionMcp: session-specific overrides (win on name collision).
   *  Returns undefined if the merged result is empty. */
  mergeMcpServers(
    enabledGlobal?: string[],
    sessionMcp?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const global = this.deps.mcpStore?.toSdkConfig() ?? {}
    const result: Record<string, unknown> = {}

    // Add explicitly-requested global servers. The parameter is typed
    // `string[]` and the HTTP routes validate it via `validateStringArray`
    // before calling, so no runtime Array.isArray / typeof guard is needed
    // here — the type system is the single boundary.
    //
    // An explicit request overrides the global `enabled` flag: a globally
    // disabled server is "off by default" (not pre-checked in the new-session
    // dialog) but the user can still opt into it per session by checking its
    // box. `toSdkConfig` skips disabled servers, so for names not present
    // there we fall back to `getSdkServerConfig`, which ignores `enabled`.
    // Unknown names resolve to nothing and are silently dropped.
    if (enabledGlobal) {
      for (const name of enabledGlobal) {
        const cfg = global[name] ?? this.deps.mcpStore?.getSdkServerConfig(name)
        if (cfg) result[name] = cfg
      }
    }

    // Session overrides replace or add
    if (sessionMcp) {
      Object.assign(result, sessionMcp)
    }

    return Object.keys(result).length > 0 ? result : undefined
  }

  /** Async merge path for HTTP routes: refresh remote OAuth tokens first. */
  async mergeMcpServersAsync(
    enabledGlobal?: string[],
    sessionMcp?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    if (this.deps.mcpStore && enabledGlobal) {
      await this.deps.mcpStore.refreshOAuthTokens(enabledGlobal)
    }
    return this.mergeMcpServers(enabledGlobal, sessionMcp)
  }
}
