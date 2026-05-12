// Background pump that iterates a session's Query async generator, appends
// every message to the bounded history ring, and fans out to all live
// subscribers. Extracted from SessionManager.pump() for modularity.
//
// The pump is the session's main loop — it runs until the Query ends or
// crashes, then performs cleanup (deny pending permissions, end subscribers,
// mark session as terminated, persist final state).

import { randomUUID } from 'node:crypto'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Session } from './session-types.js'

export interface PumpDeps {
  historyCap: number
  persist: (session: Session) => void
  denyPendingPermissions: (session: Session) => void
  /** Return true if the session is still tracked in the manager's live map.
   *  Used to avoid overwriting state after unload() has already removed it. */
  isLive: (id: string) => boolean
}

/**
 * Iterate the session's Query to completion, fanning each message out to
 * subscribers and managing the history ring and turn-state bookkeeping.
 *
 * Resolves when the Query ends (normally or with an error). Never throws —
 * errors are captured on `session.error` and broadcast as a synthetic
 * system message so the frontend can surface them.
 */
export async function pump(session: Session, deps: PumpDeps): Promise<void> {
  console.log(`[session ${session.id}] pump started`)
  let msgCount = 0
  try {
    for await (const msg of session.query) {
      session.lastActivityAt = Date.now()
      session.history.push(msg)
      if (session.history.length > deps.historyCap) {
        session.history.splice(0, session.history.length - deps.historyCap)
      }
      for (const sub of session.subscribers.values()) sub.push(msg)
      // Fire a non-blocking context-usage fetch every 10 messages AND
      // on every `result` so the client always has a fresh snapshot at
      // turn boundaries (the count may not land on a multiple of 10).
      if (
        (++msgCount % 10 === 0 || msg.type === 'result') &&
        session.subscribers.size > 0
      ) {
        void session.query.getContextUsage().then(
          (usage) => session.contextUsagePushable.push(usage),
          () => { /* ignore — session may have ended between fire and resolve */ },
        )
      }
      // `result` marks a completed turn. Reset pendingTurns to 0 (each
      // result represents exactly one completed turn). If the user has
      // already queued another message via send(), pendingTurns will be
      // bumped back to 1 there.
      if (msg.type === 'result') {
        console.log(`[session ${session.id}] result received — total msgs: ${msgCount}`)
        session.pendingTurns = 0
        session.workingSince = undefined
        session.lastTurnAt = Date.now()
        deps.persist(session)
      }
    }
    console.log(`[session ${session.id}] pump ended normally — ${msgCount} messages processed`)
  } catch (err) {
    session.error = err instanceof Error ? err.message : String(err)
    // Log with full context — the message alone often omits the stack
    // frame that points at the real culprit (e.g. missing API key,
    // model name typo, CLI subprocess failed to spawn).
    console.error(`[session ${session.id}] pump error after ${msgCount} messages:`, err)
    // Broadcast a synthetic error message so subscribers know what happened.
    const synthetic: SDKMessage = {
      type: 'system',
      subtype: 'error',
      error: session.error,
      uuid: randomUUID(),
      session_id: session.id,
    } as unknown as SDKMessage
    for (const sub of session.subscribers.values()) sub.push(synthetic)
  } finally {
    await cleanupPump(session, deps)
  }
}

async function cleanupPump(session: Session, deps: PumpDeps): Promise<void> {
  // Wrap in its own try/catch so a failure in cleanup (e.g.
  // subscriber.push() throwing, persist() failing) doesn't escape
  // as an unhandledRejection from the pumpTask promise.
  try {
    // If unload() already removed this session from the map (idle GC
    // or graceful shutdown), it has already persisted the correct
    // state. Overwriting here would stamp terminated=true, which
    // prevents the user from resuming the session later. Skip.
    if (!deps.isLive(session.id)) return

    session.running = false
    session.terminated = true
    // Reset pending turns so the UI doesn't stay stuck in "working"
    // when the SDK merged queued messages into fewer turns than were
    // sent, or the session ended before emitting a result for every
    // queued turn.
    session.pendingTurns = 0
    session.workingSince = undefined
    deps.denyPendingPermissions(session)
    for (const sub of session.subscribers.values()) sub.end()
    session.subscribers.clear()
    session.contextUsagePushable.end()
    // Persist the terminal state so the UI shows the transcript as
    // "ended" after a reload, and resume() can refuse to re-spawn it.
    deps.persist(session)
  } catch (cleanupErr) {
    console.error(`[session ${session.id}] pump cleanup error:`, cleanupErr)
  }
}
