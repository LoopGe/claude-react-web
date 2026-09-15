// Context for Skill state lookup + drill-in opener.
//
// Mirrors useSubagentContext / useWorkflowContext. SkillToolView (rendered deep
// inside ToolUseBlock when the tool_use name is "Skill") needs to know whether
// its call FORKED — i.e. whether a sidechain hangs off its tool_use id — and,
// when it did, to tell the chat panel "open the drill-in for this id". Drilling
// props through every MessageList row would be noisy; context keeps it local.
//
// Unlike the other two there is no dedicated overlay: `open` routes into
// SubagentOverlay, which already renders "the frames whose parent_tool_use_id
// is X" and drills further into any subagent it finds there. Chat adapts the
// SkillRecord to the ActiveSubagent shape that overlay reads (see
// skillRecordAsSubagent).
//
// Renderless component via createElement so this file lives in hooks/
// (the eslint react-refresh rule treats hooks/ as non-component).

import { createContext, createElement, useContext, type ReactNode } from 'react'
import type { ActiveSubagent, SkillRecord } from '../session-store/types'

export interface SkillContextValue {
  /** Full index (running + completed) keyed by the Skill's tool_use_id — the
   *  same map the session-store snapshot exposes as `skillIndex`. */
  index: ReadonlyMap<string, SkillRecord>
  /** Open the drill-in pointed at this Skill's tool_use id. Only meaningful
   *  for a forked skill (one with child calls); the card doesn't offer the
   *  affordance otherwise. */
  open: (toolUseId: string) => void
}

const Ctx = createContext<SkillContextValue | null>(null)

export function SkillProvider({
  value,
  children,
}: {
  value: SkillContextValue
  children: ReactNode
}) {
  return createElement(Ctx.Provider, { value }, children)
}

export function useSkillContext(): SkillContextValue | null {
  return useContext(Ctx)
}

/** Adapt a SkillRecord to the ActiveSubagent shape SubagentOverlay reads.
 *
 *  The overlay only needs identity + lifecycle + the final payload: it looks up
 *  `label` / `status` / `startedAt` / `endedAt` for its header and hands the
 *  record to MessageList, which uses `prompt` (absent for a skill — a skill has
 *  no input prompt, so no synthetic question row is injected) and `result` (the
 *  fork's final report, rendered as the closing row of the inner conversation).
 *
 *  `isAsync: false` is deliberate, not filler: `subagentResultText` returns
 *  undefined for an async record, which would drop that closing row. A forked
 *  skill is synchronous from the caller's point of view — the calling thread
 *  blocks on its tool_result — so false is also the honest value.
 *
 *  Pure, so callers can memoise on the record identity. */
export function skillRecordAsSubagent(record: SkillRecord): ActiveSubagent {
  return {
    toolUseId: record.toolUseId,
    label: record.name,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    status: record.status,
    toolCount: record.childCalls.length,
    isAsync: false,
    result: record.result,
  }
}
