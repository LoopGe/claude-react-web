// Host API factory — wires every JSON-RPC host method (plugin → host) to its
// adapter on a freshly-spawned RpcPeer. Each handler enforces permission +
// minimal param shape before delegating. The peer calls these on inbound
// requests; results flow back to the plugin as JSON-RPC responses.
//
// `cwd` for git/workspace ops is resolved from the session the plugin names
// (the plugin passes `sessionId`; we look up the session's cwd). A plugin
// can only touch the cwd of a session it has a sessionId for — it can't
// enumerate sessions.

import { createLogger } from '../../log.js'
import { RpcPeer, RpcError } from '../rpc-peer.js'
import { RPC_CODES } from '../../../shared/app-plugins/rpc-protocol.js'
import { PermissionChecker, PermissionDeniedError } from '../permission-manager.js'
import { StorageService } from '../storage-service.js'
import { SecretsService } from '../secrets-service.js'
import { ConfigurationStore } from '../configuration-store.js'
import { NetworkBroker } from './network-broker.js'
import { AiBroker } from './ai-broker.js'
import { SessionAdapter } from './session-adapter.js'
import { GitAdapter } from './git-adapter.js'
import { WorkspaceAdapter } from './workspace-adapter.js'
import type { NormalisedPermission } from '../../../shared/app-plugins/permissions.js'
import type { PluginConfigurationProperty } from '../../../shared/app-plugins/contributions.js'
import type { SessionManager } from '../../session-manager.js'

const log = createLogger('app-plugins:host')

export interface HostContext {
  pluginId: string
  dataDir: string
  stateDir: string
  grants: NormalisedPermission[]
  sm: SessionManager
  /** Rate-limited sink (per-plugin, enforced by the process manager) for
   *  plugin-originated log lines. The `log` Host API method routes through
   *  this so it shares the same 1000/min cap as captured stderr. */
  onStructuredLog?: (line: string) => void
  /** Declared `contributes.configuration.properties` for this plugin. Needed
   *  by `config.get` to apply defaults on read. Threaded from the manifest so
   *  the handler works without the plugin having to re-declare them. */
  configurationProps?: PluginConfigurationProperty[]
}

/** Build the host-side services + register handlers on `peer`. Returns the
 *  services the plugin-process needs (storage/secrets/config for activate
 *  params + shutdown). */
