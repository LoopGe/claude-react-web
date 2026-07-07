// Background pump that iterates a session's Query async generator, appends
// every message to the bounded history ring, and fans out to all live
// subscribers. Extracted from SessionManager.pump() for modularity.
//
// The pump is the session's main loop dit runs until the Query ends or
// crashes, then performs cleanup (deny pending permissions, end subscribers,
// mark session as terminated, persist final state).

import { randomUUID } from 'node:crypto'
import type { FastModeState, SDKMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { Session, SessionBroadcaster } from './session-types.js'
import { endAllSubscribers } from './session-types.js'
import { pushBounded, stampReceivedAt, shouldBroadcastMessage } from './history-utils.js'
import { mutatingToolUseId, scheduleGitBroadcast } from './git-broadcast.js'
import { createLogger } from './log.js'
import type { HookRunRecord, HookRuntimeEvent, HookRunStatus } from '../shared/hooks.js'

const MAX_HOOK_OUTPUT_CHARS = 20_000

function trimHookOutput(value: string): string {
  if (value.length <= MAX_HOOK_OUTPUT_CHARS) return value
  const head = value.slice(0, 10_000)
  const tail = value.slice(value.length - 8_000)
  const omitted = value.length - head.length - tail.length
  return `${head}\n\n[... ${omitted} chars omitted ...]\n\n${tail}`
}

/** Maximum characters kept in a single `tool_result` content block.
 *  ~50K chars ≈ 12K tokens — comfortably under the SDK's own 25K-token
 *  MCP output cap while leaving room for other context.  The head+tail
 *  strategy preserves the beginning (usually the most useful part) and
 *  the end (often contains summary / error info). */
const MAX_TOOL_RESULT_CHARS = 50_000

function trimLargeToolResultBlock(block: {
  type: unknown; content?: unknown
}): boolean {
  if (block.type !== 'tool_result') return false
  const c = (block as { content?: unknown }).content
  if (typeof c === 'string') {
    if (c.length <= MAX_TOOL_RESULT_CHARS) return false
    const head = c.slice(0, 30_000)
    const tail = c.slice(c.length - 15_000)
    const omitted = c.length - head.length - tail.length
    ;(block as { content: string }).content =
      `${head}\n\n[... ${omitted} chars omitted ...]\n\n${tail}`
    return true
  }
  if (Array.isArray(c)) {
    let trimmed = false
    for (const item of c) {
      if (!item || typeof item !== 'object') continue
      const it = item as { type?: unknown; text?: unknown }
      if (it.type === 'text' && typeof it.text === 'string' && it.text.length > MAX_TOOL_RESULT_CHARS) {
        const head = it.text.slice(0, 30_000)
        const tail = it.text.slice(it.text.length - 15_000)
        const omitted = it.text.length - head.length - tail.length
        it.text = `${head}\n\n[... ${omitted} chars omitted ...]\n\n${tail}`
        trimmed = true
      }
    }
    return trimmed
  }
  return false
}

/** Mutate `msg` in-place: trim any oversized `tool_result` content blocks
 *  inside user messages.  Called once, before the message enters the history
 *  ring and subscriber broadcast — so every downstream consumer (replay,
 *  WS push, localStorage, render) sees the trimmed version. */
export function trimLargeToolResults(msg: SDKMessage): void {
  if (msg.type !== 'user') return
  const content = (msg as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block && typeof block === 'object') trimLargeToolResultBlock(block)
  }
}

/** Extract `parent_tool_use_id` from an SDK message defensively.
 *  Returns the value for user/assistant messages; undefined for types
 *  that don't carry the fiel?. Server-side SDKMessage is a discriminated
 *  union, so the cast is necessary dthe field is only guaranteed on
 *  SDKUserMessage / SDKAssistantMessage variants. */
export function getParentToolUseId(msg: SDKMessage): string | null | undefined {
  return (msg as { parent_tool_use_id: string | null }).parent_tool_use_id
}

const log = createLogger('pump')

/** True when an SDK `user` message carries at least one `tool_result`
 *  content block. Used to distinguish a genuine top-level user-input echo
 *  (text/image blocks only ddrop it, we already broadcast our own copy)
 *  from a tool_result frame (forward it, the UI needs it to resolve the
 *  tool card's status). Defensive against string content and odd shapes. */
export function userMessageHasToolResult(msg: SDKMessage): boolean {
  const content = (msg as { message: { content: unknown } }).message?.content
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type: unknown }).type === 'tool_result') {
      return true
    }
  }
  return false
}

/** True when a top-level `user` message's leading text is a
 *  `<task-notification>` XML block dthe harness's background-subagent
 *  result injection (delivered as user-role text for the model to consume
 *  on its next turn). The pump's echo drop-filter must NOT drop these:
 *  they aren't echoes of server-broadcast human input, so forwarding them
 *  lets the client render the result as a task-result card instead of
 *  silently losing it. Mirrors the client-side check in
 *  src/session-store/normalize.ts. */
