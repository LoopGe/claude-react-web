// User-dialog arbitration (blocking CLI prompts, e.g. the refusal-fallback
// dialog).
//
// Mirrors server/elicitation-broker.ts end-to-end:
//   - buildOnUserDialog callback construction (the dialog gate)
//   - decideDialog (client decision responses)
//   - listPendingDialogs / cancelAll (query and teardown)
//   - per-session dialog broadcast (request + resolved)
//
// Key contract: the SDK awaits the Promise returned by `onUserDialog` —
// resolving it IS the answer to that exact request. The pending entry's `id`
// (always a random UUID — the SDK request carries no id field) is only a
// UI-side correlation key shared by the WS broadcast, the REST snapshot, and
// the decide round-trip.
//
// `UserDialogRequest.dialogKind` is an OPEN string union. The SDK contract
// says hosts must answer unrecognized kinds with `{ behavior: 'cancelled' }`,
// so the callback short-circuits those before parking: no pending entry, no
// broadcast, no UI. Only kinds listed in SUPPORTED_DIALOG_KINDS (declared to
// the SDK via Options.supportedDialogKinds at spawn) ever park.
//
// `retractedMessageUuids` (refusal_fallback_prompt payload) is the list of
// already-streamed messages from the refused leg. The CLI's contract is:
// evict them on RESOLUTION (any choice), never on receipt — so the broker
// extracts them at park time and carries them on every resolved broadcast,
// letting every tab evict from its transcript in one place.

import type { OnUserDialog, UserDialogResult } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import {
  SUPPORTED_DIALOG_KINDS,
  type UserDialogDecision,
  type UserDialogRequestUi,
} from '../shared/user-dialog.js'
import type {
  DialogEvent,
  DialogSubscriber,
  PendingUserDialog,
  Session,
} from './session-types.js'
import { HttpError } from './errors.js'
import { createAsyncSubscription } from './async-subscription.js'
import { createLogger } from './log.js'

const log = createLogger('dialog-broker')

export class DialogBroker {
  /** Build the onUserDialog callback for a session.
   *
   *  `onDialogRequest` is the global-broadcast hook, mirroring
   *  ElicitationBroker.buildOnElicitation's `onElicitationRequest`. The
   *  default is a no-op — SessionManager passes its own only if it wants
   *  global notifications later.
   *
   *  `onPendingChanged` fires after every mutation of `session.dialogPending`
   *  (enqueue, abort) so the manager can rebroadcast a fresh SessionInfo. */
  buildOnUserDialog(
    session: Session,
    onDialogRequest: (session: Session, request: UserDialogRequestUi) => void = () => { /* no-op default */ },
    onPendingChanged: (session: Session) => void = () => { /* no-op default */ },
  ): OnUserDialog {
    const broadcastReq = (s: Session, p: PendingUserDialog) => {
      const snapshot = toDialogSnapshot(p)
      this.broadcastDialogRequest(s, p, snapshot)
      onDialogRequest(s, snapshot)
    }
    const broadcastRes = (
      s: Session,
      did: string,
      decision: UserDialogDecision,
      retractedMessageUuids?: string[],
    ) => {
      this.broadcastDialogResolved(s, did, decision, retractedMessageUuids)
    }

    const onUserDialog: OnUserDialog = (request, { signal }) => {
      // Unknown kind: the SDK contract mandates a cancelled answer. Never
      // park, never broadcast — an unrenderable dialog would just wedge the
      // CLI subprocess until the session dies.
      if (!SUPPORTED_DIALOG_KINDS.includes(request.dialogKind)) {
        log.warn(
          `[session ${session.id}] user dialog kind=${request.dialogKind} not supported — auto-cancelling`,
        )
        return Promise.resolve({ behavior: 'cancelled' })
      }
      return this.createPendingDialog(
        session,
        request,
        { signal },
        broadcastReq,
        broadcastRes,
        onPendingChanged,
      )
    }
    return onUserDialog
  }

  /** Shared lifecycle for parking one user dialog. Mints the stable id,
   *  registers the abort handler (the SDK aborts the signal on interrupt /
   *  session teardown), broadcasts, and returns the Promise the SDK awaits.
   *  Mirrors ElicitationBroker.createPendingElicitation. */
  private createPendingDialog(
    session: Session,
    request: Parameters<OnUserDialog>[0],
    ctx: { signal: AbortSignal },
    broadcastReq: (s: Session, p: PendingUserDialog) => void,
    broadcastRes: (
      s: Session,
      did: string,
      decision: UserDialogDecision,
      retractedMessageUuids?: string[],
    ) => void,
    notifyPendingChanged: (s: Session) => void,
  ): Promise<UserDialogResult> {
    return new Promise<UserDialogResult>((resolve) => {
      const id = randomUUID()
      const retractedMessageUuids = extractRetractedUuids(request.payload)
      log.info(
        `[session ${session.id}] user dialog ${id} kind=${request.dialogKind}` +
        (retractedMessageUuids ? ` retracted=${retractedMessageUuids.length}` : ''),
      )
      const abortHandler = () => {
        if (!session.dialogPending.has(id)) return
        session.dialogPending.delete(id)
        log.info(`[session ${session.id}] user dialog ${id} aborted (interrupt)`)
        resolve({ behavior: 'cancelled' })
        broadcastRes(session, id, { behavior: 'cancelled' }, retractedMessageUuids)
        notifyPendingChanged(session)
      }
      const pending: PendingUserDialog = {
        id,
        dialogKind: request.dialogKind,
        payload: request.payload,
        toolUseID: request.toolUseID,
        createdAt: Date.now(),
        resolve,
        signal: ctx.signal,
        abortHandler,
      }
      session.dialogPending.set(id, pending)
      ctx.signal.addEventListener('abort', abortHandler, { once: true })
      broadcastReq(session, pending)
      notifyPendingChanged(session)
    })
  }

