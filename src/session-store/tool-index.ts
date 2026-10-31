/** Tool index owner: the generic tool / plan / question lifecycle folds plus
 *  the permission-channel `pidToToolUseId` mapping and its side effects on
 *  plan / question state.
 *
 *  The mirror fields this module owns (per the reducer-state-owners design):
 *  `toolStatus`, `toolResults` (generic tool cards), `planStatus`,
 *  `planContent`, `questionAnswers`, and `pidToToolUseId`.
 *
 *  `updateToolIndexMirror` is a pure `mirror → mirror` transform extracted
 *  from the reducer's `updateIndexesMirror`. It handles ONLY the generic
 *  tool / plan / question branches; the sidechain branches (Subagent /
 *  Workflow / Skill) and the order-insensitivity parking
 *  (`pendingResults`) remain in the reducer's `updateIndexesMirror`
 *  coordinator, which calls this function before the sidechain fold and
 *  before the parking. That keeps the fold order: tool → sidechain → park.
 *
 *  `applyPermissionRequest` and `applyPermissionResolved` operate on the
 *  full `SessionState` because they touch `mirror.pidToToolUseId` AND the
 *  plan/question maps that the resolution frame can settle out-of-band
 *  (an allow/deny flips `planStatus`; a JSON `message` payload parses into
 *  `questionAnswers`). They are extracted verbatim from the reducer's
 *  `PERMISSION_REQUEST` / `PERMISSION_RESOLVED` cases. */

import type { PermissionRequest, SdkMessage } from '../types'
import {
  type ServerMirror,
  type SessionState,
  withMirror,
} from './types'
import {
  extractPlanContent,
  getPlanResultDecisions,
  getPlanToolUseIds,
  getToolResultEntries,
  getToolResultOutcomes,
  getToolUseStarts,
} from './normalize'
import {
  extractQuestionAnswers,
  getQuestionToolUseIds,
  parseQuestionAnswersMessage,
} from '../utils/question-answers'
import { toolDebug, toolDebugEnabled } from './debug'

// ── updateToolIndexMirror ─────────────────────────────────────────────────
// The generic tool / plan / question fold pipeline extracted from the
// reducer's `updateIndexesMirror`. Handles ONLY these six branches:
//   1. generic tool status seed (running) for every non-excluded tool_use;
//   2. generic tool status flip (success/error) on the matching tool_result;
//   3. generic tool result payload capture (toolResults);
//   4. plan status seed (pending) + flip (approved/rejected);
//   5. plan content extraction from ExitPlanMode tool_result output;
//   6. question answers seed (pending []) + parse from tool_result JSON.
//
// The sidechain branches (Subagent / Workflow / Skill) and the
// order-insensitivity parking stay in the reducer's `updateIndexesMirror`,
// which calls this BEFORE the sidechain fold so the sidechain maps see the
// updated tool/plan/question maps (resultOwnerKnown reads them).
//
// Identity-stable: returns the original mirror when nothing touched the
// five owned maps (the common case — most frames carry no tool_use / plan /
// question blocks).

