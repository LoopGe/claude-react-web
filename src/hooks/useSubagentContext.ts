// Context for subagent state lookup + overlay opener.
//
// SubagentCard (rendered deep inside ToolUseBlock) needs to read its
// status from the session store and tell the chat panel "open the
// overlay pointed at this toolUseId". Drilling props through every
// MessageList row would be noisy — context keeps it local.
//
// Renderless component via createElement so this file lives in hooks/
// (the eslint react-refresh rule treats hooks/ as non-component).

import { createContext, createElement, useContext, type ReactNode } from 'react'
import type { ActiveSubagent } from '../session-store/types'
import type { SdkMessage } from '../types'

export interface SubagentContextValue {
  /** Full index keyed by toolUseId — running + completed. */
  index: ReadonlyMap<string, ActiveSubagent>
  /** All session messages — used to count children for the chip
   *  ("4 tools called") without re-walking the entire stream per chip. */
  messages: readonly SdkMessage[]
  /** Open (or push, when called from inside an already-open overlay)
   *  the SubagentOverlay pointed at this toolUseId. */
  open: (toolUseId: string) => void
}

const Ctx = createContext<SubagentContextValue | null>(null)

export function SubagentProvider({
  value,
  children,
}: {
  value: SubagentContextValue
  children: ReactNode
}) {
  return createElement(Ctx.Provider, { value }, children)
}

export function useSubagentContext(): SubagentContextValue | null {
  return useContext(Ctx)
}
