// Context for Workflow state lookup + overlay opener.
//
// Mirrors useSubagentContext but for the Workflow orchestration tool.
// WorkflowCard (rendered deep inside ToolUseBlock when the tool_use name is
// "Workflow") needs to read its WorkflowRecord from the session store and tell
// the chat panel "open the overlay pointed at this toolUseId". Drilling props
// through every MessageList row would be noisy — context keeps it local.
//
// Renderless component via createElement so this file lives in hooks/
// (the eslint react-refresh rule treats hooks/ as non-component).

import { createContext, createElement, useContext, type ReactNode } from 'react'
import type { WorkflowRecord } from '../session-store/types'

export interface WorkflowContextValue {
  /** Full index (running + completed) keyed by the Workflow's tool_use_id.
   *  The same map the session-store snapshot exposes as `workflowIndex`. */
  index: ReadonlyMap<string, WorkflowRecord>
  /** Open (or push, when called from inside an already-open overlay) the
   *  WorkflowOverlay pointed at this toolUseId. */
  open: (toolUseId: string) => void
}

const Ctx = createContext<WorkflowContextValue | null>(null)

export function WorkflowProvider({
  value,
  children,
}: {
  value: WorkflowContextValue
  children: ReactNode
}) {
  return createElement(Ctx.Provider, { value }, children)
}

export function useWorkflowContext(): WorkflowContextValue | null {
  return useContext(Ctx)
}
