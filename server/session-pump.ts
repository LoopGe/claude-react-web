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
  /** Called when the Query exits cleanly (no error). If it returns true,
   *  the session is being auto-resumed — skip full cleanup (don't mark
   *  terminated, don't end subscribers). If it returns false or throws,
   *  fall through to normal termination. */
  autoResume?: (session: Session) => Promise<boolean>
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
    const iter = session.query[Symbol.asyncIterator]()
    // Idle watchdog: every time we await query.next(), start a 60s timer
    // that warns if nothing comes back. This distinguishes "SDK produced
    // nothing" from "pump stuck processing a specific message" when
    // debugging stuck sessions.
    while (true) {
      const nextStartedAt = Date.now()
      console.log(`[session ${session.id}] pump awaiting iter.next() for msg #${msgCount + 1}`)
      let idleWarnCount = 0
      const idleTimer = setInterval(() => {
        // Only warn when there's pending work that should have produced
        // a message. Idle with pendingTurns=0 and no pending permissions
        // is normal — the session is waiting for user input.
        if (session.pendingTurns === 0 && session.pending.size === 0) return
        idleWarnCount++
        console.warn(
          `[session ${session.id}] query.next() idle for ${Date.now() - nextStartedAt}ms ` +
          `(waiting for msg #${msgCount + 1}, warn #${idleWarnCount}, ` +
          `pendingTurns=${session.pendingTurns}, pending perms=${session.pending.size})`,
        )
      }, 10_000)
      let step: IteratorResult<SDKMessage>
      try {
        // Race iter.next() against the session's abort signal so
        // unload() can break a wedged generator immediately instead
        // of waiting for the SDK subprocess to exit on its own.
        const signal = session.abortController.signal
        step = await (signal.aborted
          ? Promise.resolve({ done: true, value: undefined } as IteratorResult<SDKMessage>)
          : Promise.race([
              iter.next(),
              new Promise<IteratorResult<SDKMessage>>((resolve) =>
                signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), { once: true }),
              ),
            ]))
      } finally {
        clearInterval(idleTimer)
      }
      if (step.done) {
        // When the loop exits (normally or via abort signal), explicitly
        // close the async iterator so the SDK can clean up its subprocess
        // resources (stdin pipe, child process, etc.). Without this,
        // aborting the session may leave orphan CLI processes.
        await iter.return?.()
        break
      }
      const msg = step.value
      const msgSubtype = (msg as unknown as { subtype?: string }).subtype
      console.log(
        `[session ${session.id}] msg #${msgCount + 1} received — ` +
        `type=${msg.type}${msgSubtype ? `/${msgSubtype}` : ''} ` +
        `(next() took ${Date.now() - nextStartedAt}ms)`,
      )
      session.lastActivityAt = Date.now()
      // The session has produced something since the last GC kick, so any
      // pending auto-interrupt mark is no longer relevant — clear it so a
      // future silence triggers fresh detection rather than immediately
      // escalating to unload.
      session.autoInterruptedAt = undefined
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
          (usage) => {
            for (const sub of session.contextUsageSubscribers) sub.push(usage)
          },
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

    // When the Query exits cleanly (no error), try auto-resume first.
    // This keeps the session alive transparently — the CLI subprocess
    // likely exited due to idle timeout, not user intent.
    if (!session.error && deps.autoResume) {
      try {
        const resumed = await deps.autoResume(session)
        if (resumed) return // Session re-spawned — skip full cleanup
      } catch (resumeErr) {
        console.error(`[session ${session.id}] auto-resume failed, falling back to termination:`, resumeErr)
      }
    }

    session.running = false
    session.terminated = true
    // Only set terminatedReason if it hasn't already been set by
    // handleProcessExit (which provides more specific values like
    // 'process_killed' or 'process_exited').
    if (!session.terminatedReason) {
      session.terminatedReason = session.error ? 'query_error' : 'query_ended'
    }
    // Reset pending turns so the UI doesn't stay stuck in "working"
    // when the SDK merged queued messages into fewer turns than were
    // sent, or the session ended before emitting a result for every
    // queued turn.
    session.pendingTurns = 0
    session.workingSince = undefined
    deps.denyPendingPermissions(session)
    for (const sub of session.subscribers.values()) sub.end()
    session.subscribers.clear()
    for (const sub of session.permissionSubscribers.values()) sub.end()
    session.permissionSubscribers.clear()
    for (const sub of session.contextUsageSubscribers) sub.end()
    session.contextUsageSubscribers.clear()
    // Persist the terminal state so the UI shows the transcript as
    // "ended" after a reload, and resume() can refuse to re-spawn it.
    deps.persist(session)
  } catch (cleanupErr) {
    console.error(`[session ${session.id}] pump cleanup error:`, cleanupErr)
  }
}