export function isTaskNotificationUserMessage(msg: SDKMessage): boolean {
  if (msg.type !== 'user') return false
  // Subagent-internal user frames (parent_tool_use_id set) are never a
  // top-level task-notification injection; the pump's drop-filter only
  // calls this on null-parent frames anyway, but keep the guard so the
  // helper is correct standalone (mirrors the client check).
  if (getParentToolUseId(msg) != null) return false
  const content = (msg as { message?: { content?: unknown } }).message?.content
  let text: string | undefined
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const t = (block as { text?: unknown }).text
        if (typeof t === 'string') { text = t; break }
      }
    }
  }
  return !!text && /^\s*<task-notification\b/i.test(text)
}

/** All `tool_use_id`s carried by a user message's tool_result blocks. The
 *  originating tool_use id lives on the block, not on the message's
 *  `parent_tool_use_id` (null for main-thread results). */
export function toolResultIds(msg: SDKMessage): string[] {
  const content = (msg as { message: { content: unknown } }).message?.content
  if (!Array.isArray(content)) return []
  const ids: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type: unknown; tool_use_id?: unknown }
    if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') ids.push(b.tool_use_id)
  }
  return ids
}

/** Extract the SDK-reported `fast_mode_state` from a message, if present.
 *  The field rides on `system/init` and `result` (success + error) messages
 *  (see sdk.?.ts: SDKSystemMessage, SDKResultSuccess, SDKResultError). We
 *  probe every message defensively rather than branching on type da missing
 *  field is simply undefine?. Returns undefined when absent (which also means
 *  "the current model doesn't support fast mode"). Pure dexported for tests. */

function commandsChanged(msg: SDKMessage): SlashCommand[] | undefined {
  const candidate = msg as { type: unknown; subtype: unknown; commands: unknown }
  if (candidate.type !== 'system' || candidate.subtype !== 'commands_changed') return undefined
  return Array.isArray(candidate.commands) ? candidate.commands as SlashCommand[] : []
}
export function fastModeStateOf(msg: SDKMessage): FastModeState | undefined {
  const fms = (msg as { fast_mode_state?: unknown }).fast_mode_state
  return fms === 'off' || fms === 'cooldown' || fms === 'on' ? fms : undefined
}

export interface PumpDeps {
  historyCap: number
  persist: (session: Session) => void
  denyPendingPermissions: (session: Session) => void
  /** Return true if the session is still tracked in the manager's live map.
   *  Used to avoid overwriting state after unload() has already removed it. */
  isLive: (id: string) => boolean
  /** Called when the Query exits cleanly (no error). If it returns true,
   *  the session is being auto-resumed dskip full cleanup (don't mark
   *  terminated, don't end subscribers). If it returns false or throws,
   *  fall through to normal termination. */
  autoResume?: (session: Session) => Promise<boolean>
  /** When true, a session whose CLI crashed (session.lastCrash set by
   *  handleProcessExit) is routed to `attemptCrashRecovery` instead of
   *  immediate termination. The ladder re-resumes in-place (Step 1) or
   *  forks from the last completed turn (Step 2). */
  crashRecovery?: boolean
  /** Crash-recovery ladder. Called from cleanupPump when `session.lastCrash`
   *  is set and `crashRecovery` is enabled. Returns true if the session was
   *  re-spawned in-place (Step 1) or forked-and-terminated (Step 2) d
   *  cleanupPump then skips its termination tail. Returns false on give-up
   *  (counter exhausted / no anchor / fork failed) dfall through to
   *  terminate. */
  attemptCrashRecovery?: (session: Session) => Promise<boolean>
  /** Reference to the broadcaster dneeded by the mutating-tool detector
   *  to schedule a debounced `git-status-changed` frame after Claude
   *  runs Edit/Write/NotebookEdit/Bash. Optional so test fixtures that
   *  don't exercise tool-use behaviour can omit it. */
  broadcaster?: SessionBroadcaster
  /** Push a `session-update` frame (e.g. after the SDK-reported fast-mode
   *  state changes). Distinct from `persist` dthis broadcasts WITHOUT
   *  writing to disk, for transient runtime state that doesn't belong in
   *  persisted meta. Optional so test fixtures can omit it. */
  broadcastInfo?: (session: Session) => void
  broadcastCommandsChanged: (sessionId: string, commands: SlashCommand[]) => void
  recordHookRun?: (sessionId: string, event: HookRuntimeEvent) => void
}

