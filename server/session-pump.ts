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
import { debugLog } from './debug.js'

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
    // Race iter.next() against the session's abort signal so unload() can
    // break a wedged generator immediately instead of waiting for the SDK
    // subprocess to exit on its own. Built ONCE per session: once the abort
    // promise resolves, every subsequent race short-circuits to done.
    const signal = session.abortController.signal
    const abortPromise: Promise<IteratorResult<SDKMessage>> = new Promise((resolve) => {
      if (signal.aborted) {
        resolve({ done: true, value: undefined })
        return
      }
      signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), { once: true })
    })
    // Idle watchdog: every time we await query.next(), start a 60s timer
    // that warns if nothing comes back. This distinguishes "SDK produced
    // nothing" from "pump stuck processing a specific message" when
    // debugging stuck sessions.
    while (true) {
      const nextStartedAt = Date.now()
      debugLog(`[session ${session.id}] pump awaiting iter.next() for msg #${msgCount + 1}`)
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
        step = await Promise.race([iter.next(), abortPromise])
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
      // SDK 0.3 echoes top-level user input back through the Query stream
      // (sometimes as SDKUserMessageReplay with isReplay=true, sometimes
      // — notably the very first turn after spawn — as a plain
      // SDKUserMessage with no replay marker). Either way, we already
      // broadcast our own user messages via SessionManager.send() /
      // sendContent(), so forwarding the SDK's echo paints the bubble
      // twice. The reliable discriminator is `parent_tool_use_id`: top-
      // level user input has it === null, while tool results and
      // sub-agent outputs (which we DO want to forward) have it set to
      // the originating tool_use id.
      if (msg.type === 'user' && (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id == null) {
        debugLog(`[session ${session.id}] dropping echoed top-level user message uuid=${(msg as { uuid?: string }).uuid}`)
        continue
      }
      debugLog(
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
      msgCount++
      // Derive a context-usage snapshot directly from the result's own
      // `usage` + `modelUsage` payload — no IPC. The result message is
      // the SDK's authoritative tally for the API call that just landed,
      // so we get exact numbers for free instead of round-tripping into
      // the CLI subprocess for getContextUsage(). The full breakdown
      // (skills/agents/memoryFiles/mcpTools) still comes from the
      // on-demand REST endpoint when the user opens SettingsPanel.
      if (msg.type === 'result' && session.subscribers.size > 0) {
        const usage = liteContextUsageFromResult(msg)
        if (usage) {
          for (const sub of session.contextUsageSubscribers) sub.push(usage)
        }
      }
      // `result` marks a completed turn. Reset pendingTurns to 0 (each
      // result represents exactly one completed turn). If the user has
      // already queued another message via send(), pendingTurns will be
      // bumped back to 1 there.
      if (msg.type === 'result') {
        debugLog(`[session ${session.id}] result received — total msgs: ${msgCount}`)
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
    session.exiting = false
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

/** Subset of getContextUsage's response that ContextBar actually renders.
 *  See src/hooks/useChatStream.ts:ContextUsage — these are the four fields
 *  the chat-side bar reads (totalTokens, maxTokens, percentage, model).
 *  rawMaxTokens is included because ContextBar prefers it over maxTokens. */
interface LiteContextUsage {
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  percentage: number
  model: string
}

/** Build a LiteContextUsage from a `result` SDK message. Returns null when
 *  the message lacks the expected fields (e.g. result errors before the
 *  API call landed).
 *  @internal — exported only for unit tests; not part of the module's
 *              public API. */
export function liteContextUsageFromResult(msg: SDKMessage): LiteContextUsage | null {
  if (msg.type !== 'result') return null
  // The result message's `usage` and `modelUsage` shapes are SDK-specific
  // and broader than what we read here — cast through unknown so we can
  // pick out only the numeric fields we care about. Missing fields fall
  // back to 0 below.
  type IterationUsage = {
    type?: 'message' | 'compaction' | 'advisor_message'
    input_tokens?: number
    cache_creation_input_tokens?: number | null
    cache_read_input_tokens?: number | null
  }
  const result = msg as unknown as {
    usage?: IterationUsage & { iterations?: IterationUsage[] | null }
    modelUsage?: Record<string, { contextWindow?: number }>
  }
  const usage = result.usage
  const modelUsage = result.modelUsage
  if (!usage || !modelUsage) return null

  // Pick the model with a contextWindow set. In practice modelUsage has
  // exactly one entry per turn — but we iterate defensively.
  let model = ''
  let contextWindow = 0
  for (const [name, info] of Object.entries(modelUsage)) {
    if (info?.contextWindow && info.contextWindow > 0) {
      model = name
      contextWindow = info.contextWindow
      break
    }
  }
  if (contextWindow <= 0) return null

  // Context-window usage = the prompt size of the most recent regular
  // sampling iteration. We must:
  //   1. Skip non-'message' iteration types. 'compaction' iterations
  //      report the SIZE OF THE SUMMARIZED SOURCE MATERIAL in
  //      `input_tokens` (can be many millions — far past any model's
  //      window). 'advisor_message' iterations are internal sub-calls
  //      that don't reflect what the user-facing model "saw".
  //   2. Fall back to top-level `usage` only when iterations is absent
  //      or empty (single-call turn — top-level == that one call).
  // Per Anthropic SDK docs: "Calculate the true context window size
  // from the last iteration." — but only the last `message` iteration.
  let source: IterationUsage = usage
  if (usage.iterations && usage.iterations.length > 0) {
    let pickedMessage = false
    for (let i = usage.iterations.length - 1; i >= 0; i--) {
      if (usage.iterations[i].type === 'message') {
        source = usage.iterations[i]
        pickedMessage = true
        break
      }
    }
    // No 'message' iteration in this turn (e.g. a turn that's purely
    // compaction). Pick the last iteration of any kind but flag it for
    // clamping below — this is the rare path that historically produced
    // 2337k / 200k numbers.
    if (!pickedMessage) {
      source = usage.iterations[usage.iterations.length - 1]
    }
  }
  const rawTotal =
    (source.input_tokens ?? 0) +
    (source.cache_creation_input_tokens ?? 0) +
    (source.cache_read_input_tokens ?? 0)

  // Defensive clamp: a single API call's prompt cannot legitimately
  // exceed the model's context window. If we still see > 100%, the
  // SDK is reporting in a way we don't understand — log the raw
  // payload so the next sighting is debuggable, and cap the displayed
  // value so the bar is sane.
  const totalTokens = Math.min(rawTotal, contextWindow)
  if (rawTotal > contextWindow) {
    debugLog(
      `[context-usage] raw total ${rawTotal} > contextWindow ${contextWindow} for model ${model}; ` +
      `clamping. iterations=${JSON.stringify(usage.iterations ?? null)} top-level=${JSON.stringify({
        input_tokens: usage.input_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
      })}`,
    )
  }

  return {
    totalTokens,
    maxTokens: contextWindow,
    rawMaxTokens: contextWindow,
    percentage: (totalTokens / contextWindow) * 100,
    model,
  }
}
