// Pure helpers for the ToolGroupCard summary / search-expand logic.
//
// These live outside React so they can be unit-tested without a DOM.

import type { Block } from '../../types'
import type { ToolStatus } from '../../session-store/types'
import type { PlanStatusMap } from '../../utils/plan-status'
import { extractToolUseId } from '../../session-store/normalize'
import { PLAN_TOOL_NAMES } from '../../constants/toolNames'

export interface ToolGroupSummary {
  count: number
  nameSummary: string
  anyRunning: boolean
  anyError: boolean
  /** Pending ExitPlanMode. AskUserQuestion never enters a group (see
   *  isToolGroupEligible) — it is a run boundary like thinking. */
  anyPendingInteractive: boolean
}

/** Build a one-line summary for a collapsed group header.
 *
 *  `toolBlocks` are the tool_use blocks extracted from the group's member
 *  messages. Status maps come from the context providers that MessageList
 *  already wraps the transcript in. */
export function summarizeToolGroup(
  toolBlocks: Block[],
  toolStatuses: ReadonlyMap<string, ToolStatus>,
  planStatuses: PlanStatusMap,
): ToolGroupSummary {
  const names: string[] = []
  let anyRunning = false
  let anyError = false
  let anyPendingInteractive = false

  for (const block of toolBlocks) {
    const name = (block as { name?: string }).name
    if (name) names.push(name)

    const id = extractToolUseId(block)
    if (!id) {
      // No id yet — treat as in-flight so the group never prematurely folds.
      anyRunning = true
      continue
    }

    // Plan uses its own status map; a pending plan force-opens the group.
    if (name && PLAN_TOOL_NAMES.has(name)) {
      const ps = planStatuses.get(id)
      if (!ps || ps === 'pending') anyPendingInteractive = true
      continue
    }

    const status = toolStatuses.get(id)
    if (!status || status === 'running') anyRunning = true
    else if (status === 'error') anyError = true
  }

  // Per-tool counts in first-seen order: "Read×2 · Grep · Edit"
  const counts = new Map<string, number>()
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1)
  const nameSummary = Array.from(counts.entries())
    .map(([n, c]) => (c > 1 ? `${n}×${c}` : n))
    .join(' · ')

  return {
    count: toolBlocks.length,
    nameSummary,
    anyRunning,
    anyError,
    anyPendingInteractive,
  }
}

/** True when any tool name or stringified input value in the group
 *  contains the search query (case-insensitive). This determines whether
 *  a collapsed group force-expands to reveal a search hit. */
export function groupMayMatchSearch(
  toolBlocks: Block[],
  searchQuery: string | undefined,
): boolean {
  if (!searchQuery) return false
  const needle = searchQuery.toLowerCase()
  for (const block of toolBlocks) {
    const name = (block as { name?: string }).name
    if (name && name.toLowerCase().includes(needle)) return true
    const input = (block as { input?: Record<string, unknown> }).input
    if (input && matchesInput(input, needle)) return true
  }
  return false
}

function matchesInput(input: Record<string, unknown>, needle: string): boolean {
  for (const val of Object.values(input)) {
    if (typeof val === 'string' && val.toLowerCase().includes(needle)) return true
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string' && item.toLowerCase().includes(needle)) return true
      }
    }
  }
  return false
}