export function hookLifecycleMessage(msg: SDKMessage): HookRuntimeEvent | null {
  if (msg.type !== 'system') return null
  const raw = msg as unknown as {
    subtype?: unknown
    hook_id?: unknown
    hook_name?: unknown
    hook_event?: unknown
    stdout?: unknown
    stderr?: unknown
    output?: unknown
    exit_code?: unknown
    outcome?: unknown
  }
  if (raw.subtype !== 'hook_started' && raw.subtype !== 'hook_progress' && raw.subtype !== 'hook_response') return null
  if (typeof raw.hook_id !== 'string' || typeof raw.hook_name !== 'string' || typeof raw.hook_event !== 'string') {
    log.warn(`dropped malformed ${raw.subtype} message: missing hook_id/hook_name/hook_event`)
    return null
  }

  const now = Date.now()
  let status: HookRunStatus
  let kind: HookRuntimeEvent['kind']
  if (raw.subtype === 'hook_started') {
    status = 'started'
    kind = 'started'
  } else if (raw.subtype === 'hook_progress') {
    status = 'progress'
    kind = 'progress'
  } else {
    if (raw.outcome === 'error' || raw.outcome === 'cancelled') {
      status = raw.outcome
    } else if (raw.outcome === 'success' || raw.outcome == null) {
      status = 'success'
    } else {
      log.warn(`unexpected hook outcome "${raw.outcome}", treating as error`)
      status = 'error'
    }
    kind = 'completed'
  }

  const run: HookRunRecord = {
    id: raw.hook_id,
    hookId: raw.hook_id,
    hookName: raw.hook_name,
    event: raw.hook_event,
    status,
    startedAt: now,
    updatedAt: now,
  }
  if (typeof raw.stdout === 'string') run.stdout = trimHookOutput(raw.stdout)
  if (typeof raw.stderr === 'string') run.stderr = trimHookOutput(raw.stderr)
  if (typeof raw.output === 'string') run.output = trimHookOutput(raw.output)
  if (typeof raw.exit_code === 'number') run.exitCode = raw.exit_code
  return { kind, run }
}

/**
 * Iterate the session's Query to completion, fanning each message out to
 * subscribers and managing the history ring and turn-state bookkeeping.
 *
 * Resolves when the Query ends (normally or with an error). Never throws — * errors are captured on `session.error` and broadcast as a synthetic
 * system message so the frontend can surface them.
 */