export function updateToolIndexMirror(mirror: ServerMirror, message: SdkMessage): ServerMirror {
  let changed = false
  let planStatus = mirror.planStatus
  let planContent = mirror.planContent
  let questionAnswers = mirror.questionAnswers
  let toolStatus = mirror.toolStatus
  let toolResults = mirror.toolResults

  // Generic tool status — seed 'running' for every tool_use the assistant
  // emits (excluding ones with their own status map: Plan/Subagent/Question).
  const toolStarts = getToolUseStarts(message)
  if (toolStarts.length > 0) {
    toolStatus = new Map(toolStatus)
    for (const id of toolStarts) {
      // Don't clobber a status that's already terminal — could happen in
      // theory if a duplicate tool_use lands during replay.
      if (!toolStatus.has(id)) toolStatus.set(id, 'running')
    }
    toolDebug('seed running', { ids: toolStarts, total: toolStatus.size })
    changed = true
  }

  // Flip to 'success' or 'error' when the matching tool_result lands.
  // Most user messages don't carry tool_results, so defer the Map clone
  // until we actually have a status to update — same trick as the
  // subagent branch below.
  if (message.type === 'user' && toolStatus.size > 0) {
    const outcomes = getToolResultOutcomes(message)
    if (outcomes.length > 0) {
      let touched = false
      // Only allocated when diagnostics are on — keeps the hot path free.
      const orphans = toolDebugEnabled() ? [] as string[] : null
      for (const { toolUseId, outcome } of outcomes) {
        const prev = toolStatus.get(toolUseId)
        // No seeded entry for this result's tool_use_id. Either the
        // result is for an excluded tool (Plan/Subagent/Question — fine),
        // or the id genuinely doesn't match any tool_use we seeded — the
        // latter is the "id-mismatch" failure mode that strands a card on
        // 'running' forever. We can't tell the two apart here, so log it
        // for offline diagnosis rather than guessing.
        if (!prev) {
          if (orphans) orphans.push(toolUseId)
          continue
        }
        if (prev === outcome) continue
        if (!touched) {
          if (toolStatus === mirror.toolStatus) toolStatus = new Map(toolStatus)
          touched = true
        }
        toolStatus.set(toolUseId, outcome)
        toolDebug('flip', { id: toolUseId, from: prev, to: outcome })
      }
      if (orphans && orphans.length > 0) {
        toolDebug('ORPHAN result (no matching seeded tool_use)', {
          ids: orphans,
          seededIds: Array.from(toolStatus.keys()),
        })
      }
      if (touched) changed = true
    }
  }

  // Capture tool_result payloads so the originating tool_use card can
  // render the result inline (instead of a separate bubble). Only store
  // results whose tool_use_id was seeded into `toolStatus` — that set is
  // exactly the generic tool cards (Plan/Question/Subagent are excluded by
  // getToolUseStarts' TOOL_STATUS_EXCLUDE and own their result rendering).
  // Same lazy-clone discipline as the status flip above.
  if (message.type === 'user' && toolStatus.size > 0) {
    const entries = getToolResultEntries(message)
    if (entries.length > 0) {
      let touched = false
      for (const { toolUseId, content, isError } of entries) {
        if (!toolStatus.has(toolUseId)) continue
        if (toolResults.has(toolUseId)) continue
        if (!touched) {
          if (toolResults === mirror.toolResults) toolResults = new Map(toolResults)
          touched = true
        }
        toolResults.set(toolUseId, { content, isError })
      }
      if (touched) changed = true
    }
  }

  const planIds = getPlanToolUseIds(message)
  if (planIds.length > 0) {
    planStatus = new Map(planStatus)
    for (const id of planIds) planStatus.set(id, 'pending')
    changed = true
  }

  const planResults = getPlanResultDecisions(message, planStatus)
  if (planResults.length > 0) {
    if (planStatus === mirror.planStatus) planStatus = new Map(planStatus)
    for (const result of planResults) planStatus.set(result.toolUseId, result.status)
    changed = true
  }

  // Extract plan body from ExitPlanMode tool_result outputs.  The CLI
  // injects plan content from disk into the output (not the input), so
  // we capture it here for the PermissionDialog and inline PlanCard.
  // tool_result blocks only ever land on user messages — gating on
  // msg.type avoids allocating the Set for every assistant/system/result.
  if (message.type === 'user' && planStatus.size > 0) {
    const knownPlanIds = new Set(planStatus.keys())
    const extracted = extractPlanContent(message, knownPlanIds)
    if (extracted.length > 0) {
      if (planContent === mirror.planContent) planContent = new Map(planContent)
      for (const { toolUseId, plan } of extracted) planContent.set(toolUseId, plan)
      changed = true
    }
  }

  // Track AskUserQuestion tool_use ids so the inline QuestionCard can
  // render a "pending" state immediately (before the user answers).
  // We seed with an empty answers array; the tool_result handler below
  // replaces it when the JSON answers payload lands.
  const questionIds = getQuestionToolUseIds(message)
  if (questionIds.length > 0) {
    let touched = false
    for (const id of questionIds) {
      if (questionAnswers.has(id)) continue
      if (!touched) {
        questionAnswers = new Map(questionAnswers)
        touched = true
      }
      questionAnswers.set(id, [])
    }
    if (touched) changed = true
  }

  // Parse JSON answers from AskUserQuestion tool_results (built by
  // server/permission-helpers.ts:formatQuestionAnswers).  Same gating
  // pattern as the plan-content branch above — only user messages
  // carry tool_results, and we only care if we've seen the matching
  // tool_use first.
  if (message.type === 'user' && questionAnswers.size > 0) {
    const knownQuestionIds = new Set(questionAnswers.keys())
    const extracted = extractQuestionAnswers(message, knownQuestionIds)
    if (extracted.length > 0) {
      if (questionAnswers === mirror.questionAnswers) questionAnswers = new Map(questionAnswers)
      for (const { toolUseId, answers } of extracted) questionAnswers.set(toolUseId, answers)
      changed = true
    }
  }

  if (!changed) return mirror
  return {
    ...mirror,
    planStatus,
    planContent,
    questionAnswers,
    toolStatus,
    toolResults,
  }
}

