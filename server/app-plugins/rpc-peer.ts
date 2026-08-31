// Parent-side JSON-RPC 2.0 peer over stdio for a single plugin subprocess.
//
// Transport only — lifecycle (activate/deactivate/executeCommand, crash-loop
// quarantine) lives in plugin-process.ts. This class:
//   - spawns the child with a fixed argv (never a shell), a cleaned env, and
//     the plugin's data dir as cwd;
//   - frames newline-delimited JSON-RPC on stdout (protocol) and captures
//     stderr (logs, rate-limited by the caller);
//   - tracks outbound requests by id with per-call timeout + cancellation;
//   - dispatches inbound requests (the Host API) to a handler map.
//
// Trust model (see shared/app-plugins/permissions.ts): the child is a trusted
// local program. The RPC boundary is for capability routing + audit, NOT a
// security sandbox — the child can `import node:fs`. We still validate every
// inbound message's shape before acting on it.

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { createLogger } from '../log.js'
import {
  RPC_CODES,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcSuccessResult,
  type JsonRpcErrorResult,
  type JsonRpcNotification,
} from '../../shared/app-plugins/rpc-protocol.js'
import { LIMITS } from '../../shared/app-plugins/validation.js'

const log = createLogger('app-plugins:rpc')

export interface RpcPeerOptions {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Called for every captured stderr line (already rate-limited upstream
   *  by the process manager). */
  onLog?: (line: string) => void
  /** Called when the child exits before the peer was closed. */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
}

type Handler = (params: unknown) => Promise<unknown>

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  /** Abort listener registered on `signal`, removed when the call settles so
   *  a reused signal doesn't accumulate listeners across calls. */
  onAbort?: () => void
  signal?: AbortSignal
}

export class RpcPeer {
  private proc: ChildProcess | null = null
  private readonly handlers = new Map<string, Handler>()
  private readonly pending = new Map<number | string, PendingCall>()
  private nextId = 1
  private closed = false
  /** Set on the child's `exit` event so close()'s SIGKILL fallback can tell
   *  whether SIGTERM actually terminated the process — `proc.killed` is true
   *  the moment kill() is *called*, not when the process dies, so it can't
   *  be used to decide whether to escalate to SIGKILL. */
  private exited = false

  constructor(private readonly opts: RpcPeerOptions) {}

  registerHandler(method: string, fn: Handler): void {
    this.handlers.set(method, fn)
  }

  /** Whether the child process has exited (crash, signal, or close). Lets
   *  callers distinguish "child is gone" from "child is alive but wedged". */
  get childExited(): boolean {
    return this.exited
  }

