// JSON-RPC 2.0 child-process runtime for App Plugins.
//
// `definePlugin(handlers)` sets up the stdio protocol so the plugin author
// only writes activate/deactivate/executeCommand handlers. The Host API
// (storage/network/ai/…) is exposed as a typed `host` object passed to
// executeCommand — authors never frame JSON-RPC themselves.
//
// The transport is injectable (default: process stdio) so the runtime can be
// tested with an in-memory transport pair.

import readline from 'node:readline'
import { createHost } from './host.js'
import type { Host } from './types.js'
import type {
  ActivateContext,
  DeactivateReason,
  ExecuteCommandRequest,
  PluginCommandContext,
  PluginCommandResult,
} from './types.js'

/** A bidirectional JSON-RPC transport. `send` writes a framed message;
 *  `onMessage` registers a listener for parsed incoming messages. */
export interface Transport {
  send(frame: string): void
  onMessage(cb: (msg: unknown) => void): () => void
}

interface JsonRpcRequest { jsonrpc: '2.0'; id?: number | string; method: string; params?: unknown }
interface JsonRpcResponse { jsonrpc: '2.0'; id: number | string; result?: unknown; error?: { code: number; message: string; data?: unknown } }

export interface PluginHandlers {
  activate?: (ctx: ActivateContext) => Promise<{ ok: true } | { ok: false; error: string }>
  deactivate?: (reason: DeactivateReason) => Promise<void | { ok: true } | { ok: false; error: string }>
  executeCommand?: (req: ExecuteCommandRequest) => Promise<PluginCommandResult>
  /** Optional: the host cancelled an in-flight command (best-effort — the
   *  plugin should abort long work). */
  onCancel?: (invocationId: string) => void
}

/** Define + start a plugin. Call once at module top-level:
 *  `export default definePlugin({ activate, executeCommand })`. */
export function definePlugin(handlers: PluginHandlers, transport?: Transport): void {
  const tx = transport ?? createStdioTransport()
  const callHost = createCallHost()
  const host = createHost(callHost)
  let nextId = 1
  const pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  tx.onMessage((msg) => {
    const m = msg as JsonRpcResponse | JsonRpcRequest
    if (!m || typeof m !== 'object' || (m as { jsonrpc?: string }).jsonrpc !== '2.0') return

    // Response to one of our callHost requests.
    if ('id' in m && m.id != null && ('result' in m || 'error' in m)) {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      const r = m as JsonRpcResponse
      if (r.error) p.reject(new HostError(r.error.code, r.error.message, r.error.data))
      else p.resolve(r.result)
      return
    }

    // Inbound request/notification from the host.
    if ('method' in m) {
      const req = m as JsonRpcRequest
      if (req.method === 'cancel') {
        // Notification — no response.
        const { invocationId } = (req.params ?? {}) as { invocationId?: string }
        if (invocationId) handlers.onCancel?.(invocationId)
        return
      }
      // Request — dispatch + respond.
      void handleInbound(handlers, host, req)
        .then(
          (result) => { if (req.id != null) send(tx, { jsonrpc: '2.0', id: req.id, result: result ?? null }) },
          (err) => { if (req.id != null) send(tx, { jsonrpc: '2.0', id: req.id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } }) },
        )
    }
  })

  /** Call a host (Host API) method and await the response. Times out after
   *  60s so a wedged host doesn't hang the plugin forever. */
  function createCallHost(): (method: string, params?: unknown) => Promise<unknown> {
    return (method: string, params?: unknown): Promise<unknown> => {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`host call '${method}' timed out after ${CALL_HOST_TIMEOUT_MS}ms`))
        }, CALL_HOST_TIMEOUT_MS)
        pending.set(id, {
          resolve: (v: unknown) => { clearTimeout(timer); resolve(v) },
          reject: (e: Error) => { clearTimeout(timer); reject(e) },
        })
        send(tx, { jsonrpc: '2.0', id, method, params })
      })
    }
  }
}

const CALL_HOST_TIMEOUT_MS = 60_000

async function handleInbound(handlers: PluginHandlers, host: Host, req: JsonRpcRequest): Promise<unknown> {
  const p = (req.params ?? {}) as Record<string, unknown>
  if (req.method === 'activate') {
    // Await BEFORE applying ?? — otherwise ?? operates on the Promise (always
    // non-null) and a void-returning activate sends `undefined` → host crashes
    // on `null.ok`.
    const result = await handlers.activate?.(p as unknown as ActivateContext)
    return result ?? { ok: true }
  }
  if (req.method === 'deactivate') {
    const reason = (p.reason ?? 'shutdown') as DeactivateReason
    const result = await handlers.deactivate?.(reason)
    return result ?? { ok: true }
  }
  if (req.method === 'executeCommand') {
    if (!handlers.executeCommand) return { type: 'none', invocationId: p.invocationId }
    const result = await handlers.executeCommand({
      invocationId: p.invocationId as string,
      commandId: p.commandId as string,
      context: p.context as PluginCommandContext,
      host,
    })
    return result
  }
  // Unknown method — let the host see a method-not-found error.
  throw new Error(`unknown method: ${req.method}`)
}

function send(tx: Transport, msg: unknown): void {
  tx.send(JSON.stringify(msg))
}

/** An error from a host (Host API) call, carrying the JSON-RPC error code. */
export class HostError extends Error {
  readonly code: number
  readonly data?: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

/** Default transport: newline-delimited JSON-RPC over process stdio. */
export function createStdioTransport(): Transport {
  const rl = readline.createInterface({ input: process.stdin })
  const listeners = new Set<(msg: unknown) => void>()
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const msg = JSON.parse(trimmed)
      for (const fn of listeners) fn(msg)
    } catch {
      /* ignore non-JSON lines (plugin stdout noise) */
    }
  })
  // If the parent process dies, stdin/stdout pipes close and emit 'error'.
  // Without listeners, Node throws an uncaught exception. Attach no-ops so
  // the plugin exits cleanly instead of crashing.
  process.stdin.on('error', () => { /* parent gone */ })
  process.stdout.on('error', () => { /* parent gone */ })
  return {
    send: (frame: string) => { process.stdout.write(frame + '\n') },
    onMessage: (cb) => {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
  }
}
