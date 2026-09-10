// Pure helpers for the ToolGroupCard summary / search-expand logic.
//
// These live outside React so they can be unit-tested without a DOM.

import type { Block } from '../../types'
import type { ActiveSubagent, ToolStatus, WorkflowRecord } from '../../session-store/types'
import type { PlanStatusMap } from '../../utils/plan-status'
import { extractToolUseId, TOOL_STATUS_EXCLUDE } from '../../session-store/normalize'
import { PLAN_TOOL_NAMES } from '../../constants/toolNames'
import { toolTargetLabel } from './tool-target'

/** One tool NAME in a folded group, with the target of its first call and a
 *  tally of the repeats folded behind it. */
export interface ToolGroupEntry {
  name: string
  /** Short target label, '' for tools that point at nothing (see
   *  toolTargetLabel). */
  target: string
  /** Further calls to the same tool folded into this entry; 0 when alone. */
  extra: number
}

export interface ToolGroupSummary {
  count: number
  /** Entries that fit the header line, in first-seen order. */
  entries: ToolGroupEntry[]
  /** Tool CALLS dropped past the header budget — rendered as a `+N` tail.
   *  Counts calls, not entries, so it agrees with the total in the pill. */
  overflow: number
  /** The whole list as plain text, for `title` + the accessible name. Always a
   *  superset of what the header shows (that is the point of having it). */
  fullSummary: string
  anyRunning: boolean
  anyError: boolean
  /** tool_use id of the FIRST failed call, so the header's `failed` badge can
   *  take the user straight to it instead of leaving them to scan the body. */
  firstErrorToolUseId?: string
  /** Pending ExitPlanMode. AskUserQuestion never enters a group (see
   *  isToolGroupEligible) — it is a run boundary like thinking. */
  anyPendingInteractive: boolean
}

/** Character budget for the visible header line. This is NOT the layout
 *  mechanism — the line is a nowrap ellipsis and CSS does the responsive
 *  part, which a fixed char count could never do across 1–3 panel widths.
 *  It exists so a 20-tool run degrades to `…  +14` instead of building a
 *  400-character string that the ellipsis silently eats. */
const HEADER_BUDGET = 76

const SEPARATOR = ' · '

/** Entries past this many are summarised in the accessible name too. A
 *  screen reader announcing 20 tool calls verbatim is its own problem. */
const SPOKEN_ENTRY_CAP = 6

/** Plain-text form of one entry — the same shape the header renders as spans,
 *  so budget maths and `title` can't disagree with what's on screen. */
export function toolGroupEntryText(entry: ToolGroupEntry): string {
  if (!entry.target) {
    return entry.extra > 0 ? `${entry.name}×${entry.extra + 1}` : entry.name
  }
  return entry.extra > 0
    ? `${entry.name} ${entry.target} +${entry.extra}`
    : `${entry.name} ${entry.target}`
}

/** Take entries while they fit; everything after the first miss becomes the
 *  `+N` tail. Stops at the first miss rather than skipping and continuing, so
 *  the header always shows a stable PREFIX of the run — resuming after a gap
 *  would reorder the line as tools land. */
function fitEntries(all: ToolGroupEntry[]): { entries: ToolGroupEntry[]; overflow: number } {
  const entries: ToolGroupEntry[] = []
  let used = 0
  let overflow = 0
  let full = false
  for (const entry of all) {
    if (!full) {
      const width = toolGroupEntryText(entry).length + (entries.length > 0 ? SEPARATOR.length : 0)
      // The first entry goes in whatever it costs: a header reading only
      // "+9" would say less than the count pill next to it already does.
      if (entries.length === 0 || used + width <= HEADER_BUDGET) {
        entries.push(entry)
        used += width
        continue
      }
      full = true
    }
    overflow += entry.extra + 1
  }
  return { entries, overflow }
}

function buildFullSummary(all: ToolGroupEntry[]): string {
  const spoken = all.slice(0, SPOKEN_ENTRY_CAP).map(toolGroupEntryText).join(SEPARATOR)
  const rest = all.slice(SPOKEN_ENTRY_CAP).reduce((n, e) => n + e.extra + 1, 0)
  return rest > 0 ? `${spoken}${SEPARATOR}+${rest} more` : spoken
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
  /** Lifecycle records for the tools that never appear in `toolStatuses`
   *  (see TOOL_STATUS_EXCLUDE): Agent / Task / Explore, and Workflow. Omit
   *  them and such a call simply never counts as in flight. */
  subagentStatuses?: ReadonlyMap<string, ActiveSubagent>,
  workflowStatuses?: ReadonlyMap<string, WorkflowRecord>,
): ToolGroupSummary {
  // First-seen order, one entry per tool NAME. Repeats fold into `extra`
  // rather than adding entries: `Read App.tsx +2` beats three near-identical
  // segments competing for the same line.
  const byName = new Map<string, ToolGroupEntry>()
  let anyRunning = false
  let anyError = false
  let firstErrorToolUseId: string | undefined
  let anyPendingInteractive = false

  for (const block of toolBlocks) {
    const name = (block as { name?: string }).name
    if (name) {
      const existing = byName.get(name)
      if (existing) {
        existing.extra += 1
        // A later call can supply the target the first one lacked (an empty
        // Bash input followed by a real command); don't leave the entry bare.
        if (!existing.target) {
          existing.target = toolTargetLabel(name, (block as { input?: unknown }).input)
        }
      } else {
        byName.set(name, {
          name,
          target: toolTargetLabel(name, (block as { input?: unknown }).input),
          extra: 0,
        })
      }
    }

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

    // Tools missing from the generic map BY DESIGN. Agent / Task / Explore and
    // Workflow carry their own richer lifecycle; the inline markers
    // (EnterPlanMode, worktree enter/exit) have none at all. The
    // "no status = still in flight" default below must not reach them — it kept
    // a group holding a long-finished subagent pinned open, badge spinning.
    if (name && TOOL_STATUS_EXCLUDE.has(name)) {
      // Only 'running' is in flight. 'background' / 'pending' is work the user
      // deliberately deferred: its own card reports on it, and pinning the
      // whole group open for however long it takes helps nobody. Terminal
      // states (done / rejected / interrupted / dismissed) don't feed the
      // group's error badge either — that badge is about generic tool
      // failures, and a subagent card shows its own outcome.
      const record = subagentStatuses?.get(id) ?? workflowStatuses?.get(id)
      if (record?.status === 'running') anyRunning = true
      continue
    }

    const status = toolStatuses.get(id)
    if (!status || status === 'running') anyRunning = true
    else if (status === 'error') {
      anyError = true
      firstErrorToolUseId ??= id
    }
  }

  const all = Array.from(byName.values())
  const { entries, overflow } = fitEntries(all)

  return {
    count: toolBlocks.length,
    entries,
    overflow,
    fullSummary: buildFullSummary(all),
    anyRunning,
    anyError,
    firstErrorToolUseId,
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
