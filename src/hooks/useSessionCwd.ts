// Context for the owning session's cwd.
//
// MessageList receives `cwd` from its parent (Chat / SubagentOverlay) and
// provides it through this context so deeply nested ToolUseBlock views —
// rendered inside per-message memoised trees — can read the session cwd
// without prop-drilling. Mirrors the usePlanStatus / useQuestionAnswers
// provider pattern.
//
// Used by EditToolView to resolve real file line numbers via the
// /api/edit-locate route (see useEditStartLines).

import { createContext, createElement, useContext, type ReactNode } from 'react'

const Ctx = createContext<string | undefined>(undefined)

export function SessionCwdProvider({
  value,
  children,
}: {
  value: string | undefined
  children: ReactNode
}) {
  return createElement(Ctx.Provider, { value }, children)
}

/** Read the owning session's cwd, or undefined when no session is in scope
 *  (e.g. Side Chat drawer without a cwd). */
export function useSessionCwd(): string | undefined {
  return useContext(Ctx)
}