// ── applyPermissionRequest ─────────────────────────────────────────────────
// Extracted from the reducer's PERMISSION_REQUEST case. A pure
// `state → state` transform that seeds `pidToToolUseId` from the request's
// `toolUseID`. A request without a `toolUseID` is a no-op (returns the
// same state reference) — the dispatcher never sends one, but the guard
// keeps the function total.

export function applyPermissionRequest(state: SessionState, request: PermissionRequest): SessionState {
  if (!request.toolUseID) return state
  const pidToToolUseId = new Map(state.mirror.pidToToolUseId)
  pidToToolUseId.set(request.id, request.toolUseID)
  return withMirror(state, { ...state.mirror, pidToToolUseId })
}

// ── applyPermissionResolved ────────────────────────────────────────────────
// Extracted from the reducer's PERMISSION_RESOLVED case. A pure
// `state → state` transform that:
//   - clears the `pidToToolUseId` entry for the resolved pid;
//   - flips `planStatus` to approved/rejected when the pid maps to a plan;
//   - parses the JSON answers payload from `decision.message` into
//     `questionAnswers` when the pid maps to a question (closing the gap
//     where the SDK does not always echo a follow-up tool_result through
//     the Query stream after a canUseTool deny+message short-circuit), and
//     stores a clarified sentinel when `questionResolution === 'clarified'`.
//
// Identity-stable when nothing changed (the common case: most
// PERMISSION_RESOLVED frames arrive for permissions the client already
// cleaned up optimistically). The lazy-clone discipline preserves Map
// reference identity so selectors that depend on it (e.g. PlanCard
// memoization) don't churn.

export function applyPermissionResolved(
  state: SessionState,
  id: string,
  decision: {
    behavior: 'allow' | 'deny'
    persisted: boolean
    message?: string
    questionResolution?: 'clarified'
  },
): SessionState {
  // Allocate fresh Maps lazily — most PERMISSION_RESOLVED frames
  // arrive for permissions we already cleaned up locally (the user
  // optimistically decided), so cloning Maps unconditionally burns
  // CPU and breaks reference equality for selectors that depend on
  // stable Map identity (e.g. PlanCard memoization).
  let pidToToolUseId = state.mirror.pidToToolUseId
  let planStatus = state.mirror.planStatus
  let questionAnswers = state.mirror.questionAnswers
  let changed = false
  const toolUseId = pidToToolUseId.get(id)
  if (toolUseId) {
    if (planStatus.has(toolUseId)) {
      planStatus = new Map(planStatus)
      planStatus.set(toolUseId, decision.behavior === 'allow' ? 'approved' : 'rejected')
    }
    // AskUserQuestion answers ride on the resolution `message` field
    // (built by server/permission-helpers.ts:formatQuestionAnswers).
    // Normally the JSON answers payload also lands as a tool_result
    // block on a follow-up user message — extractQuestionAnswers in
    // updateIndexes() parses that and replaces the pending entry.
    // But the SDK does not always echo a corresponding tool_result
    // through the Query stream after a canUseTool deny+message
    // short-circuit, which leaves the inline QuestionCard rendering
    // 'pending' forever even though the user already answered.
    // Decoding the same JSON here closes that gap — questionAnswers
    // flips from [] to the parsed entries the moment the resolution
    // frame lands, independent of whether tool_result follows.
    // Scope: only when we previously seeded a pending entry for
    // this toolUseId (i.e. it really was an AskUserQuestion call).
    if (questionAnswers.has(toolUseId) && decision.questionResolution === 'clarified') {
      questionAnswers = new Map(questionAnswers)
      questionAnswers.set(toolUseId, [{ question: '', answer: null, clarified: true }])
    } else if (questionAnswers.has(toolUseId) && decision.message) {
      const parsed = parseQuestionAnswersMessage(decision.message)
      if (parsed.length > 0) {
        questionAnswers = new Map(questionAnswers)
        questionAnswers.set(toolUseId, parsed)
      }
    }
  }
  if (pidToToolUseId.has(id)) {
    pidToToolUseId = new Map(pidToToolUseId)
    pidToToolUseId.delete(id)
    changed = true
  }
  if (!changed) return state
  return withMirror(state, {
    ...state.mirror,
    pidToToolUseId,
    planStatus,
    questionAnswers,
  })
}