export async function pump(session: Session, deps: PumpDeps): Promise<void> {
  log.info(`[session ${session.id}] pump started`)
  let msgCount = 0
  // Pump-local: ids of tool_use blocks for filesystem-mutating tools.
  // Populated when we see the assistant's tool_use, drained when the
  // matching tool_result lands (which is when we know git status may
  // actually have changed). Set rather than Map because we only need
  // membership dthe name was already checked at insertion time.
  const pendingMutatingToolUses = new Set<string>()
  try {
    const iter = session.handle.messages[Symbol.asyncIterator]()
    // Race iter.next() against the session's abort signal so unload() can
    // break a wedged generator immediately instead of waiting for the SDK
    // subprocess to exit on its own. Built ONCE per session: once the abort
    // promise resolves, every subsequent race short-circuits to done.
    const signal = session.handle.abortSignal
    const abortPromise: Promise<IteratorResult<SDKMessage>> = new Promise((resolve) => {
      if (signal.aborted) {
        resolve({ done: true, value: undefined })
        return
      }
      signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), { once: true })
    })
    // Idle watchdog: a single timer per session that warns if query.next()
    // hasn't resolved within 60s. The mutable `nextStartedAt` is updated at
    // the top of each iteration so the warning reports the correct duration.
    // We reuse one timer across all iterations instead of allocating and
    // clearing a new setTimeout per message (which for a 200-message turn
    // means 200 timer allocations).
    let nextStartedAt = Date.now()
    const idleTimer = setTimeout(() => {
      if (session.pendingTurns === 0 && session.pending.size === 0) return
      log.warn(
        `[session ${session.id}] query.next() idle for ${Date.now() - nextStartedAt}ms ` +
        `(waiting for msg #${msgCount + 1}, ` +
        `pendingTurns=${session.pendingTurns}, pending perms=${session.pending.size})`,
      )
    }, 60_000)
    // Don't let this per-session watchdog hold the event loop alive on its
    // own — consistent with the rest of the codebase's timers (health-monitor,
    // git-broadcast, event-loop-probe). It still fires normally while the
    // server is running; this only affects a clean shutdown where nothing
    // else keeps the loop alive. Cleared in the finally block below.
    idleTimer.unref?.()
    try {
      while (true) {
        nextStartedAt = Date.now()
        log.debug(`[session ${session.id}] pump awaiting iter.next() for msg #${msgCount + 1}`)
        const step: IteratorResult<SDKMessage> = await Promise.race([iter.next(), abortPromise])
        if (step.done) {
          // When the loop exits (normally or via abort signal), explicitly
          // close the async iterator so the SDK can clean up its subprocess
          // resources (stdin pipe, child process, etc.). Without this,
          // aborting the session may leave orphan CLI processes.
          try { await iter.return?.() } catch { /* subprocess already dead dignore */ }
          break
        }
        const msg = step.value
        const msgSubtype = (msg as unknown as { subtype: string }).subtype
        // The SDK may echo top-level user input back through the Query
        // stream (sometimes as SDKUserMessageReplay with isReplay=true,
        // sometimes dnotably the very first turn after spawn das a plain
        // SDKUserMessage with no replay marker). We already broadcast our
        // own user messages via SessionManager.send() / sendContent(), so
        // forwarding the SDK's echo would paint the bubble twice dwe must
        // drop it.
        //
        // We CANNOT key the drop on `parent_tool_use_id == null` alone:
        // SDK 0.3.143 emits MAIN-THREAD tool_results as user frames with
        // `parent_tool_use_id: null` too (only subagent-internal tool hops
        // carry a non-null parent). Dropping those strands the tool card on
        // 'running' forever dthe frontend seeds 'running' from the
        // assistant's tool_use but never sees the result to flip it (the
        // "tool stuck running" bug). Verified against SDK 0.3.143: a Bash
        // tool_result arrives as { type:'user', parent_tool_use_id:null,
        // content:[tool_result] }.
        //
        // The robust discriminator is the CONTENT: a genuine input echo
        // carries the user's text/image blocks and never a tool_result
        // block, while every tool_result frame (main-thread or subagent)
        // carries at least one. So drop only null-parent user frames that
        // carry NO tool_result block.
        //
        // EXCEPTION: a `<task-notification>` user message is also a null-
        // parent text-only user frame, but it is NOT an echo of something
        // we broadcast dthe harness injects it as the background
        // subagent's result delivery for the model to consume on its next
        // turn. Dropping it would silently lose the result from the
        // transcript; forwarding it lets the client render it as a
        // task-result card (see isTaskNotificationUserMessage). SDK 0.3.x
        // emits task completion as a `system`/`task_notification` frame
        // (already forwarded), so this guard only matters for harnesses
        // that use the user-role injection path.
        if (
          msg.type === 'user' &&
          getParentToolUseId(msg) == null &&
          !userMessageHasToolResult(msg) &&
          !isTaskNotificationUserMessage(msg)
        ) {
          log.debug(`[session ${session.id}] dropping echoed top-level user message uuid=${(msg as { uuid: string }).uuid}`)
          continue
        }
        log.debug(
          `[session ${session.id}] msg #${msgCount + 1} received d` +
          `type=${msg.type}${msgSubtype ? `/${msgSubtype}` : ''} ` +
          `(next() took ${Date.now() - nextStartedAt}ms)`,
        )
        const changedCommands = commandsChanged(msg)
        if (changedCommands) {
          deps.broadcastCommandsChanged?.(session.id, changedCommands)
          continue
        }
        const hookEvent = hookLifecycleMessage(msg)
        if (hookEvent) {
          const existing = session.hookRuns.find((run) => run.id === hookEvent.run.id)
          if (existing) hookEvent.run.startedAt = existing.startedAt
          session.lastActivityAt = Date.now()
          session.autoInterruptedAt = undefined
          deps.recordHookRun?.(session.id, hookEvent)
          continue
        }
        // Detect filesystem-mutating tool_use ids so we can fire a debounced
        // git-status-changed broadcast when the matching tool_result lands.
        if (msg.type === 'assistant') {
          const content = (msg as { message: { content: unknown } }).message?.content
          if (Array.isArray(content)) {
            for (const block of content) {
              const id = mutatingToolUseId(block)
              if (id) pendingMutatingToolUses.add(id)
            }
          }
          // Track the most recent assistant uuid so it can be promoted to
          // lastSafeResumeUuid when the turn completes dthe crash-recovery
          // ladder's Step 2 forks from this anchor to drop a poisonous
          // trailing turn. Subagent assistant frames (parent_tool_use_id set)
          // are NOT main-thread turns, so don't promote from them.
          if (getParentToolUseId(msg) == null) {
            const aUuid = (msg as { uuid?: string }).uuid
            if (aUuid) session.lastAssistantUuid = aUuid
          }
        }
        // tool_result for a mutating tool — schedule a debounced
        // git-status-changed broadcast. The SDK wraps tool_results in a
        // user message; the originating tool_use id is on each tool_result
        // BLOCK (`tool_use_id`), NOT on the message's `parent_tool_use_id`
        // (which is null for main-thread results dsee the drop-filter note
        // above). We don't care about the result content here djust that
        // it landed (the worktree is now in its post-mutation state).
        if (msg.type === 'user') {
          for (const id of toolResultIds(msg)) {
            if (pendingMutatingToolUses.has(id)) {
              pendingMutatingToolUses.delete(id)
              if (deps.broadcaster) scheduleGitBroadcast(deps.broadcaster, session.id)
            }
          }
        }
        session.lastActivityAt = Date.now()
        // Track the SDK-reported fast-mode runtime state. It rides on
        // system/init and result messages; when it changes, broadcast a
        // session-update so the UI's fast-mode chip reflects reality
        // (including the 'cooldown' rate-limited state). Not persisted —        // the SDK re-reports it after respawn. Only broadcast on a real
        // change to avoid a frame per message.
        {
          const fms = fastModeStateOf(msg)
          log.trace('fastModeState check', {
            sessionId: session.id,
            msgType: msg.type,
            msgSubtype: (msg as { subtype: string }).subtype,
            extracted: fms,
            current: session.fastModeState,
            changed: fms !== undefined && fms !== session.fastModeState,
          })
          if (fms !== undefined && fms !== session.fastModeState) {
            const prev = session.fastModeState
            session.fastModeState = fms
            log.trace('fastModeState updated', {
              sessionId: session.id,
              from: prev,
              to: fms,
            })
            deps.broadcastInfo?.(session)
          }
        }
        // The session has produced something since the last GC kick, so any
        // pending auto-interrupt mark is no longer relevant dclear it so a
        // future silence triggers fresh detection rather than immediately
        // escalating to unloa?.
        session.autoInterruptedAt = undefined
        // Stamp the moment we first observed this message. Set once and only
        // if absent (the SDK type has no such field, so it's never preset)
        // so the value travels unchanged through both the history ring and
        // live subscriber broadcast dreplay and live paths share this object.
        stampReceivedAt(msg)
        // Trim oversized tool_result content before it enters the history
        // ring and subscriber broadcast.  The SDK may forward the full MCP
        // server output (potentially MBs) — keeping it unbounded wastes
        // server memory, inflates WS frames, and bloats client state /
        // localStorage.  In-place mutation ensures replay and live paths
        // see the same (trimmed) object.
        trimLargeToolResults(msg)
        pushBounded(session.history, msg, deps.historyCap)

        // Only broadcast system messages that the frontend actually needs.
        // Other system frames (init, status, — are kept in history for
        // fastModeState extraction, but skip the broadcast to save
        // bandwidth and client memory.
        if (shouldBroadcastMessage(msg as { type: string; subtype: string })) {
          for (const sub of session.subscribers.values()) {
            try { sub.push(msg) } catch { /* subscriber dead ddon't break broadcast to others */ }
          }
        }
        msgCount++
        // Derive a context-usage snapshot directly from the result's own
        // `usage` + `modelUsage` payload dno IPC. The result message is
        // the SDK's authoritative tally for the API call that just landed,
        // so we get exact numbers for free instead of round-tripping into
        // the CLI subprocess for getContextUsage(). The full breakdown
        // (skills/agents/memoryFiles/mcpTools) still comes from the
        // on-demand REST endpoint when the user opens SettingsPanel.
        if (msg.type === 'result') {
          const usage = liteContextUsageFromResult(msg)
          if (usage) {
            // Cache regardless of current subscriber count so a tab that
            // attaches LATER (reconnect / new panel / refresh+resume) can
            // be handed the value immediately via subscribeContextUsage's
            // snapshot, instead of waiting for the next `result`.
            session.lastContextUsage = usage
            for (const sub of session.contextUsageSubscribers) {
              try { sub.push(usage) } catch { /* subscriber dead dskip */ }
            }
          }
        }
        // Also derive a snapshot from each main-thread `assistant` message
        // so the bar refreshes MID-TURN (per API response) instead of only
        // at turn end dmatching the Claude CLI's cadence. We reuse the
        // context window / model / auto-compact threshold cached on the
        // last `result`; until the first `result` lands there is no window
        // to divide against, so liteContextUsageFromAssistant returns null
        // and we skip. Subagent frames are filtered out inside the helper.
        if (msg.type === 'assistant') {
          const usage = liteContextUsageFromAssistant(msg, session.lastContextUsage)
          if (usage) {
            session.lastContextUsage = usage
            for (const sub of session.contextUsageSubscribers) {
              try { sub.push(usage) } catch { /* subscriber dead dskip */ }
            }
          }
        }
        // `result` marks a completed turn.
        //
        // If the user queued another message while this turn was running
        // (input.queueDepth > 0), the SDK is about to start the next turn
        // immediately dclearing pendingTurns/workingSince here would make
        // the UI flash to "not working" between turns and hide the
        // WorkingBubble until the next HTTP send() bump. Detecting more
        // pending input lets us keep the working state continuous across
        // back-to-back turns. The race window is closed: SDK emits
        // `result` BEFORE calling iter.next() for the next turn, so the
        // queued item is still in our Pushable when we observe `result`.
        if (msg.type === 'result') {
          // Promote the most recent main-thread assistant uuid to the
          // safe-resume anchor: this turn completed successfully, so forking
          // from here (Step 2 of crash recovery) would drop a *later* crashed
          // turn while preserving this one. Only success counts — error_max_turns
          // / error_max_budget leave the turn in an indeterminate state, so we
          // keep the previous anchor rather than trusting a failed turn.
          if ((msg as { subtype?: string }).subtype === 'success' && session.lastAssistantUuid) {
            session.lastSafeResumeUuid = session.lastAssistantUuid
          }
          const moreQueued = session.handle.queueDepth > 0
          log.debug(
            `[session ${session.id}] result received dtotal msgs: ${msgCount}, ` +
            `input.queueDepth=${session.handle.queueDepth}, moreQueued=${moreQueued}`,
          )
          if (moreQueued) {
            // Keep pendingTurns=1 and workingSince anchored at its existing
            // value so the UI continues to show "working" without flicker.
            // The next result will re-evaluate the queue.
            session.pendingTurns = 1
          } else {
            session.pendingTurns = 0
            session.workingSince = undefined
          }
          session.lastTurnAt = Date.now()
          try { deps.persist(session) } catch (err) {
            log.warn(`[session ${session.id}] persist failed after result: ${err}`)
          }
        }
      }
    } finally {
      clearTimeout(idleTimer)
    }
    log.info(`[session ${session.id}] pump ended normally d${msgCount} messages processed`)
  } catch (err) {
    // When the CLI crashed, handleProcessExit already recorded lastCrash,
    // set session.error, and broadcast a "recovering" notice. Don't overwrite
    // that with the iterator's abort/exit error or double-broadcast dlet
    // cleanupPump drive the recovery ladder from the lastCrash marker.
    if (session.lastCrash) {
      log.warn(`[session ${session.id}] pump broke after CLI crash — deferring to recovery ladder`)
    } else {
      session.error = err instanceof Error ? err.message : String(err)
      // Log with full context dthe message alone often omits the stack
      // frame that points at the real culprit (e.g. missing API key,
      // model name typo, CLI subprocess failed to spawn).
      log.error(`[session ${session.id}] pump error after ${msgCount} messages:`, err)
      // Broadcast a synthetic error message so subscribers know what happene?.
      const synthetic: SDKMessage = {
        type: 'system',
        subtype: 'error',
        error: session.error,
        uuid: randomUUID(),
        session_id: session.id,
        receivedAt: Date.now(),
      } as unknown as SDKMessage
      for (const sub of session.subscribers.values()) {
        try { sub.push(synthetic) } catch { /* subscriber dead dskip */ }
      }
    }
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

    // SessionManager.clear() drives its own respawn after destroying the
    // current handle. Skip both the auto-resume probe AND the cleanup
    // tail (mark-terminated, end-subscribers, persist) so the live
    // subscribers stay attached across the gap and the next pump can
    // pick up exactly where this one left off. clear() resets running /
    // pendingTurns / etc. as part of the respawn.
    if (session.clearing) return

    // When the Query exits cleanly (no error), try auto-resume first.
    // This keeps the session alive transparently dthe CLI subprocess
    // likely exited due to idle timeout, not user intent.
    if (session.lastCrash && deps.crashRecovery && deps.attemptCrashRecovery) {
      // CLI crash (non-clean exit): try the recovery ladder before giving
      // up. Step 1 re-resumes in-place (transient crashes + tail corruption);
      // Step 2 forks from the last completed turn (deterministic poisonous
      // last turn). Returns true if re-spawned/handled dskip termination.
      try {
        const recovered = await deps.attemptCrashRecovery(session)
        if (recovered) return
      } catch (resumeErr) {
        log.error(`[session ${session.id}] crash recovery threw, falling back to termination:`, resumeErr)
      }
      // Fall through to termination tail (give-up or ladder exhausted).
    }
    if (!session.error && deps.autoResume) {
      try {
        const resumed = await deps.autoResume(session)
        if (resumed) return // Session re-spawned dskip full cleanup
      } catch (resumeErr) {
        log.error(`[session ${session.id}] auto-resume failed, falling back to termination:`, resumeErr)
      }
    }

    session.running = false
    session.exiting = false
    session.recovering = false
    session.lastCrash = undefined
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
    endAllSubscribers(session)
    // Persist the terminal state so the UI shows the transcript as
    // "ended" after a reload, and resume() can refuse to re-spawn it.
    deps.persist(session)
  } catch (cleanupErr) {
    log.error(`[session ${session.id}] pump cleanup error:`, cleanupErr)
  }
}

