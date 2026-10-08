// Host↔browser client-debug request broker.
//
// The dev-only `appdebug` dom_* tools run in the host process, but the DOM
// lives in the connected browser tabs. This broker parks each MCP tool call,
// broadcasts a `client-debug-request` frame over the global WS channel (via
// the injected transport), and resolves when the first tab answers through
// POST /client-debug/:id/answer.
//
// Semantics:
//   - SUCCESS WINS: concurrent tabs may all execute the op; the losers'
//     answers are dropped (`resolve` returns false). Read ops are idempotent,
//     and `dom_eval` — the one side-effecting op — is gated by a permission
//     prompt precisely because a duplicate execution is possible.
//   - FAILURE GRACE: the first FAILURE answer does not settle immediately —
//     a stale/older tab can fail fast (its DOM doesn't match, its build is
//     old) while a healthy tab is still working. Failure answers open a
//     short grace window; a success landing inside it wins. When the window
//     closes with no success, the request rejects with that failure error —
//     so the common single-tab failure case stays fast.
//   - NO TAB → immediate rejection (the transport reports zero reached tabs).
//   - TIMEOUT → rejection (default 10s; screenshots get extra headroom).
//     One-shot timers: cleared on resolve.
//
// This module is only reachable through dev-mode (see server/dev-mode.ts),
// which is the security boundary for the whole client-debug channel.

import { randomUUID } from 'node:crypto'
import type { ClientDebugAnswer, ClientDebugOp } from '../shared/client-debug.js'
import type { WsClientDebugRequest } from './ws-protocol.js'
import { createLogger } from './log.js'

const log = createLogger('client-debug')

/** Broadcast one request frame to every connected tab. Returns the number of
 *  tabs the frame reached (0 = none connected) so the broker can fail fast
 *  instead of burning the timeout on a headless host. */
export type ClientDebugTransport = (frame: WsClientDebugRequest) => number

const DEFAULT_TIMEOUT_MS = 10_000
/** How long a first FAILURE answer waits for a success answer before it
 *  settles the request (see FAILURE GRACE above). */
const DEFAULT_FAILURE_GRACE_MS = 1_000

/** Per-op timeout budget. dom_screenshot serializes + inlines the whole
 *  subtree and rasterizes on the tab's main thread, so it gets extra
 *  headroom; everything else is a millisecond-scale DOM read. */
const OP_TIMEOUT_MS: Partial<Record<ClientDebugOp, number>> = {
  dom_screenshot: 60_000,
}

interface Pending {
  answer: (answer: ClientDebugAnswer) => void
  timer: ReturnType<typeof setTimeout>
  /** Armed when the first FAILURE answer arrived; a success inside this
   *  window still wins, otherwise the failure settles the request. */
  graceTimer: ReturnType<typeof setTimeout> | null
}

export class ClientDebugBroker {
  private readonly pending = new Map<string, Pending>()
  private readonly timeoutMs: number
  private readonly failureGraceMs: number

  constructor(
    private readonly transport: ClientDebugTransport,
    opts?: { timeoutMs?: number; failureGraceMs?: number },
  ) {
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.failureGraceMs = opts?.failureGraceMs ?? DEFAULT_FAILURE_GRACE_MS
  }

  /** Broadcast one op and await the first tab's answer. Rejects with an
   *  Error whose message is user-presentable (the MCP tool turns it into an
   *  `isError` text result). */
  request(op: ClientDebugOp, params: Record<string, unknown>): Promise<unknown> {
    const id = randomUUID()
    const reached = this.transport({ kind: 'client-debug-request', id, op, params })
    if (reached <= 0) {
      return Promise.reject(
        new Error(`no connected browser tab — open the web UI to use ${op}`),
      )
    }
    const timeoutMs = OP_TIMEOUT_MS[op] ?? this.timeoutMs
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Dropping the entry first makes a late loser answer resolve() false.
        const p = this.pending.get(id)
        this.pending.delete(id)
        if (p?.graceTimer) clearTimeout(p.graceTimer)
        log.debug(`request ${id} (${op}) timed out after ${timeoutMs}ms`)
        reject(new Error(`${op} timed out after ${timeoutMs}ms — no browser tab answered`))
      }, timeoutMs)
      this.pending.set(id, {
        answer: (answer) => {
          if (answer.ok) resolve(answer.result)
          else reject(new Error(answer.error))
        },
        timer,
        graceTimer: null,
      })
    })
  }

  /** Answer a pending request. Returns false for an unknown / already
   *  answered id (loser tab of the first-answer-wins race).
   *
   *  A success settles immediately. The FIRST failure answer only opens the
   *  grace window (a later success inside it still wins); a second failure
   *  is a no-op — the first error is the one reported. */
  resolve(id: string, answer: ClientDebugAnswer): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    if (!answer.ok) {
      if (p.graceTimer) return true // first failure already parked
      p.graceTimer = setTimeout(() => {
        const cur = this.pending.get(id)
        if (!cur || cur !== p) return // main timeout or dispose got there first
        this.pending.delete(id)
        clearTimeout(p.timer)
        p.answer(answer)
      }, this.failureGraceMs)
      return true
    }
    this.pending.delete(id)
    clearTimeout(p.timer)
    if (p.graceTimer) clearTimeout(p.graceTimer)
    p.answer(answer)
    return true
  }

  /** Currently parked requests. */
  get pendingCount(): number {
    return this.pending.size
  }

  /** Reject every pending request (host shutdown). */
  disposeAll(reason: string): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id)
      clearTimeout(p.timer)
      if (p.graceTimer) clearTimeout(p.graceTimer)
      p.answer({ ok: false, error: reason })
    }
  }
}
