// MCP elicitation arbitration (OAuth auth prompts / server-initiated forms).
//
// Mirrors server/permission-broker.ts end-to-end:
//   - buildOnElicitation callback construction (the elicitation gate)
//   - decideElicitation (client decision responses)
//   - listPendingElicitation / cancelAll (query and teardown)
//   - per-session elicitation broadcast (request + resolved)
//
// Key contract: the SDK awaits the Promise returned by `onElicitation` —
// resolving it IS the answer to that exact request. The pending entry's `id`
// (minted from the SDK's optional `elicitationId`, else a random UUID) is
// only a UI-side correlation key shared by the WS broadcast, the REST
// snapshot, and the decide round-trip.
//
// Without this callback wired, the SDK auto-declines every elicitation
// (see Options.onElicitation docs), which makes OAuth-gated MCP servers
// unusable — that's the failure mode this broker exists to prevent.

import type { ElicitationResult, OnElicitation } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import type {
  ElicitationDecision,
  ElicitationEvent,
  ElicitationRequestUi,
  ElicitationSubscriber,
  PendingElicitation,
  Session,
} from './session-types.js'
import { HttpError } from './errors.js'
import { createAsyncSubscription } from './async-subscription.js'
import { createLogger } from './log.js'

const log = createLogger('elicit-broker')

export class ElicitationBroker {
  /** Build the onElicitation callback for a session.
   *
   *  `onElicitationRequest` is the global-broadcast hook, mirroring
   *  PermissionBroker.buildCanUseTool's `onPermissionRequest`. Elicitation is
   *  inherently interactive (the user must complete auth in another tab or
   *  fill a form), so the default is a no-op — SessionManager passes its own
   *  only if it wants global notifications later.
   *
   *  `onPendingChanged` fires after every mutation of
   *  `session.elicitationPending` (enqueue, abort) so the manager can
   *  rebroadcast a fresh SessionInfo. */
  buildOnElicitation(
    session: Session,
    onElicitationRequest: (session: Session, request: ElicitationRequestUi) => void = () => { /* no-op default */ },
    onPendingChanged: (session: Session) => void = () => { /* no-op default */ },
  ): OnElicitation {
    const broadcastReq = (s: Session, p: PendingElicitation) => {
      const snapshot = toElicitationSnapshot(p)
      this.broadcastElicitationRequest(s, p, snapshot)
      onElicitationRequest(s, snapshot)
    }
    const broadcastRes = (s: Session, eid: string, decision: ElicitationDecision) => {
      this.broadcastElicitationResolved(s, eid, decision)
    }

    const onElicitation: OnElicitation = (request, { signal }) => {
      return this.createPendingElicitation(
        session,
        request,
        { signal },
        broadcastReq,
        broadcastRes,
        onPendingChanged,
      )
    }
    return onElicitation
  }

  /** Shared lifecycle for parking one elicitation request. Mints the stable
   *  id, registers the abort handler (the SDK aborts the signal on
   *  interrupt/session teardown), broadcasts, and returns the Promise the
   *  SDK awaits. Mirrors PermissionBroker.createPendingRequest. */
  private createPendingElicitation(
    session: Session,
    request: Parameters<OnElicitation>[0],
    ctx: { signal: AbortSignal },
    broadcastReq: (s: Session, p: PendingElicitation) => void,
    broadcastRes: (s: Session, eid: string, decision: ElicitationDecision) => void,
    notifyPendingChanged: (s: Session) => void,
  ): Promise<ElicitationResult> {
    return new Promise<ElicitationResult>((resolve) => {
      const id = request.elicitationId ?? randomUUID()
      log.info(
        `[session ${session.id}] elicitation ${id} server=${request.serverName} mode=${request.mode ?? 'none'}`,
      )
      const abortHandler = () => {
        if (!session.elicitationPending.has(id)) return
        session.elicitationPending.delete(id)
        log.info(`[session ${session.id}] elicitation ${id} aborted (interrupt)`)
        resolve({ action: 'cancel' })
        broadcastRes(session, id, { action: 'cancel' })
        notifyPendingChanged(session)
      }
      const pending: PendingElicitation = {
        id,
        serverName: request.serverName,
        message: request.message,
        mode: request.mode,
        url: request.url,
        title: request.title,
        displayName: request.displayName,
        description: request.description,
        requestedSchema: request.requestedSchema,
        createdAt: Date.now(),
        resolve,
        signal: ctx.signal,
        abortHandler,
      }
      session.elicitationPending.set(id, pending)
      ctx.signal.addEventListener('abort', abortHandler, { once: true })
      broadcastReq(session, pending)
      notifyPendingChanged(session)
    })
  }