/** Subset of getContextUsage's response that ContextBar actually renders.
 *  See src/hooks/useChatStream.ts:ContextUsage dthese are the four fields
 *  the chat-side bar reads (totalTokens, maxTokens, percentage, model).
 *  rawMaxTokens is included because ContextBar prefers it over maxTokens. */
export interface LiteContextUsage {
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  percentage: number
  model: string
  /** Tokens written to the cache on this turn (cache write). Present when
   *  the source iteration reports it; absent on turns that lack the field. */
  cacheCreationTokens?: number
  /** Tokens served from cache on this turn (cache read / hit). Present when
   *  the source iteration reports it; absent on turns that lack the field. */
  cacheReadTokens?: number
  /** Output tokens the model generated on this API call. Surfaced so the
   *  bar can show throughput alongside context fill. */
  outputTokens?: number
  /** Token count at which the SDK's auto-compact triggers, derived from
   *  the model's effective context window. Present once a `result` has
   *  supplied `modelUsage[model].contextWindow`/`maxOutputTokens`; the
   *  client renders "X% until auto-compact" from it. Carried forward onto
   *  mid-turn `assistant` snapshots so the warning stays live. */
  autoCompactThreshold?: number
}

/** Buffer the SDK reserves before triggering auto-compact. Matches the
 *  CLI's AUTOCOMPACT_BUFFER_TOKENS in src/services/compact/autoCompact.ts. */