export function registerHostApi(peer: RpcPeer, ctx: HostContext): {
  storage: StorageService
  secrets: SecretsService
  config: ConfigurationStore
  checker: PermissionChecker
} {
  const checker = new PermissionChecker(ctx.pluginId, ctx.grants)
  const storage = new StorageService(ctx.pluginId, ctx.dataDir)
  const secrets = new SecretsService(ctx.pluginId, ctx.stateDir)
  const config = new ConfigurationStore(ctx.pluginId, ctx.dataDir)
  const network = new NetworkBroker(checker)
  const ai = new AiBroker(checker)
  const sessions = new SessionAdapter(ctx.sm, checker)
  const git = new GitAdapter(checker)
  const workspace = new WorkspaceAdapter(checker)
  const pluginLog = createLogger(`plugin:${ctx.pluginId}`)

  const cwdOf = (sessionId?: string): string => {
    if (!sessionId) throw new Error('sessionId is required')
    const s = (ctx.sm as unknown as { get(id: string): { cwd?: string } | undefined }).get(sessionId)
    if (!s || !s.cwd) throw new Error(`session not found or has no cwd: ${sessionId}`)
    return s.cwd
  }

  peer.registerHandler('storage.get', async (p) => {
    const { scope, key } = requireParams(p, ['scope', 'key']) as { scope: 'global' | 'workspace' | 'cache'; key: string }
    checker.assert('storage')
    return storage.get(scope, key)
  })
  peer.registerHandler('storage.set', async (p) => {
    const { scope, key, value } = requireParams(p, ['scope', 'key']) as { scope: 'global' | 'workspace' | 'cache'; key: string; value: unknown }
    checker.assert('storage')
    return storage.set(scope, key, value)
  })
  peer.registerHandler('storage.delete', async (p) => {
    const { scope, key } = requireParams(p, ['scope', 'key']) as { scope: 'global' | 'workspace' | 'cache'; key: string }
    checker.assert('storage')
    return storage.delete(scope, key)
  })
  peer.registerHandler('network.fetch', async (p) => {
    const params = requireParams(p, ['url']) as { url: string; method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; maxBytes?: number; timeoutMs?: number }
    return network.fetch(params)
  })
  peer.registerHandler('ai.request', async (p) => {
    const params = requireParams(p, ['purpose', 'messages']) as { purpose: string; system?: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>; model?: string; maxTokens?: number }
    return ai.request(params)
  })
  peer.registerHandler('sessions.read', async (p) => {
    const { sessionId } = requireParams(p, ['sessionId']) as { sessionId: string }
    return sessions.read(sessionId)
  })
  peer.registerHandler('sessions.send', async (p) => {
    const { sessionId, text } = requireParams(p, ['sessionId', 'text']) as { sessionId: string; text: string }
    return sessions.send(sessionId, text)
  })
  peer.registerHandler('sessions.interrupt', async (p) => {
    const { sessionId } = requireParams(p, ['sessionId']) as { sessionId: string }
    return sessions.interrupt(sessionId)
  })
  peer.registerHandler('sessions.list', async () => {
    return sessions.list()
  })
  peer.registerHandler('sessions.contextUsage', async (p) => {
    const { sessionId } = requireParams(p, ['sessionId']) as { sessionId: string }
    return sessions.contextUsage(sessionId)
  })
  peer.registerHandler('sessions.compact', async (p) => {
    const { sessionId } = requireParams(p, ['sessionId']) as { sessionId: string }
    return sessions.compact(sessionId)
  })
  peer.registerHandler('config.get', async () => {
    // No permission check: a plugin reads only its OWN declared config.
    // Defaults are applied against the manifest properties so a config that
    // was never written resolves to the declared defaults.
    return config.get(ctx.configurationProps ?? [])
  })
  peer.registerHandler('git.read', async (p) => {
    const params = requireParams(p, ['sessionId', 'op']) as { sessionId: string; op: 'status' | 'diff' | 'log'; path?: string; limit?: number }
    return git.read(params.op, cwdOf(params.sessionId), { path: params.path, limit: params.limit })
  })
  peer.registerHandler('workspace.read', async (p) => {
    const { sessionId, path } = requireParams(p, ['sessionId', 'path']) as { sessionId: string; path: string }
    return workspace.read(cwdOf(sessionId), path)
  })
  peer.registerHandler('workspace.write', async (p) => {
    const { sessionId, path, content } = requireParams(p, ['sessionId', 'path', 'content']) as { sessionId: string; path: string; content: string }
    return workspace.write(cwdOf(sessionId), path, content)
  })
  peer.registerHandler('secrets.read', async (p) => {
    const { key } = requireParams(p, ['key']) as { key: string }
    checker.assert('secrets.read')
    return secrets.get(key)
  })
  peer.registerHandler('secrets.write', async (p) => {
    const { key, value } = requireParams(p, ['key', 'value']) as { key: string; value: string }
    checker.assert('secrets.write')
    return secrets.set(key, value)
  })
  peer.registerHandler('ui.clipboard', async () => {
    throw new Error('ui.clipboard is not supported in v1 (requires an iframe view)')
  })
  peer.registerHandler('ui.openExternal', async (p) => {
    checker.assert('ui.openExternal')
    const { url } = requireParams(p, ['url']) as { url: string }
    // Validate the scheme even though the actual shell-open is deferred —
    // defense in depth so a future wiring of shell.openExternal(url) can't
    // open file:// / javascript: / UNC paths from a plugin.
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('ui.openExternal requires a valid URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('ui.openExternal only allows http(s) URLs')
    }
    log.info(`[${ctx.pluginId}] openExternal requested: ${url}`)
    return { ok: true }
  })
  peer.registerHandler('log', async (p) => {
    const { level, message } = requireParams(p, ['level', 'message']) as { level: 'error' | 'warn' | 'info' | 'debug' | 'trace'; message: string }
    // Route through the rate-limited sink so the `log` RPC method can't
    // bypass the per-plugin 1000/min cap that stderr is subject to.
    if (ctx.onStructuredLog) {
      ctx.onStructuredLog(`[${level}] ${message}`)
    } else {
      pluginLog[level]?.(message)
    }
    return null
  })

  return { storage, secrets, config, checker }
}

/** Validate `p` is a params object and that every `required` field is present
 *  (non-null). Throws a typed INVALID_PARAMS error otherwise. This is the
 *  "minimal param shape" check the module header promises — without it a
 *  plugin sending `{}` yields `undefined` for every field and writes
 *  `undefined`-keyed storage / sends to undefined sessions. (The plugin is
 *  trusted, but a malformed call should fail loudly, not silently corrupt.) */
function requireParams(p: unknown, required: string[] = []): Record<string, unknown> {
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    throw new RpcError(RPC_CODES.INVALID_PARAMS, 'expected params object')
  }
  const obj = p as Record<string, unknown>
  for (const f of required) {
    if (obj[f] === undefined || obj[f] === null) {
      throw new RpcError(RPC_CODES.INVALID_PARAMS, `missing param: ${f}`)
    }
  }
  return obj
}

/** Re-export so callers can catch permission denials uniformly. */
export { PermissionDeniedError }