  /** Spawn the child. Resolves once the process is created (NOT once
   *  activate completes — that's a separate `call('activate', ...)`). */
  start(): void {
    if (this.proc) return
    const { command, args, cwd, env } = this.opts
    this.proc = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Never a shell — the command is `node` (or a fixed binary) with a
      // fixed argv, so there's nothing to inject.
      shell: false,
    })
    const proc = this.proc

    proc.stdout?.setEncoding('utf8')
    // JSON-RPC frames are newline-delimited. Use readline to split cleanly
    // across chunk boundaries.
    const stdout = createInterface({ input: proc.stdout! })
    stdout.on('line', (line) => this.onStdoutLine(line))

    proc.stderr?.setEncoding('utf8')
    const stderr = createInterface({ input: proc.stderr! })
    stderr.on('line', (line) => {
      this.opts.onLog?.(line)
    })

    proc.on('exit', (code, signal) => {
      this.exited = true
      if (this.closed) return
      this.failAll(new Error(`plugin process exited (code=${code}, signal=${signal})`))
      this.opts.onExit?.(code, signal)
    })
    proc.on('error', (err) => {
      log.error(`spawn error: ${err.message}`)
      this.failAll(err)
    })
  }

  /** Send a request and await the response. Rejects on timeout, cancel, or
   *  process exit. */
  call(method: string, params?: unknown, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    if (!this.proc || this.closed) return Promise.reject(new Error('rpc peer not started or closed'))
    // Child already dead: nothing will ever answer. failAll only covers calls
    // that were pending AT exit time, so without this guard a call made after
    // the exit event stalls out its full timeout (e.g. deactivate against a
    // child killed by the host's shutdown signal stalled
    // DEACTIVATE_TIMEOUT_MS per plugin, silently, every shutdown).
    if (this.exited) return Promise.reject(new Error('plugin process exited'))
    const id = this.nextId++
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? 15_000
      const timer = setTimeout(() => {
        const p = this.pending.get(id)
        if (!p) return
        this.pending.delete(id)
        p.reject(new Error(`rpc call '${method}' timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const pending: PendingCall = {
        resolve: (v) => {
          clearTimeout(timer)
          this.pending.delete(id)
          if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort)
          resolve(v)
        },
        reject: (err) => {
          clearTimeout(timer)
          this.pending.delete(id)
          if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort)
          reject(err)
        },
        timer,
      }
      this.pending.set(id, pending)
      if (opts.signal) {
        if (opts.signal.aborted) {
          pending.reject(new Error(`rpc call '${method}' cancelled`))
        } else {
          pending.signal = opts.signal
          pending.onAbort = () => pending.reject(new Error(`rpc call '${method}' cancelled`))
          opts.signal.addEventListener('abort', pending.onAbort, { once: true })
        }
      }
      this.send(req)
    })
  }

  /** Fire-and-forget notification (no id, no response). */
  notify(method: string, params?: unknown): void {
    if (!this.proc || this.closed) return
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params }
    this.send(msg)
  }

  /** Cancel an in-flight call by rejecting it with a cancel error and
   *  notifying the child. */
  cancel(invocationId: string): void {
    this.notify('cancel', { invocationId })
  }

  /** Kill the child and reject all pending. Idempotent. Uses `this.exited`
   *  (set on the exit event) rather than `proc.killed` to decide whether to
   *  escalate SIGTERM → SIGKILL — `killed` flips true on the kill() *call*,
   *  so the SIGKILL fallback would otherwise never fire and a SIGTERM-ignoring
   *  child would orphan. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.failAll(new Error('rpc peer closed'))
    const proc = this.proc
    if (!proc) return
    if (proc.stdin) {
      try { proc.stdin.end() } catch { /* already closed */ }
    }
    if (!this.exited) {
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
      // Give it a moment, then force if it hasn't exited.
      await new Promise((r) => setTimeout(r, 200))
      if (!this.exited) {
        try { proc.kill('SIGKILL') } catch { /* ignore */ }
      }
    }
  }

  // ── Internals ──────────────────────────────────────────────────────

  private send(msg: JsonRpcMessage): void {
    if (!this.proc?.stdin || this.closed) return
    const json = JSON.stringify(msg)
    if (Buffer.byteLength(json, 'utf8') > LIMITS.rpcMessageBytes) {
      const method = 'method' in msg ? msg.method : 'response'
      log.warn(`outbound rpc message for ${method} exceeds ${LIMITS.rpcMessageBytes} bytes; dropping`)
      // If this was a request (has an id), reject the pending caller
      // immediately instead of leaving it to hang until the timeout fires.
      if ('id' in msg && msg.id != null) {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          clearTimeout(p.timer)
          p.reject(new Error(`outbound rpc message for ${method} exceeds ${LIMITS.rpcMessageBytes} bytes`))
        }
      }
      return
    }
    this.proc.stdin.write(json + '\n')
  }

  private onStdoutLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    // Bound the inbound message size — `send()` checks outbound, but
    // readline imposes no max line length, so without this a buggy/hostile
    // plugin could emit an unbounded line and OOM the host before parse.
    if (trimmed.length > LIMITS.rpcMessageBytes) {
      log.warn(`inbound rpc line exceeds ${LIMITS.rpcMessageBytes} bytes; dropping`)
      return
    }
    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage
    } catch {
      log.warn(`non-JSON line on plugin stdout (ignored): ${trimmed.slice(0, 200)}`)
      return
    }
    if (!msg || typeof msg !== 'object' || (msg as { jsonrpc?: string }).jsonrpc !== '2.0') {
      log.warn(`invalid rpc message on stdout: ${trimmed.slice(0, 200)}`)
      return
    }
    // Response to one of our requests.
    if ('id' in msg && (msg as { id?: unknown }).id != null && ('result' in msg || 'error' in msg)) {
      this.onResponse(msg as JsonRpcSuccessResult | JsonRpcErrorResult)
      return
    }
    // Inbound request or notification from the plugin (Host API).
    if ('method' in msg) {
      void this.onRequestOrNotification(msg as JsonRpcRequest | JsonRpcNotification)
    }
  }

  private onResponse(msg: JsonRpcSuccessResult | JsonRpcErrorResult): void {
    const p = this.pending.get(msg.id)
    if (!p) return // stale response after timeout/cancel — drop
    if ('error' in msg) {
      p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data))
    } else {
      p.resolve((msg as JsonRpcSuccessResult).result)
    }
  }

  private async onRequestOrNotification(msg: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    const hasId = 'id' in msg && msg.id != null
    const handler = this.handlers.get(msg.method)
    if (!handler) {
      if (hasId) this.send({ jsonrpc: '2.0', id: (msg as JsonRpcRequest).id, error: { code: RPC_CODES.METHOD_NOT_FOUND, message: `method not found: ${msg.method}` } })
      return
    }
    if (!hasId) {
      // Notification — fire and forget, swallow errors.
      try { await handler(msg.params) } catch (err) { log.warn(`handler '${msg.method}' threw: ${(err as Error).message}`) }
      return
    }
    const id = (msg as JsonRpcRequest).id
    try {
      const result = await handler(msg.params)
      this.send({ jsonrpc: '2.0', id, result: result ?? null })
    } catch (err) {
      const e = err as RpcError
      this.send({
        jsonrpc: '2.0',
        id,
        error: { code: e.code ?? RPC_CODES.INTERNAL_ERROR, message: e.message ?? 'internal error', data: e.data },
      })
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
  }
}

/** Typed RPC error so handlers can reject with a code the child sees. */
export class RpcError extends Error {
  readonly code?: number
  readonly data?: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

/** Generate a correlation id used for invocationId (server-generated, unique
 *  across tabs). Exposed so the command router and host handlers share one
 *  id space. */
export function newInvocationId(): string {
  return randomUUID()
}