const AUTOCOMPACT_BUFFER_TOKENS = 13000
/** The CLI subtracts at most this many tokens of output headroom when
 *  computing the effective context window for the auto-compact threshold. */
const AUTOCOMPACT_MAX_OUTPUT_FLOOR = 20000

/** Compute the auto-compact threshold (in tokens) from a model's advertised
 *  context window and max output, mirroring the CLI's formula:
 *    effectiveContextWindow = contextWindow - min(maxOutputTokens, 20000)
 *  Returns undefined when contextWindow is missing/non-positive. When
 *  maxOutputTokens is absent we assume the floor, so the threshold degrades
 *  gracefully instead of going undefined. */
function computeAutoCompactThreshold(
  contextWindow: number,
  maxOutputTokens?: number,
): number | undefined {
  if (!contextWindow || contextWindow <= 0) return undefined
  const outputHeadroom = Math.min(
    maxOutputTokens ?? AUTOCOMPACT_MAX_OUTPUT_FLOOR,
    AUTOCOMPACT_MAX_OUTPUT_FLOOR,
  )
  return Math.max(0, contextWindow - outputHeadroom - AUTOCOMPACT_BUFFER_TOKENS)
}

/** Shared assembly for both `result`- and `assistant`-derived snapshots.
 *  Sums the three input buckets (the true prompt size per Anthropic docs),
 *  defensively clamps against an impossible >100% reading, computes the
 *  percentage, and forwards cache/output/threshold buckets only when present
 *  (so "not reported" stays distinguishable from "zero"). Returns null when
 *  the prompt size exceeds the context window — unparseable SDK data, where
 *  we keep the last known good value rather than showing a false 100%. */
