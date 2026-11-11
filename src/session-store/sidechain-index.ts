/** Sidechain index owner: Subagent / Workflow / Skill fold pipeline, the
 *  TASKS_SNAPSHOT enrichment, the DISMISS_SUBAGENT flip, and reapplyDismissed
 *  re-application after mirror rebuilds.
 *
 *  The mirror fields this module owns (per the reducer-state-owners design):
 *  `activeSubagents`, `activeWorkflows`, `activeSkills` — the three sidechain
 *  lifecycle maps — plus `tasks` (the TASKS_SNAPSHOT whole-array replacement).
 *  The `dismissedSubagents` intent set is co-owned: DISMISS_SUBAGENT writes it,
 *  reapplyDismissed prunes it, and CLEAR_TRANSCRIPT wipes it (in the reducer).
 *
 *  `updateSidechainIndexMirror` is a pure `mirror → mirror` transform extracted
 *  from the reducer's `updateIndexesMirror`. It handles ONLY the sidechain
 *  branches (subagent / workflow / skill seed / result / child folds); the
 *  generic tool / plan / question branches and the order-insensitivity parking
 *  remain in the reducer's `updateIndexesMirror`, which calls this function
 *  after the non-sidechain work and before the parking.
 *
 *  `applyTasksSnapshot` is also a pure `mirror → mirror` transform (the
 *  TASKS_SNAPSHOT case body, lifted off `state`). `dismissSubagent` and
 *  `reapplyDismissed` operate on the full `SessionState` because they touch
 *  both `mirror.activeSubagents` and `intent.dismissedSubagents`. */

import { isTerminalTaskStatus } from '../../shared/tasks.js'
import type { SdkMessage, TaskRecordUi } from '../types'
import {
  type ActiveSubagent,
  type ServerMirror,
  type SessionState,
  type SubagentChildCall,
  type SubagentChildStatus,
  type WorkflowStatus,
  withIntent,
  withMirror,
} from './types'
import {
  getSkillStarts,
  getSubagentChildStarts,
  getSubagentStarts,
  getToolResultEntries,
  getWorkflowChildStarts,
  getWorkflowStarts,
  parseTaskNotification,
} from './normalize'
import { resultContentToText } from './live-turn'
import { parseWorkflowOutput } from './workflow-meta'

// ── sweepRunningChildCalls ────────────────────────────────────────────────
// Moved here from the reducer: it sweeps still-running rows of a
// SubagentChildCall list to `error`, returning the SAME array reference when
// nothing needed sweeping (so the caller's identity checks stay meaningful).
// Shared by the subagent sweep (reducer), the skill tool_result settle branch
// (this module), and sweepAtTurnEnd (reducer). Exported so the reducer can
// import it.

/** Flip every still-`running` row of a SubagentChildCall list to `error`,
 *  returning the SAME array reference when nothing needed sweeping (so the
 *  caller's identity checks stay meaningful). Shared by the subagent sweep and
 *  the skill sweep — both hold the same row type with the same lifecycle. */
export function sweepRunningChildCalls(
  calls: SubagentChildCall[] | undefined,
): SubagentChildCall[] | undefined {
  if (!calls || !calls.some((c) => c.status === 'running')) return calls
  return calls.map((c) =>
    c.status === 'running'
      ? { ...c, status: 'error' as const, endedAt: c.endedAt ?? c.startedAt }
      : c,
  )
}

// ── updateSidechainIndexMirror ────────────────────────────────────────────
// The Subagent / Workflow / Skill fold pipeline extracted from the reducer's
// `updateIndexesMirror`. Handles ONLY the sidechain branches; the generic
// tool / plan / question branches and the order-insensitivity parking stay in
// the reducer. The reducer calls this after the non-sidechain work and before
// the parking, so the parking sees the updated sidechain maps.
//
// Identity-stable: returns the original mirror when nothing touched the three
// sidechain maps (the common case — most frames carry no sidechain blocks).

function comparableResultText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: 'text'; text: string } =>
      b != null && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string',
    )
    .map((b) => b.text)
    .join('\n\n')
    .trim()
}

function isTextOnlyResult(content: unknown): boolean {
  if (typeof content === 'string') return true
  return Array.isArray(content) && content.every((b) =>
    b != null && typeof b === 'object' && (b as { type?: unknown }).type === 'text',
  )
}

function shouldWriteTerminalResult(
  record: ActiveSubagent,
  status: string,
  text: string,
  fullResult: boolean,
): boolean {
  if (!text.trim()) return false
  const existing = record.result
  if (status === 'stopped' && record.status === 'done' && existing && !existing.isError &&
    (record.resultOrigin === 'notification' || record.resultOrigin === 'tool_result' || record.resultOrigin === 'streamed')) {
    return false
  }
  if (record.resultOrigin === 'streamed') {
    if (comparableResultText(existing?.content) === text.trim()) return false
    if (!fullResult) return false
  }
  if (record.resultOrigin === 'notification' && existing && !existing.isError &&
    comparableResultText(existing.content) === text.trim()) return false
  if (record.resultOrigin === 'notification' && !fullResult && existing &&
    !(status === 'completed' && existing.isError)) return false
  if (record.resultOrigin === 'tool_result') {
    if (!existing?.isError && comparableResultText(existing?.content) === text.trim()) return false
    if (!fullResult && !(status === 'completed' && existing?.isError)) return false
  }
  if (existing?.isError && status !== 'completed') return false
  return fullResult || !existing || record.status === 'done' ||
    (record.status === 'interrupted' && status === 'completed')
}

export function consumesSubagentRootResult(record: ActiveSubagent): boolean {
  return record.result != null || record.resultOrigin === 'async_metadata' ||
    record.status === 'background' || record.status === 'pending'
}

