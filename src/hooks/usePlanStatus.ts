// Context and hook for the plan-mode status lookup.
//
// MessageList computes a Map<tool_use_id, 'approved'|'rejected'|'pending'>
// once per render via computePlanStatus and provides it through this
// context so deeply nested ToolUseBlocks (rendered inside per-message
// memoised MessageView trees) can read their own status without
// prop-drilling.
//
// The provider is exported as a renderless React component constructed
// via createElement to keep this file in the hooks/ directory (which
// the project's eslint react-refresh rule treats as non-component).

import { createContext, createElement, useContext, type ReactNode } from 'react'
import type { PlanStatusMap } from '../utils/plan-status'
import type { ToolStatus } from '../session-store/types'

const Ctx = createContext<PlanStatusMap>(new Map())
const ContentCtx = createContext<ReadonlyMap<string, string>>(new Map())
const ToolStatusCtx = createContext<ReadonlyMap<string, ToolStatus>>(new Map())

export function PlanStatusProvider({
  value,
  children,
}: {
  value: PlanStatusMap
  children: ReactNode
}) {
  return createElement(Ctx.Provider, { value }, children)
}

export function PlanContentProvider({
  value,
  children,
}: {
  value: ReadonlyMap<string, string>
  children: ReactNode
}) {
  return createElement(ContentCtx.Provider, { value }, children)
}

/** Provides the generic-tool status map (running / success / error)
 *  keyed by tool_use_id. Mirrors PlanStatusProvider — separate context
 *  because the lifecycle is genuinely different (a tool succeeds or
 *  fails, a plan is approved or rejected). */
export function ToolStatusProvider({
  value,
  children,
}: {
  value: ReadonlyMap<string, ToolStatus>
  children: ReactNode
}) {
  return createElement(ToolStatusCtx.Provider, { value }, children)
}

export function usePlanStatus(toolUseId: string | undefined): 'approved' | 'rejected' | 'pending' {
  const map = useContext(Ctx)
  if (!toolUseId) return 'pending'
  return map.get(toolUseId) ?? 'pending'
}

/** Look up plan body text extracted from ExitPlanMode tool_result output.
 *  Returns `undefined` when the tool_result hasn't arrived yet (plan not
 *  yet available — the CLI reads it from disk only during execution). */
export function usePlanContent(toolUseId: string | undefined): string | undefined {
  const map = useContext(ContentCtx)
  if (!toolUseId) return undefined
  return map.get(toolUseId)
}

/** Read a tool's lifecycle status by id. Returns 'running' as the
 *  default when the id isn't yet in the map — this is the correct
 *  initial state for any tool that's been emitted but hasn't received a
 *  tool_result. Pass `undefined` for the id (e.g. before the block has
 *  one) and you get 'running' back, which is also the right "initial,
 *  unknown" rendering. */
export function useToolStatus(toolUseId: string | undefined): ToolStatus {
  const map = useContext(ToolStatusCtx)
  if (!toolUseId) return 'running'
  return map.get(toolUseId) ?? 'running'
}
