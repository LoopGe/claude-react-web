// The typed Host API object passed to executeCommand.
//
// Each method is a thin wrapper around `callHost(method, params)` — the
// JSON-RPC call into the host. The host enforces permissions + schema per
// call; the SDK just provides a typed, ergonomic surface.

import type {
  AiRequestOptions, AiRequestResult, GitReadOptions, Host, NetworkFetchOptions,
  NetworkFetchResult, SessionMetadata, StorageScope,
} from './types.js'

export type CallHost = (method: string, params?: unknown) => Promise<unknown>

export function createHost(callHost: CallHost): Host {
  return {
    storage: {
      get: (scope: StorageScope, key: string) =>
        callHost('storage.get', { scope, key }) as Promise<{ value: unknown } | { found: false }>,
      set: (scope: StorageScope, key: string, value: unknown) =>
        callHost('storage.set', { scope, key, value }) as Promise<{ ok: true } | { ok: false; error: string; quota?: boolean }>,
      delete: (scope: StorageScope, key: string) =>
        callHost('storage.delete', { scope, key }) as Promise<{ ok: true } | { ok: false; error: string }>,
    },
    network: {
      fetch: (opts: NetworkFetchOptions) =>
        callHost('network.fetch', opts) as Promise<NetworkFetchResult>,
    },
    ai: {
      request: (opts: AiRequestOptions) =>
        callHost('ai.request', opts) as Promise<AiRequestResult>,
    },
    sessions: {
      read: (sessionId: string) =>
        callHost('sessions.read', { sessionId }) as Promise<SessionMetadata | null>,
      send: (sessionId: string, text: string) =>
        callHost('sessions.send', { sessionId, text }).then(() => undefined),
      interrupt: (sessionId: string) =>
        callHost('sessions.interrupt', { sessionId }).then(() => undefined),
    },
    git: {
      read: (sessionId: string, opts: GitReadOptions) =>
        callHost('git.read', { sessionId, ...opts }) as Promise<unknown>,
    },
    workspace: {
      read: (sessionId: string, path: string) =>
        callHost('workspace.read', { sessionId, path }) as Promise<string>,
      write: (sessionId: string, path: string, content: string) =>
        callHost('workspace.write', { sessionId, path, content }).then(() => undefined),
    },
    secrets: {
      get: (key: string) =>
        callHost('secrets.read', { key }) as Promise<{ value: string } | { found: false }>,
      set: (key: string, value: string) =>
        callHost('secrets.write', { key, value }).then(() => undefined),
    },
    ui: {
      clipboard: (text: string) =>
        callHost('ui.clipboard', { text }).then(() => undefined),
      openExternal: (url: string) =>
        callHost('ui.openExternal', { url }) as Promise<{ ok: true }>,
    },
    log: {
      // Best-effort: fire-and-forget with a catch so a host error (teardown,
      // rate-limit rejection) doesn't become an unhandled rejection that
      // crashes the plugin process. Returns Promise<void> so authors can
      // await on the critical path (e.g. before process.exit).
      error: (message: string) => callHost('log', { level: 'error', message }).then(() => undefined, () => undefined),
      warn: (message: string) => callHost('log', { level: 'warn', message }).then(() => undefined, () => undefined),
      info: (message: string) => callHost('log', { level: 'info', message }).then(() => undefined, () => undefined),
      debug: (message: string) => callHost('log', { level: 'debug', message }).then(() => undefined, () => undefined),
      trace: (message: string) => callHost('log', { level: 'trace', message }).then(() => undefined, () => undefined),
    },
  }
}