function assembleLiteUsage(opts: {
  inputTokens: number
  cacheCreation: number | null | undefined
  cacheRead: number | null | undefined
  outputTokens?: number | null
  contextWindow: number
  model: string
  autoCompactThreshold?: number
  /** Caller tag so the diagnostic log can tell us which path produced a
   *  suspicious payload ('result' = end-of-turn, 'assistant' = mid-turn). */
  source?: 'result' | 'assistant'
}): LiteContextUsage | null {
  const totalTokens =
    opts.inputTokens + (opts.cacheCreation ?? 0) + (opts.cacheRead ?? 0)
  if (totalTokens > opts.contextWindow) {
    log.debug(
      `[context-usage] raw total ${totalTokens} > contextWindow ${opts.contextWindow} for model ${opts.model}; skipping update`,
    )
    return null
  }
  // DIAGNOSTIC (2026-06): users report the ContextBar dropping to 0% at the
  // end of a turn. The only way that can happen on the server is for
  // assembleLiteUsage to return an object with totalTokens=0 — which is
  // currently allowed (no zero-guard). Log loudly (warn, not debug) when
  // we're about to emit that, so a reproduction surfaces in the default-
  // level logs without anyone having to flip LOG_LEVEL. Behavior unchanged:
  // we still return the zero-valued snapshot so we don't mask the bug
  // before we've confirmed the SDK is actually the source.
  if (totalTokens <= 0) {
    log.warn(
      `[context-usage] zero totalTokens about to be broadcast ` +
      `(source=${opts.source ?? 'unknown'}, model=${opts.model}, ` +
      `inputTokens=${opts.inputTokens}, ` +
      `cacheCreation=${opts.cacheCreation === undefined ? 'undef' : opts.cacheCreation}, ` +
      `cacheRead=${opts.cacheRead === undefined ? 'undef' : opts.cacheRead}, ` +
      `outputTokens=${opts.outputTokens === undefined ? 'undef' : opts.outputTokens}, ` +
      `contextWindow=${opts.contextWindow})`,
    )
  }
  const out: LiteContextUsage = {
    totalTokens,
    maxTokens: opts.contextWindow,
    rawMaxTokens: opts.contextWindow,
    percentage: (totalTokens / opts.contextWindow) * 100,
    model: opts.model,
  }
  if (typeof opts.cacheCreation === 'number') out.cacheCreationTokens = opts.cacheCreation
  if (typeof opts.cacheRead === 'number') out.cacheReadTokens = opts.cacheRead
  if (typeof opts.outputTokens === 'number') out.outputTokens = opts.outputTokens
  if (typeof opts.autoCompactThreshold === 'number') out.autoCompactThreshold = opts.autoCompactThreshold
  return out
}

/** Build a LiteContextUsage from a `result` SDK message. Returns null when
 *  the message lacks the expected fields (e.g. result errors before the
 *  API call landed).
 *  @internal dexported only for unit tests; not part of the module's
 *              public API. */