  // ─── Public query methods ─────────────────────────────────────────

  /** Detach the abort listener for a pending elicitation so the closure
   *  doesn't keep the session alive. */
  private cleanupPending(p: PendingElicitation): void {
    try {
      p.signal.removeEventListener('abort', p.abortHandler)
    } catch {
      /* ignore */
    }
  }

  /** List pending elicitation requests (JSON-safe snapshots). */
  listPendingElicitation(session: Session): ElicitationRequestUi[] {
    return Array.from(session.elicitationPending.values()).map(toElicitationSnapshot)
  }

  /** Resolve a pending elicitation request with the user's decision.
   *  Content-value validation happens in the route layer; here we trust the
   *  typed decision and hand it to the SDK awaiter. */
  decideElicitation(session: Session, eid: string, decision: ElicitationDecision): void {
    const p = session.elicitationPending.get(eid)
    if (!p) {
      throw new HttpError(404, `no pending elicitation ${eid}`)
    }
    this.cleanupPending(p)
    session.elicitationPending.delete(eid)
    log.info(
      `[session ${session.id}] elicitation ${eid} decided action=${decision.action}` +
      (decision.content ? ` fields=${Object.keys(decision.content).length}` : ''),
    )
    p.resolve(decision as ElicitationResult)
    this.broadcastElicitationResolved(session, eid, decision)
  }

  /** Cancel all still-pending elicitation requests so no SDK awaiter stays
   *  hanging forever. Called wherever PermissionBroker.denyAll runs: unload,
   *  handleProcessExit, and the pump's finally block. */
  cancelAll(session: Session): void {
    for (const [eid, p] of session.elicitationPending) {
      this.cleanupPending(p)
      try {
        p.resolve({ action: 'cancel' })
        this.broadcastElicitationResolved(session, eid, { action: 'cancel' })
      } catch (err) {
        log.error(`[session ${session.id}] failed to cancel elicitation ${eid}:`, err)
      }
    }
    session.elicitationPending.clear()
  }

  // ─── Subscription ─────────────────────────────────────────────────

  /** Subscription for elicitation-channel events. Mirrors
   *  PermissionBroker.subscribePermissions. */
  subscribeElicitation(session: Session): {
    iterable: AsyncIterable<ElicitationEvent>
    snapshot: ElicitationRequestUi[]
    unsubscribe: () => void
  } {
    const subId = randomUUID()
    const sub = createAsyncSubscription<ElicitationEvent>(() => {
      session.elicitationSubscribers.delete(subId)
    })
    const elicitSub: ElicitationSubscriber = { id: subId, push: sub.push, end: sub.end }
    session.elicitationSubscribers.set(subId, elicitSub)

    return {
      iterable: sub.iterable,
      snapshot: Array.from(session.elicitationPending.values()).map(toElicitationSnapshot),
      unsubscribe: () => {
        sub.end()
        session.elicitationSubscribers.delete(subId)
      },
    }
  }

  // ─── Per-session broadcast ────────────────────────────────────────

  /** Fan-out an elicitation request to per-session subscribers. Accepts an
   *  optional pre-computed snapshot to avoid redundant conversions. */
  broadcastElicitationRequest(
    session: Session,
    p: PendingElicitation,
    precomputed?: ElicitationRequestUi,
  ): void {
    const snapshot = precomputed ?? toElicitationSnapshot(p)
    for (const sub of session.elicitationSubscribers.values()) {
      sub.push({ kind: 'request', payload: snapshot })
    }
  }

  /** Fan-out an elicitation resolved to per-session subscribers. */
  broadcastElicitationResolved(
    session: Session,
    eid: string,
    decision: ElicitationDecision,
  ): void {
    for (const sub of session.elicitationSubscribers.values()) {
      sub.push({ kind: 'resolved', eid, decision })
    }
  }
}

/** Strip the non-serializable fields (resolve/signal/abortHandler) before
 *  the snapshot crosses the wire. Local to this broker — the elicitation
 *  snapshot is flat enough that a shared helper isn't warranted. */
function toElicitationSnapshot(p: PendingElicitation): ElicitationRequestUi {
  return {
    id: p.id,
    serverName: p.serverName,
    message: p.message,
    mode: p.mode,
    url: p.url,
    title: p.title,
    displayName: p.displayName,
    description: p.description,
    requestedSchema: p.requestedSchema,
    createdAt: p.createdAt,
  }
}