export function updateSidechainIndexMirror(mirror: ServerMirror, message: SdkMessage): ServerMirror {
  let changed = false
  let activeSubagents = mirror.activeSubagents
  let activeWorkflows = mirror.activeWorkflows
  let activeSkills = mirror.activeSkills

  // ── Subagent index ───────────────────────────────────────────────────
  const starts = getSubagentStarts(message)
  if (starts.length > 0) {
    activeSubagents = new Map(activeSubagents)
    // Stamp `startedAt` once per subagent so the row can show an
    // elapsed time. Preserve any existing value if we re-encounter the
    // same toolUseId (e.g. duplicate dispatch during replay).
    //
    // Prefer the server-stamped `message.receivedAt` — it travels with the
    // SDK frame across replays, so a page refresh that rebuilds indexes
    // from cached messages recovers the original wall-clock start. Without
    // this fallback, the elapsed timer resets to 0 on every reload.
    const stamp = typeof message.receivedAt === 'number' ? message.receivedAt : Date.now()
    for (const subagent of starts) {
      const existing = activeSubagents.get(subagent.toolUseId)
      activeSubagents.set(subagent.toolUseId, {
        ...subagent,
        startedAt: existing?.startedAt ?? subagent.startedAt ?? stamp,
        endedAt: existing?.endedAt,
        status: existing?.status ?? 'running',
        toolCount: existing?.toolCount ?? 0,
        // TASKS_SNAPSHOT is the sole isAsync authority, so preserve any
        // existing value across replay re-encounters.
        isAsync: existing?.isAsync ?? subagent.isAsync,
        result: existing?.result,
        resultOrigin: existing?.resultOrigin,
        childToolCalls: existing?.childToolCalls ?? subagent.childToolCalls,
        taskId: existing?.taskId,
        progressSummary: existing?.progressSummary,
        lastToolName: existing?.lastToolName,
      })
    }
    changed = true
  }

  const subagentResultEntries = getToolResultEntries(message)
  if (subagentResultEntries.length > 0 && activeSubagents.size > 0) {
    // Don't delete on tool_result — keep the record around so the
    // overlay can be reopened after completion. Flip status to 'done'
    // ('interrupted' when the result carries is_error, so a failed
    // subagent doesn't show a green check) and stamp endedAt. Capture the
    // result for the detail view's terminal row and for MessageList's
    // standalone-result suppression. The "running"/"background" filter
    // elsewhere drops completed subagents from the WorkingBubble's pill.
    //
    // EXCEPTION — async/background launch ack: an async subagent's Agent
    // tool_result is a launch acknowledgement, not completion. Skip it
    // entirely (record stays 'running'); TASKS_SNAPSHOT flips it to
    // 'background', task-notification finishes the lifecycle.
    //
    // Most turns include tool_results unrelated to subagents, so defer
    // the Map clone until we actually have a matching id — otherwise
    // every Bash/Read/Edit hop allocates a fresh Map for nothing.
    let touched = false
    // Prefer the server-stamped wall-clock time so a page refresh that
    // re-reduces cached messages recovers the original completion time
    // (otherwise endedAt jumps forward to "now" on reload, blowing up the
    // displayed elapsed range for completed subagents).
    const stamp = typeof message.receivedAt === 'number' ? message.receivedAt : Date.now()
    for (const { toolUseId, content, isError } of subagentResultEntries) {
      const existing = activeSubagents.get(toolUseId)
      // Async launch/detach metadata guard: an ack tool_result is NOT real
      // output. Once TASKS_SNAPSHOT marks the record background/async, its
      // originating tool_result is detach metadata regardless of its text;
      // task_notification remains the sole authority for completion.
      const ackText = typeof content === 'string' ? content : resultContentToText(content)
      const isAck = !isError && typeof ackText === 'string' &&
        /^async agent launched successfully/i.test(ackText)
      const isDetachAck = !isError && typeof ackText === 'string' && /^subagent moved to background/i.test(ackText)
      if (existing?.status === 'dismissed') {
        if ((isAck || isDetachAck) && existing.resultOrigin == null) {
          if (!touched) {
            if (activeSubagents === mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
            touched = true
          }
          activeSubagents.set(toolUseId, { ...existing, resultOrigin: 'async_metadata' })
        }
        continue
      }
      const canMergeResult = existing && (existing.status === 'running' || existing.status === 'background' || existing.status === 'pending' ||
        ((existing.status === 'done' || existing.status === 'interrupted') &&
          (existing.resultOrigin == null || existing.resultOrigin === 'notification' || existing.resultOrigin === 'summary' || existing.resultOrigin === 'async_metadata' || existing.resultOrigin === 'streamed')))
      if (!canMergeResult) continue
      if ((existing.status === 'done' || existing.status === 'interrupted') && !existing.endedAtEstimated && existing.endedAt != null && typeof message.receivedAt === 'number' && message.receivedAt < existing.endedAt) continue
      if (isAck || (existing.status === 'background' && existing.isAsync === true) ||
        (isDetachAck && (existing.result || existing.status === 'pending'))) {
        if (!existing.result && existing.resultOrigin == null) {
          if (!touched) {
            if (activeSubagents === mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
            touched = true
          }
          activeSubagents.set(toolUseId, { ...existing, resultOrigin: 'async_metadata' })
        }
        continue
      }
      if (!touched) {
        if (activeSubagents === mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
        touched = true
      }
      const streamedTextMatches = existing.resultOrigin === 'streamed' && !isError &&
        comparableResultText(existing.result?.content) === comparableResultText(content)
      const preserveStreamed = streamedTextMatches && isTextOnlyResult(content)
      activeSubagents.set(toolUseId, {
        ...existing,
        status: isError ? 'interrupted' : 'done',
        endedAt: stamp,
        endedAtEstimated: typeof message.receivedAt !== 'number',
        result: preserveStreamed ? existing.result : { content, isError },
        resultOrigin: preserveStreamed ? 'streamed' : (isDetachAck ? 'async_metadata' : 'tool_result'),
      })
    }
    changed = changed || touched
  }

  // Extend a subagent's endedAt to the latest child frame's receivedAt.
  //
  // For an async/background subagent the Agent tool_result is just a launch
  // ack ("Async agent launched successfully … agentId") that arrives within
  // ms of the tool_use — well before the subagent's real work streams as
  // child frames (parent_tool_use_id === subagent id). TASKS_SNAPSHOT flips
  // the record to 'background' and sets isAsync (the sole authority), but
  // does NOT set endedAt (the ack time isn't the real run time). Without
  // this extension the card shows no elapsed at all until completion. Keep
  // advancing endedAt to each child frame so the card/overlay timer reflects
  // real work. The subagent emits no dedicated end frame of its own, so the
  // last child frame before the <task-notification> is the de-facto completion
  // signal. For a synchronous subagent the tool_result already lands last, so
  // this is a no-op (stamp <= existing.endedAt). Fires for any child frame
  // (assistant text, tool_use, internal tool_result) — the latest wins.
  //
  // isAsync is NOT touched here — TASKS_SNAPSHOT is the sole authority for
  // that field. Child frames only advance timing and capture tool counts /
  // result text (handled separately below).
  if (activeSubagents.size > 0) {
    const parentId = typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : ''
    if (parentId) {
      const existing = activeSubagents.get(parentId)
      // Only advance endedAt for LIVE records (running/background/pending).
      // A dismissed/interrupted/done/rejected record is settled — a late
      // child frame (an async subagent still streaming after the user
      // dismissed it or after completion) must NOT advance its endedAt, or
      // the card's frozen elapsed display would jump forward.
      if (existing && (existing.status === 'running' || existing.status === 'background' || existing.status === 'pending')) {
        const stamp = typeof message.receivedAt === 'number' ? message.receivedAt : Date.now()
        if (existing.endedAt == null || stamp > existing.endedAt) {
          if (activeSubagents === mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
          activeSubagents.set(parentId, {
            ...existing,
            endedAt: stamp,
            endedAtEstimated: typeof message.receivedAt !== 'number',
          })
          changed = true
        }
      }
    }
  }

  // Count tool_use blocks in assistant messages that belong to a subagent
  // (identified by parent_tool_use_id). This pre-computes the value that
  // SubagentCard previously scanned the full message list to compute.
  //
  // Also capture the subagent's own text output into `result`. For an
  // async/background subagent the Agent tool_result is just a launch ack
  // (internal metadata — "Async agent launched successfully … agentId"),
  // not the real output; the real output streams as text blocks in these
  // child assistant frames. The last text-bearing child frame is the latest
  // streamed output candidate; a different full notification or terminal
  // snapshot can still replace earlier progress with the final answer. A
  // synchronous main-thread tool_result retains its final write.
  if (message.type === 'assistant' && activeSubagents.size > 0) {
    const parentId = message.parent_tool_use_id
    if (typeof parentId === 'string') {
      const existing = activeSubagents.get(parentId)
      // Live frames update the full record. Once a notification supplied the
      // result, a late sidechain text frame may still supersede it: original
      // conversation output outranks a repackaged notification or detach ack
      // and prevents the detail view from rendering both copies. Other settled
      // fields stay frozen.
      const isLive = existing?.status === 'running' || existing?.status === 'background' || existing?.status === 'pending'
      const hasRepackagedResult = existing?.resultOrigin === 'notification' || existing?.resultOrigin === 'summary'
      const canSupersedeResult = hasRepackagedResult || existing?.resultOrigin === 'async_metadata' ||
        (existing?.isAsync === true && existing.status === 'done' && existing.resultOrigin == null)
      if (existing && (isLive || canSupersedeResult)) {
        const content = message.message?.content
        const textBlocks: Array<{ type: 'text'; text: string }> = typeof content === 'string' && content.trim().length > 0
          ? [{ type: 'text', text: content }]
          : []
        for (const b of (Array.isArray(content) ? content : []) as Array<{ type?: string; text?: unknown }>) {
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
            textBlocks.push({ type: 'text', text: b.text })
          }
        }
          // Fold new child tool_use ids into childToolCalls. Both the row list
          // and the header count use only newly-seen ids, so replaying a frame
          // cannot inflate either one.
          const childStarts = getSubagentChildStarts(message)
          const prevChildCalls = existing.childToolCalls ?? []
          let nextChildCalls = prevChildCalls
          let addedCount = 0
          if (childStarts.children.length > 0) {
            const byId = new Map(prevChildCalls.map((c) => [c.toolUseId, c]))
            const stamp = typeof message.receivedAt === 'number' ? message.receivedAt : Date.now()
            for (const child of childStarts.children) {
              if (byId.has(child.toolUseId)) continue // preserve existing row (status/result)
              byId.set(child.toolUseId, { ...child, startedAt: stamp })
              addedCount++
            }
            if (addedCount > 0) nextChildCalls = Array.from(byId.values())
          }
          const childCallsChanged = isLive && addedCount > 0
          const childText = textBlocks.map((b) => b.text).join('\n\n').trim()
          const notificationIsNewer = typeof message.receivedAt === 'number' &&
            (existing.endedAt == null || message.receivedAt > existing.endedAt)
          const isNotificationProgressPrefix = existing.resultOrigin === 'notification' && childText.length > 0 &&
            comparableResultText(existing.result?.content).startsWith(`${childText}\n`)
          const notificationMatches = !hasRepackagedResult || existing.resultOrigin === 'summary' ||
            (!isNotificationProgressPrefix && (notificationIsNewer || typeof message.receivedAt !== 'number')) ||
            (textBlocks.length > 0 && comparableResultText(existing.result?.content) === childText)
          if ((isLive && childCallsChanged) || (textBlocks.length > 0 && notificationMatches)) {
            if (activeSubagents === mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
            activeSubagents.set(parentId, {
              ...existing,
              toolCount: isLive ? existing.toolCount + addedCount : existing.toolCount,
              ...(childCallsChanged ? { childToolCalls: nextChildCalls } : {}),
              ...(textBlocks.length > 0 && notificationMatches
                ? {
                    result: { content: textBlocks, isError: false },
                    resultOrigin: 'streamed',
                    ...(notificationIsNewer && typeof message.receivedAt === 'number'
                      ? { endedAt: message.receivedAt, endedAtEstimated: false }
                      : {}),
                  }
                : {}),
            })
            changed = true
          }
      }
    }
  }

  // Flip a subagent child tool call's status when its tool_result lands. A
  // subagent's internal tool_result is a tool_result block inside a `user`
  // frame whose parent_tool_use_id === the subagent id (the SDK threads the
  // sidechain that way). Match the result's tool_use_id against the parent's
  // childToolCalls and flip running → success/error, capturing the payload so
  // the row can expand to show it. Mirrors the Workflow per-child result-flip.
  //
  // DELIBERATELY has no live-status guard, unlike the two blocks above (which
  // skip settled records so a late child frame can't advance a frozen elapsed
  // time). A child tool_result carries no timing that could corrupt the parent
  // — only the row's own status/result — and it routinely lands AFTER the
  // parent settled (an async subagent completing, or a record the
  // pending-timeout / dismiss path already terminated). Accepting it there is
  // what lets a stranded `running` row still resolve to its real outcome.
  if (message.type === 'user' && activeSubagents.size > 0) {
    const parentId = typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : ''
    if (parentId) {
      const existing = activeSubagents.get(parentId)
      if (existing && (existing.childToolCalls?.length ?? 0) > 0) {
        const childResults = getToolResultEntries(message)
        if (childResults.length > 0) {
          const stamp = typeof message.receivedAt === 'number' ? message.receivedAt : Date.now()
          let childChanged = false
          const updated = existing.childToolCalls!.map((c) => {
            if (c.status !== 'running') return c
            const match = childResults.find((r) => r.toolUseId === c.toolUseId)
            if (!match) return c
            childChanged = true
            return {
              ...c,
              status: (match.isError ? 'error' : 'success') as SubagentChildStatus,
              endedAt: stamp,
              result: { content: match.content, isError: match.isError },
            }
          })
          if (childChanged) {
            if (activeSubagents === mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
            activeSubagents.set(parentId, { ...existing, childToolCalls: updated })
            changed = true
          }
        }
      }
    }
  }

  // Task-notification completion signal for ALL subagent tasks (async AND
  // sync/foreground). The real completion arrives as EITHER a harness
  // `<task-notification>` user-role XML injection OR an SDK `system`/
  // `task_notification` frame — both carry the originating Agent tool_use_id
  // (the XML path always, the system frame optionally). Match it back to the
  // record and flip to 'done' ('interrupted' on failed/stopped), stamping
  // endedAt to the notification's receivedAt (the true completion moment, ≥
  // the last child frame the endedAt-advancement block above advanced endedAt to).
  // `isAsync` is NOT touched here — it is the sole authority of
  // TASKS_SNAPSHOT (the `isBackgrounded` field), so a pure-foreground sync
  // subagent that receives a notification stays isAsync:false.
  //
  // Matching streamed text stays in its original sidechain row. A different
  // full notification result replaces earlier streamed progress; a summary
  // alone does not. The SDK system-frame path carries no inline result body
  // (it lives in output_file), so it falls back to summary.
  // parseTaskNotification returns null for shapes without a matchable
  // tool_use_id (notably the system frame when its optional tool_use_id is
  // absent) — the XML path then carries completion.
  // Parsed lazily: only when at least one subagent is active can a
  // completion signal possibly match, so skip the parse entirely for the
  // common no-subagents session (every assistant text frame, every Bash
  // tool_result, etc.). parseTaskNotification itself short-circuits on
  // message type, but avoiding the call is cheaper still on this hot path.
  const taskNotification = activeSubagents.size > 0 ? parseTaskNotification(message) : null
  if (taskNotification) {
    const existing = activeSubagents.get(taskNotification.toolUseId)
    // Accept 'background' (normal: TASKS_SNAPSHOT flipped, still in the dispatch turn) AND
    // 'running' (the launch-ack tool_result was lost — a WS gap / replay hole
    // — so the record never flipped to 'background'; the completion signal is
    // still authoritative and must flip it to 'done') AND 'pending' (the
    // parent turn already ended and the turn-end sweep moved a still-
    // 'background' record to 'pending' — the async subagent kept running and
    // its completion is arriving now, possibly turns later) AND 'interrupted'
    // (the server watcher's maxMs backstop may have synthesized a 'stopped'
    // frame that flipped the record to 'interrupted' while the subagent was
    // still legitimately running; a later REAL completion must be able to
    // override that synthesized stop, otherwise the false 'stopped' poisons
    // the record permanently — see server/subagent-watcher.ts). A real user
    // interrupt can also leave 'interrupted', but a task-notification only
    // arrives when the subagent actually settled, so overriding is correct in
    // both cases. A synchronous subagent that receives a task-notification
    // gets its record completed (status -> 'done') like any other task, but
    // isAsync is not touched — it stays whatever the snapshot authority set
    // it to (false or undefined).
    // AND 'done' (the replay-ordering hole: on replay the detach ack
    // tool_result — which doesn't match the launch-ack signature — mis-settles
    // the record 'done' with the ack text as its result, and the terminal
    // tasks-snapshot arrives AFTER this frame so rescueSettled can't re-open
    // it; the notification is the only frame carrying the real result, so it
    // must overwrite the bogus ack). 'dismissed' stays excluded: an explicit user dismiss
    // is a deliberate terminal state a late notification must not revive.
    const isStaleNotification = existing && typeof message.receivedAt === 'number' &&
      !existing.endedAtEstimated && existing.endedAt != null && message.receivedAt < existing.endedAt
    if (existing && !isStaleNotification && (existing.status === 'background' || existing.status === 'running' || existing.status === 'pending' || existing.status === 'interrupted' || existing.status === 'done')) {
      if (activeSubagents === mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
      const stamp = typeof message.receivedAt === 'number' ? message.receivedAt : Date.now()
      const resultContent = taskNotification.result ?? taskNotification.summary ?? ''
      const hasCompletedOutput = existing.result != null && !existing.result.isError &&
        existing.resultOrigin !== 'summary' && existing.resultOrigin !== 'async_metadata'
      const stoppedWithOutput = taskNotification.status === 'stopped' &&
        ((taskNotification.result != null && taskNotification.result.trim() !== '') || hasCompletedOutput)
      const isError = existing.result?.isError === true && taskNotification.status !== 'completed' ||
        (taskNotification.status !== 'completed' && !stoppedWithOutput)
      const overwriteResult = shouldWriteTerminalResult(
        existing,
        taskNotification.status,
        resultContent,
        taskNotification.result != null,
      )
      const nextStatus = isError ? 'interrupted' as const : 'done' as const
      activeSubagents.set(taskNotification.toolUseId, {
        ...existing,
        status: nextStatus,
        endedAt: stamp,
        endedAtEstimated: typeof message.receivedAt !== 'number',
        // Don't clobber an existing (child-text-captured) result, AND don't
        // set a result when the notification carries no content (notably a
        // synthesized `stopped` from the watcher backstop, whose summary is
        // '') — otherwise the empty result would block a later REAL
        // completion from populating the subagent's actual output.
        ...(overwriteResult && resultContent !== ''
          ? {
              result: { content: resultContent, isError },
              resultOrigin: taskNotification.result != null ? 'notification' as const : 'summary' as const,
            }
          : {}),
      })
      changed = true
    }
  }

  // ── Workflow index ───────────────────────────────────────────────────
  // Mirrors the subagent indexing above, but for the Workflow orchestration tool.
  // A Workflow's own tool_use seeds a record (label/phases); its child agents
  // arrive as subagent-shaped tool_use blocks in sidechain frames whose
  // parent_tool_use_id is the Workflow id. We index those children (with their
  // phase tag) so the overlay can render the phase tree without re-scanning.

  // Seed / refresh Workflow records from the Workflow tool_use blocks.
  const wfStarts = getWorkflowStarts(message)
  if (wfStarts.length > 0) {
    if (activeWorkflows === mirror.activeWorkflows) activeWorkflows = new Map(activeWorkflows)
    // Prefer server-stamped wall-clock so replay/refresh keeps the original
    // workflow start instead of resetting to now.
    const stamp = typeof message.receivedAt === 'number' ? message.receivedAt : Date.now()
    for (const wf of wfStarts) {
      const existing = activeWorkflows.get(wf.toolUseId)
      activeWorkflows.set(wf.toolUseId, {
        ...wf,
        // Preserve startedAt/endedAt/status/childAgents/result across replay
        // re-encounters — only fill in what's missing. `phases` is re-parsed
        // from input each time (it's static), which is harmless and keeps the
        // record correct if the input shape ever changes.
        startedAt: existing?.startedAt ?? stamp,
        endedAt: existing?.endedAt,
        status: existing?.status ?? 'running',
        childAgents: existing?.childAgents ?? [],
        result: existing?.result,
      })
    }
    changed = true
  }

  // Capture the Workflow's OWN tool_result (the synthesized summary that lands
  // on the MAIN thread, i.e. a user frame with no parent_tool_use_id). Flip
  // the record to done/interrupted and stash the result for inline rendering.
  // Reuses the same getToolResultEntries scan — we just match against the
  // Workflow ids instead of generic tool ids.
  if (message.type === 'user' && activeWorkflows.size > 0) {
    const wfResults = getToolResultEntries(message)
    if (wfResults.length > 0) {
      let touched = false
      // Prefer server-stamped wall-clock; falls back to now for messages
      // restored from disk that lack receivedAt.
      const stamp = typeof message.receivedAt === 'number' ? message.receivedAt : Date.now()
      for (const { toolUseId, content, isError } of wfResults) {
        const existing = activeWorkflows.get(toolUseId)
        if (!existing || existing.status !== 'running') continue
        if (!touched) {
          if (activeWorkflows === mirror.activeWorkflows) activeWorkflows = new Map(activeWorkflows)
          touched = true
        }
        // Parse WorkflowOutput (status/taskType/runId/scriptPath/sessionUrl)
        // from the result content. Null when the content isn't a
        // WorkflowOutput-shaped JSON payload (e.g. a plain summary string) —
        // in that case the remote/runId/scriptPath fields stay undefined and
        // the record keeps working at its previous fidelity.
        const parsedOut = parseWorkflowOutput(content)
        activeWorkflows.set(toolUseId, {
          ...existing,
          status: isError ? 'interrupted' : 'done',
          endedAt: stamp,
          result: { content, isError },
          // Authoritative completion metadata (null-safe: parsedOut may be null).
          taskType: parsedOut?.taskType ?? existing.taskType,
          sessionUrl: parsedOut?.sessionUrl ?? existing.sessionUrl,
          runId: parsedOut?.runId ?? existing.runId,
          scriptPath: parsedOut?.scriptPath ?? existing.scriptPath,
          remote:
            parsedOut?.status === 'remote_launched' ||
            parsedOut?.taskType === 'remote_agent' ||
            existing.remote === true,
          // Rescue a still-generic label with the authoritative workflow name
          // (the script parse may have failed or the workflow was invoked by
          // `name`, so label could still be 'Workflow' at this point).
          label:
            existing.label === 'Workflow' && parsedOut?.workflowName
              ? parsedOut.workflowName
              : existing.label,
        })
      }
      changed = changed || touched
    }
  }

  // Index the Workflow's child agents. An assistant frame inside a Workflow's
  // sidechain carries parent_tool_use_id = the Workflow id; any subagent-shaped
  // tool_use blocks in it are this Workflow's children. getWorkflowChildStarts
  // returns them with their phase tag + the parentId they belong to.
  if (message.type === 'assistant' && activeWorkflows.size > 0) {
    const { parentId, children } = getWorkflowChildStarts(message)
    if (parentId && children.length > 0) {
      const wf = activeWorkflows.get(parentId)
      if (wf) {
        if (activeWorkflows === mirror.activeWorkflows) activeWorkflows = new Map(activeWorkflows)
        const byId = new Map(wf.childAgents.map((c) => [c.toolUseId, c]))
        // Server-stamped wall-clock survives replay; falls back to now
        // for disk-restored frames without receivedAt.
        const stamp = typeof message.receivedAt === 'number' ? message.receivedAt : Date.now()
        for (const child of children) {
          const existing = byId.get(child.toolUseId)
          byId.set(child.toolUseId, {
            ...child,
            startedAt: existing?.startedAt ?? stamp,
            endedAt: existing?.endedAt,
            status: existing?.status ?? 'running',
            toolCount: existing?.toolCount ?? 0,
            result: existing?.result,
          })
        }
        activeWorkflows.set(parentId, { ...wf, childAgents: Array.from(byId.values()) })
        changed = true
      }
    }

    // Also tally tool_use blocks inside a child's own sidechain (a child agent
    // spawned by the Workflow runs its own tools — count them per child so a
    // chip can show "4 tools"). A child's sidechain frame has
    // parent_tool_use_id = the CHILD's tool_use id, not the Workflow's, so we
    // look up which child (across all active workflows) owns that id.
    const childParentId = message.parent_tool_use_id
    if (typeof childParentId === 'string') {
      const content = message.message?.content
      if (Array.isArray(content)) {
        let newTools = 0
        for (const b of content as Array<{ type?: string }>) {
          if (b.type === 'tool_use') newTools++
        }
        if (newTools > 0) {
          // Find the workflow + child whose toolUseId === childParentId.
          for (const [wfId, wf] of activeWorkflows) {
            const child = wf.childAgents.find((c) => c.toolUseId === childParentId)
            if (!child || child.status !== 'running') continue
            if (activeWorkflows === mirror.activeWorkflows) activeWorkflows = new Map(activeWorkflows)
            const updatedChild = { ...child, toolCount: child.toolCount + newTools }
            activeWorkflows.set(wfId, {
              ...wf,
              childAgents: wf.childAgents.map((c) =>
                c.toolUseId === childParentId ? updatedChild : c,
              ),
            })
            changed = true
            break
          }
        }
      }
    }
  }

  // Flip a Workflow child's status when its tool_result lands. A child's
  // result is a tool_result block whose tool_use_id is the CHILD's id; it
  // arrives in a user frame inside the Workflow's sidechain (parent_tool_use_id
  // = the Workflow id). Match against every active workflow's child index.
  if (message.type === 'user' && activeWorkflows.size > 0) {
    const childResults = getToolResultEntries(message)
    if (childResults.length > 0) {
      let touched = false
      // Prefer server-stamped wall-clock so child completion times survive
      // replay/refresh instead of jumping forward to now.
      const stamp = typeof message.receivedAt === 'number' ? message.receivedAt : Date.now()
      for (const [wfId, wf] of activeWorkflows) {
        let childChanged = false
        const updatedChildren = wf.childAgents.map((c) => {
          if (c.status !== 'running') return c
          const match = childResults.find((r) => r.toolUseId === c.toolUseId)
          if (!match) return c
          childChanged = true
          return {
            ...c,
            status: (match.isError ? 'interrupted' : 'done') as WorkflowStatus,
            endedAt: stamp,
            result: { content: match.content, isError: match.isError },
          }
        })
        if (childChanged) {
          if (!touched) {
            if (activeWorkflows === mirror.activeWorkflows) activeWorkflows = new Map(activeWorkflows)
            touched = true
          }
          activeWorkflows.set(wfId, { ...wf, childAgents: updatedChildren })
        }
      }
      changed = changed || touched
    }
  }

  // ── Skill index ──────────────────────────────────────────────────────
  // A Skill tool_use is usually context-only and this index is then just a
  // status/label record. But a FORKED skill is a sidechain parent: the CLI runs
  // it as its own agent and forwards the whole inner conversation as frames
  // whose parent_tool_use_id is the Skill's tool_use id. Those frames are
  // dropped by the main row model (root-only), so without the record below the
  // fork's work — tool calls AND nested subagent launches — has no owner and
  // no way to be reached. Same shape as the Workflow block above.

  // Seed / refresh Skill records from the Skill tool_use blocks.
  const skillStarts = getSkillStarts(message)
  if (skillStarts.length > 0) {
    if (activeSkills === mirror.activeSkills) activeSkills = new Map(activeSkills)
    // Server-stamped wall-clock survives replay; falls back to now for
    // disk-restored frames without receivedAt.
    const stamp = typeof message.receivedAt === 'number' ? message.receivedAt : Date.now()
    for (const sk of skillStarts) {
      const existing = activeSkills.get(sk.toolUseId)
      activeSkills.set(sk.toolUseId, {
        ...sk,
        // Identity fields (name/namespace/args) are re-derived from input each
        // time — static, so re-deriving is harmless. Everything the lifecycle
        // wrote is preserved across a replay re-encounter.
        startedAt: existing?.startedAt ?? stamp,
        endedAt: existing?.endedAt,
        status: existing?.status ?? 'running',
        childCalls: existing?.childCalls ?? [],
        result: existing?.result,
      })
    }
    changed = true
  }

  // Capture the Skill's OWN tool_result and settle the record. It arrives on
  // whichever thread made the call, so — unlike the child branch below — this
  // must NOT require a parent_tool_use_id.
  if (message.type === 'user' && activeSkills.size > 0) {
    const skillResults = getToolResultEntries(message)
    if (skillResults.length > 0) {
      let touched = false
      const stamp = typeof message.receivedAt === 'number' ? message.receivedAt : Date.now()
      for (const { toolUseId, content, isError } of skillResults) {
        const existing = activeSkills.get(toolUseId)
        if (!existing || existing.status !== 'running') continue
        if (!touched) {
          if (activeSkills === mirror.activeSkills) activeSkills = new Map(activeSkills)
          touched = true
        }
        activeSkills.set(toolUseId, {
          ...existing,
          status: isError ? 'interrupted' : 'done',
          endedAt: stamp,
          result: { content, isError },
          // The fork is over, so any child row still marked running lost its
          // result (evicted / interrupted frame) — settle it rather than leave
          // a spinner inside a finished card.
          childCalls: sweepRunningChildCalls(existing.childCalls) ?? existing.childCalls,
        })
      }
      changed = changed || touched
    }
  }

  // Index the fork's tool calls. An assistant frame inside the fork's sidechain
  // carries parent_tool_use_id = the Skill id; every tool_use block in it is
  // one of the fork's calls. Reuses getSubagentChildStarts (it returns ALL
  // tool_use blocks with the frame's parent id, which is exactly this shape) so
  // the two sidechain owners can't drift on what counts as a child.
  //
  // Nested Agent/Task/Explore launches land here as ordinary rows AND get their
  // own ActiveSubagent record from getSubagentStarts (which ignores parentage),
  // so they stay drillable once the overlay renders them.
  if (message.type === 'assistant' && activeSkills.size > 0) {
    const { parentId, children } = getSubagentChildStarts(message)
    if (parentId && children.length > 0) {
      const sk = activeSkills.get(parentId)
      // Settled records are left alone: a late frame must not reopen a finished
      // card or advance its frozen elapsed time.
      if (sk && sk.status === 'running') {
        const byId = new Map(sk.childCalls.map((c) => [c.toolUseId, c]))
        let added = false
        const stamp = typeof message.receivedAt === 'number' ? message.receivedAt : Date.now()
        for (const child of children) {
          if (byId.has(child.toolUseId)) continue // preserve status/result
          byId.set(child.toolUseId, { ...child, startedAt: stamp })
          added = true
        }
        if (added) {
          if (activeSkills === mirror.activeSkills) activeSkills = new Map(activeSkills)
          activeSkills.set(parentId, { ...sk, childCalls: Array.from(byId.values()) })
          changed = true
        }
      }
    }
  }

  // Flip a fork child's status when its tool_result lands (a user frame inside
  // the same sidechain). No live-status guard, for the reason spelled out on
  // the subagent equivalent: a child result carries no timing that could
  // corrupt the parent, and letting it through is what resolves a row that the
  // parent settled first.
  if (message.type === 'user' && activeSkills.size > 0) {
    const parentId = typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : ''
    const sk = parentId ? activeSkills.get(parentId) : undefined
    if (sk && sk.childCalls.length > 0) {
      const childResults = getToolResultEntries(message)
      if (childResults.length > 0) {
        const stamp = typeof message.receivedAt === 'number' ? message.receivedAt : Date.now()
        let childChanged = false
        const updated = sk.childCalls.map((c) => {
          if (c.status !== 'running') return c
          const match = childResults.find((r) => r.toolUseId === c.toolUseId)
          if (!match) return c
          childChanged = true
          return {
            ...c,
            status: (match.isError ? 'error' : 'success') as SubagentChildStatus,
            endedAt: stamp,
            result: { content: match.content, isError: match.isError },
          }
        })
        if (childChanged) {
          if (activeSkills === mirror.activeSkills) activeSkills = new Map(activeSkills)
          activeSkills.set(parentId, { ...sk, childCalls: updated })
          changed = true
        }
      }
    }
  }

  if (!changed) return mirror
  return { ...mirror, activeSubagents, activeWorkflows, activeSkills }
}

// ── applyTasksSnapshot ────────────────────────────────────────────────────
// Extracted from the reducer's TASKS_SNAPSHOT case. A pure `mirror → mirror`
// transform: replaces the whole task list, then enriches matching subagent
// records (taskId / progressSummary / lastToolName / isAsync / status flips).
// TASKS_SNAPSHOT is the SOLE isAsync authority (writes for both live and
// terminal records, both directions).

export function applyTasksSnapshot(mirror: ServerMirror, tasks: TaskRecordUi[]): ServerMirror {
  // Replace the whole task list, then enrich matching subagent records.
  // Joining by toolUseId (not taskId) because activeSubagents are keyed
  // by the Agent tool_use id — TaskRecordUi carries that id on subagent
  // tasks. Terminal task records clear the summary so a done row
  // doesn't show stale progress text.
  let activeSubagents = mirror.activeSubagents
  for (const task of tasks) {
    if (!task.toolUseId) continue
    const record = activeSubagents.get(task.toolUseId)
    if (!record) continue
    if (activeSubagents === mirror.activeSubagents) {
      activeSubagents = new Map(activeSubagents)
    }
    const isTerminal = isTerminalTaskStatus(task.status)
    // ★ 权威写入:server 给了布尔就覆盖(双向;live 与 terminal 都写)。
    const nextIsAsync = typeof task.isBackgrounded === 'boolean'
      ? task.isBackgrounded
      : record.isAsync
    // rescue:Ctrl+B detach ack(非 launch 签名)把记录误结算成 done/带假 result。
    const rescueSettled =
      task.isBackgrounded === true && !isTerminal &&
      (record.status === 'done' || record.status === 'interrupted')
    const flipToBackground =
      task.isBackgrounded === true && !isTerminal &&
      (record.status === 'running' || rescueSettled)
    // Terminal task + still-live record → settle the record. The task map
    // is the liveness authority (server-folded from the SDK's task frames,
    // now also reconciled against the Stop hook's authoritative in-flight
    // list), so a terminal entry here means the work is over even when no
    // completion signal ever reached the transcript — the CLI does not
    // reliably emit task_notification for Agent-launched background
    // subagents, which is exactly how a row ends up spinning forever and
    // the WorkingBubble sticks on "Waiting...".
    //
    // Restricted to records we know carry no pending transcript payload:
    // 'background' / 'pending' (async — their Agent tool_result was only a
    // launch ack) and 'running' when the SNAPSHOT AUTHORITY (this task's
    // `isBackgrounded`, folded into `nextIsAsync`) says the task was an
    // async/background one. A sync record is deliberately excluded: its
    // real output arrives as the Agent tool_result, and that merge branch
    // requires status 'running', so settling here first would swallow the
    // subagent's output.
    //
    // ★ `nextIsAsync`, NOT `record.isAsync`: a fast-completing async agent
    // can be missing from every non-terminal snapshot (the client
    // subscribed after it finished, or the only snapshot that ever matched
    // its toolUseId is the terminal one). In that case `record.isAsync` is
    // still undefined — reading it here skipped the settle and left the row
    // `running` forever with its historical `startedAt`, which is exactly
    // the WorkingBubble "Subagent running for 14h/38h" bug. The snapshot
    // field is authoritative for THIS frame; the stored flag only fills in
    // when the task omits `isBackgrounded`.
    //
    // The assumption this exclusion used to rest on — "stranded sync records
    // are already covered by the turn-end result-frame sweep" — holds only
    // while a result frame is still coming. A session that TERMINATES never
    // delivers one, so SESSION_TERMINATED runs that same sweep for exactly
    // this case; without it a sync record stays `running` forever and its
    // card spins on a dead session.
    //
    // 'stopped' maps to 'done' when a result was captured (the work landed,
    // only the bookend was lost) and 'interrupted' otherwise; a later REAL
    // task_notification can still overwrite either (its branch accepts
    // 'done' and 'interrupted'). A completed resultless snapshot can also
    // recover an already-interrupted sync record, but must not settle a
    // running one before its canonical tool_result arrives.
    const terminalTaskTime = task.endedAt ?? (task.updatedAt > 0 ? task.updatedAt : undefined)
    const staleTerminalTask = isTerminal && typeof terminalTaskTime === 'number' &&
      !record.endedAtEstimated && record.endedAt != null && terminalTaskTime < record.endedAt
    const settleFromTerminalTask = isTerminal && !staleTerminalTask && record.status !== 'dismissed' &&
      (nextIsAsync === true || record.status === 'background' || record.status === 'pending' ||
        (record.status === 'interrupted' && task.status === 'completed') ||
        (typeof task.result === 'string' && task.result.trim() !== '') || task.status !== 'completed')
    const notificationResult = isTerminal && !staleTerminalTask && record.status !== 'dismissed' &&
      shouldWriteTerminalResult(record, task.status, task.result ?? '', true)
      ? {
          result: { content: task.result, isError: task.status !== 'completed' && task.status !== 'stopped' },
          resultOrigin: 'notification' as const,
        }
      : null
    const hasCapturedOutput = notificationResult != null ||
      (record.result != null && !record.result.isError && record.resultOrigin !== 'summary' && record.resultOrigin !== 'async_metadata')
    const settledStatus = task.status === 'stopped' && record.result?.isError === true
      ? 'interrupted' as const
      : task.status === 'completed'
        ? 'done' as const
        : task.status === 'stopped' && hasCapturedOutput
          ? 'done' as const
          : 'interrupted' as const
    activeSubagents.set(task.toolUseId, {
      ...record,
      taskId: task.taskId,
      progressSummary: isTerminal ? undefined : task.progressSummary ?? record.progressSummary,
      lastToolName: isTerminal ? undefined : task.lastToolName ?? record.lastToolName,
      isAsync: nextIsAsync,
      ...(notificationResult
        ? { result: { ...notificationResult.result, isError: settledStatus !== 'done' }, resultOrigin: 'notification' as const }
        : {}),
      ...(flipToBackground
        ? rescueSettled
          ? { status: 'background' as const, endedAt: undefined, result: undefined, resultOrigin: undefined }
          : { status: 'background' as const }
        : {}),
      ...(settleFromTerminalTask
        ? {
            status: settledStatus,
            endedAt: task.endedAt ?? record.endedAt ?? Date.now(),
            endedAtEstimated: task.endedAt != null ? false : (record.endedAt != null ? record.endedAtEstimated : true),
          }
        : {}),
    })
  }
  if (
    activeSubagents === mirror.activeSubagents &&
    mirror.tasks === tasks
  ) return mirror
  return { ...mirror, tasks, activeSubagents }
}

// ── dismissSubagent ───────────────────────────────────────────────────────
// Extracted from the reducer's DISMISS_SUBAGENT case. Operates on the full
// SessionState because it writes to both mirror.activeSubagents and
// intent.dismissedSubagents.

/** Flip an in-flight subagent (running/background/pending) to `dismissed`
 *  so it leaves the WorkingBubble's subagent pill. Uses a dedicated `dismissed`
 *  status (NOT `interrupted`) so the inline SubagentCard renders a neutral
 *  state instead of a false error. The result merge only processes
 *  status === 'running' records, and the completion branch excludes
 *  `dismissed`, so a dismissed record stays dismissed for BOTH sync and
 *  async subagents — an explicit dismiss is a deliberate terminal state.
 *  Also records the id on intent.dismissedSubagents so the dismiss
 *  survives mirror rebuilds (refresh/replay re-derive activeSubagents
 *  from the message stream, which has no record of the dismiss).
 *  No-op for already-settled records. */
export function dismissSubagent(state: SessionState, toolUseId: string): SessionState {
  const existing = state.mirror.activeSubagents.get(toolUseId)
  if (!existing || (existing.status !== 'running' && existing.status !== 'background' && existing.status !== 'pending')) return state
  const activeSubagents = new Map(state.mirror.activeSubagents)
  activeSubagents.set(toolUseId, {
    ...existing,
    status: 'dismissed',
    endedAt: existing.endedAt ?? existing.startedAt,
  })
  const dismissedSubagents = new Set(state.intent.dismissedSubagents)
  dismissedSubagents.add(toolUseId)
  return withIntent(
    withMirror(state, { ...state.mirror, activeSubagents }),
    { ...state.intent, dismissedSubagents },
  )
}

// ── reapplyDismissed ──────────────────────────────────────────────────────
// Moved from reducer.ts. Re-applies client-side dismissals to a freshly-rebuilt
// mirror. After a hydrate / replay rebuilds `activeSubagents` from the message
// stream, the records the user dismissed come back as `running`/`background`/
// `pending` (the stream has no record of the dismiss). This flips them back to
// `dismissed` and prunes ids that no longer have a dismissable record.
//
// Called by the reducer after replayReplace and inside rebuildIndexesFromMessages
// so every rebuild path re-applies dismissals without callers needing to do it
// manually.

export function reapplyDismissed(state: SessionState): SessionState {
  if (state.intent.dismissedSubagents.size === 0) return state
  let activeSubagents = state.mirror.activeSubagents
  let mirrorChanged = false
  for (const id of state.intent.dismissedSubagents) {
    const sub = activeSubagents.get(id)
    if (!sub) continue
    if (sub.status !== 'running' && sub.status !== 'background' && sub.status !== 'pending') continue
    if (activeSubagents === state.mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
    activeSubagents.set(id, { ...sub, status: 'dismissed', endedAt: sub.endedAt ?? sub.startedAt })
    mirrorChanged = true
  }
  // Prune ids whose record no longer exists or settled naturally; keep ids
  // that are still dismissed or dismissable so a future rebuild can re-apply.
  let dismissed = state.intent.dismissedSubagents
  for (const id of state.intent.dismissedSubagents) {
    const sub = activeSubagents.get(id)
    if (!sub) {
      if (dismissed === state.intent.dismissedSubagents) dismissed = new Set(dismissed)
      ;(dismissed as Set<string>).delete(id)
      continue
    }
    if (sub.status !== 'dismissed' && sub.status !== 'running' && sub.status !== 'background' && sub.status !== 'pending') {
      if (dismissed === state.intent.dismissedSubagents) dismissed = new Set(dismissed)
      ;(dismissed as Set<string>).delete(id)
    }
  }
  const intent = dismissed === state.intent.dismissedSubagents ? state.intent : { ...state.intent, dismissedSubagents: dismissed }
  const mirror = mirrorChanged ? { ...state.mirror, activeSubagents } : state.mirror
  if (mirror === state.mirror && intent === state.intent) return state
  return withIntent(withMirror(state, mirror), intent)
}

// ── hasTranscriptBackground ────────────────────────────────────────────────
// Moved from normalize.ts. Whether the mirrored transcript still holds a
// subagent in flight — the transcript-side liveness leg of both the Waiting
// state (computeWaiting) and the WorkingBubble mount gate. Accepts both
// `pending` (the normal post-turn-end form: the sweep ran) AND `background`
// (the form after a server-restart replay).

export function hasTranscriptBackground(activeSubagents: readonly ActiveSubagent[] | undefined): boolean {
  return activeSubagents?.some((a) => a.status === 'pending' || a.status === 'background') ?? false
}
