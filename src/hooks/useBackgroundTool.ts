// Context for backgrounding a single in-flight tool call by its tool_use id.
//
// The Composer's shared Send/Interrupt control no longer morphs into a
// Background state (the phase-keyed morph flickered on every phase
// transition); the per-card button is the precise replacement — a running
// Bash card or a synchronous subagent card knows its own tool_use id, so
// the POST /sessions/:id/tasks/background body carries { toolUseId } and
// backgrounds exactly that task instead of every foreground task (which is
// what Alt+B still does). Mirrors the useSessionCwd provider pattern:
// MessageList provides it so deeply nested tool views don't prop-drill.

import { createContext, createElement, useContext, type ReactNode } from 'react'

const Ctx = createContext<((toolUseId: string) => void) | undefined>(undefined)

export function BackgroundToolProvider({
  value,
  children,
}: {
  value: ((toolUseId: string) => void) | undefined
  children: ReactNode
}) {
  return createElement(Ctx.Provider, { value }, children)
}

/** Read the background-this-tool-call action for the owning session, or
 *  undefined when no provider is in scope (transcript exports, tests, the
 *  Side Chat drawer — places where backgrounding isn't wired). */
export function useBackgroundTool(): ((toolUseId: string) => void) | undefined {
  return useContext(Ctx)
}