  // ─── Public query methods ─────────────────────────────────────────

  /** Detach the abort listener for a pending dialog so the closure doesn't
   *  keep the session alive. */
  private cleanupPending(p: PendingUserDialog): void {
    try {
      p.signal.removeEventListener('abort', p.abortHandler)
    } catch {
      /* ignore */
    }
  }

  /** List pending user dialogs (JSON-safe snapshots). */
  listPendingDialogs(session: Session): UserDialogRequestUi[] {
    return Array.from(session.dialogPending.values()).map(toDialogSnapshot)
  }

  /** Resolve a pending user dialog with the user's decision. Result-value
   *  validation happens in the route layer; here we trust the typed
   *  decision and hand it to the SDK awaiter. The resolved broadcast always
   *  carries the retracted uuid list so every tab evicts the refused leg. */
  decideDialog(session: Session, did: string, decision: UserDialogDecision): void {
    const p = session.dialogPending.get(did)
    if (!p) {
      throw new HttpError(404, `no pending dialog ${did}`)
    }
    this.cleanupPending(p)
    session.dialogPending.delete(did)
    log.info(
      `[session ${session.id}] user dialog ${did} decided behavior=${decision.behavior}` +
      (decision.behavior === 'completed' ? ` result=${String(decision.result)}` : ''),
    )
    p.resolve(decision as UserDialogResult)
    this.broadcastDialogResolved(
      session,
      did,
      decision,
      extractRetractedUuids(p.payload),
    )
  }

  /** Cancel all still-pending user dialogs so no SDK awaiter stays hanging
   *  forever. Called wherever ElicitationBroker.cancelAll runs: unload,
   *  handleProcessExit, and the pump's finally block. */
  cancelAll(session: Session): void {
    for (const [did, p] of session.dialogPending) {
      this.cleanupPending(p)
      try {
        p.resolve({ behavior: 'cancelled' })
        this.broadcastDialogResolved(
          session,
          did,
          { behavior: 'cancelled' },
          extractRetractedUuids(p.payload),
        )
      } catch (err) {
        log.error(`[session ${session.id}] failed to cancel dialog ${did}:`, err)
      }
    }
    session.dialogPending.clear()
  }

  // ─── Subscription ─────────────────────────────────────────────────

  /** Subscription for dialog-channel events. Mirrors
   *  ElicitationBroker.subscribeElicitation. */
  subscribeDialog(session: Session): {
    iterable: AsyncIterable<DialogEvent>
    snapshot: UserDialogRequestUi[]
    unsubscribe: () => void
  } {
    const subId = randomUUID()
    const sub = createAsyncSubscription<DialogEvent>(() => {
      session.dialogSubscribers.delete(subId)
    })
    const dialogSub: DialogSubscriber = { id: subId, push: sub.push, end: sub.end }
    session.dialogSubscribers.set(subId, dialogSub)

    return {
      iterable: sub.iterable,
      snapshot: Array.from(session.dialogPending.values()).map(toDialogSnapshot),
      unsubscribe: () => {
        sub.end()
        session.dialogSubscribers.delete(subId)
      },
    }
  }

  // ─── Per-session broadcast ────────────────────────────────────────

  /** Fan-out a dialog request to per-session subscribers. Accepts an
   *  optional pre-computed snapshot to avoid redundant conversions. */
  broadcastDialogRequest(
    session: Session,
    p: PendingUserDialog,
    precomputed?: UserDialogRequestUi,
  ): void {
    const snapshot = precomputed ?? toDialogSnapshot(p)
    for (const sub of session.dialogSubscribers.values()) {
      sub.push({ kind: 'request', payload: snapshot })
    }
  }

  /** Fan-out a dialog resolved to per-session subscribers. Always carries
   *  the retracted uuid list (when the payload had one) — eviction is
   *  resolution-driven per the CLI contract. */
  broadcastDialogResolved(
    session: Session,
    did: string,
    decision: UserDialogDecision,
    retractedMessageUuids?: string[],
  ): void {
    for (const sub of session.dialogSubscribers.values()) {
      sub.push({ kind: 'resolved', did, decision, retractedMessageUuids })
    }
  }
}

/** Strip the non-serializable fields (resolve/signal/abortHandler) before
 *  the snapshot crosses the wire. Local to this broker — the dialog snapshot
 *  is flat enough that a shared helper isn't warranted. */
function toDialogSnapshot(p: PendingUserDialog): UserDialogRequestUi {
  return {
    id: p.id,
    dialogKind: p.dialogKind,
    payload: p.payload,
    toolUseID: p.toolUseID,
    createdAt: p.createdAt,
  }
}

/** Pull `retractedMessageUuids` out of an opaque dialog payload. Only the
 *  refusal_fallback_prompt kind defines it; anything else (or malformed
 *  values) yields undefined. */
function extractRetractedUuids(payload: Record<string, unknown>): string[] | undefined {
  const v = payload?.retractedMessageUuids
  if (!Array.isArray(v)) return undefined
  const uuids = v.filter((u): u is string => typeof u === 'string')
  return uuids.length > 0 ? uuids : undefined
}