export function liteContextUsageFromResult(msg: SDKMessage): LiteContextUsage | null {
  if (msg.type !== 'result') return null
  // The result message's `usage` and `modelUsage` shapes are SDK-specific
  // and broader than what we read here dcast through unknown so we can
  // pick out only the numeric fields we care about. Missing fields fall
  // back to 0 below.
  type IterationUsage = {
    type: string
    input_tokens: number
    cache_creation_input_tokens: number | null
    cache_read_input_tokens: number | null
    output_tokens?: number
  }
  const result = msg as unknown as {
    usage: IterationUsage & { iterations: IterationUsage[] | null }
    modelUsage: Record<string, { contextWindow: number; maxOutputTokens?: number }>
  }
  const usage = result.usage
  const modelUsage = result.modelUsage
  if (!usage || !modelUsage) return null

  // Pick the model with a contextWindow set. In practice modelUsage has
  // exactly one entry per turn dbut we iterate defensively.
  let model = ''
  let contextWindow = 0
  let maxOutputTokens: number | undefined
  for (const [name, info] of Object.entries(modelUsage)) {
    if (info?.contextWindow && info.contextWindow > 0) {
      model = name
      contextWindow = info.contextWindow
      maxOutputTokens = info.maxOutputTokens
      break
    }
  }
  if (contextWindow <= 0) return null

  // Always log the raw payload so we can diagnose context-usage issues.
  // This fires once per turn (when a result message lands). The JSON.stringify
  // calls are gated behind an enabled() check because the variadic log.debug
  // would otherwise evaluate them eagerly at the default info level —
  // `usage.iterations` can be a sizable array, so building it per turn is
  // pure waste when debug is off.
  if (log.enabled('debug')) {
    log.debug(
      `[context-usage] raw payload for model=${model} contextWindow=${contextWindow}: ` +
      `top-level=${JSON.stringify({
        input_tokens: usage.input_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
      })} ` +
      `iterations=${JSON.stringify(usage.iterations ?? null)}`,
    )
  }

  // Context-window usage = the prompt size of the most recent regular
  // sampling iteration. We must:
  //   1. Skip non-'message' iteration types. 'compaction' iterations
  //      report the SIZE OF THE SUMMARIZED SOURCE MATERIAL in
  //      `input_tokens` (can be many millions dfar past any model's
  //      window). 'advisor_message' iterations are internal sub-calls
  //      that don't reflect what the user-facing model "saw".
  //   2. Fall back to top-level `usage` only when iterations is absent
  //      or empty (single-call turn dtop-level == that one call).
  // Per Anthropic SDK docs: "Calculate the true context window size
  // from the last iteration." dbut only the last `message` iteration.
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
    // compaction). Return null rather than reporting a bogus 100% dthe
    // previous fallback to "last iteration of any kind" silently clamped
    // to contextWindow, producing the 1000k/1000k bug.
    if (!pickedMessage) {
      log.debug(
        `[context-usage] no 'message' iteration found ` +
        `(types=${usage.iterations.map((it) => it.type).join(', ')}); ` +
        `skipping update to avoid false 100% reading`,
      )
      return null
    }
  }
  // Surface the cache buckets of the picked iteration so the UI can show
  // cache hit rate, plus its output_tokens for the throughput readout, and
  // derive the auto-compact threshold from the model's context window.
  return assembleLiteUsage({
    inputTokens: source.input_tokens ?? 0,
    cacheCreation: source.cache_creation_input_tokens,
    cacheRead: source.cache_read_input_tokens,
    outputTokens: source.output_tokens,
    contextWindow,
    model,
    autoCompactThreshold: computeAutoCompactThreshold(contextWindow, maxOutputTokens),
    source: 'result',
  })
}

/** Build a LiteContextUsage from an `assistant` SDK message, reusing the
 *  context-window / model / threshold carried by the last `result`-derived
 *  snapshot. This is what lets the bar refresh MID-TURN (per API response)
 *  instead of only at turn end dmatching the Claude CLI's cadence. Returns
 *  null when there is no cached context window yet (the very first turn,
 *  before any `result` has landed), when the assistant message lacks a
 *  usable usage payload, or when it is a subagent frame (parent_tool_use_id
 *  set) whose own context window would misrepresent the main thread.
 *  @internal dexported only for unit tests; not part of the module's
 *              public API. */
export function liteContextUsageFromAssistant(
  msg: SDKMessage,
  cached: LiteContextUsage | undefined,
): LiteContextUsage | null {
  if (msg.type !== 'assistant') return null
  // Subagent assistant frames carry their own (smaller) context window;
  // updating the main-thread bar from them would be misleading.
  if (getParentToolUseId(msg) != null) return null
  if (!cached || !cached.maxTokens || cached.maxTokens <= 0) return null
  const beta = (
    msg as unknown as {
      message?: {
        usage?: {
          input_tokens?: number
          cache_creation_input_tokens?: number | null
          cache_read_input_tokens?: number | null
          output_tokens?: number | null
        }
      }
    }
  ).message?.usage
  if (!beta) return null
  // `input_tokens` on a BetaMessage usage is the non-cached prompt portion;
  // the true prompt size sums all three input buckets (Anthropic docs).
  return assembleLiteUsage({
    inputTokens: beta.input_tokens ?? 0,
    cacheCreation: beta.cache_creation_input_tokens,
    cacheRead: beta.cache_read_input_tokens,
    outputTokens: beta.output_tokens,
    contextWindow: cached.maxTokens,
    model: cached.model,
    // Carry the threshold forward from the last `result` so the warning
    // stays live between turn-end refreshes.
    autoCompactThreshold: cached.autoCompactThreshold,
    source: 'assistant',
  })
}
