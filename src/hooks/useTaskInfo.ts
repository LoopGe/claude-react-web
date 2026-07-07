// Context + hook for TaskCreate/TaskUpdate state lookup, keyed by the
// server-assigned task id (`#N`).
//
// Mirrors the pattern of useQuestionAnswers.ts: MessageList computes a
// Map<taskId, TaskState> once per render via buildTaskStateMap (folding the
// whole TaskCreate/TaskUpdate stream — see src/utils/task-events.ts) and
// provides it through this context so the deeply nested TaskMutationView
// (rendered inside per-message memoised MessageView trees) can resolve a
// TaskUpdate's subject without prop-drilling. The subject is set at
// TaskCreate time and is NOT repeated in a TaskUpdate's input, so the inline
// card needs this lookup to show anything more informative than `#N`.
//
// The provider is a renderless React component constructed via createElement
// to keep this file in the hooks/ directory (the project's eslint
// react-refresh rule treats files in hooks/ as non-component).

import { createContext, createElement, useContext, type ReactNode } from 'react'
import type { TaskState } from '../utils/task-events'

type TaskInfoMap = ReadonlyMap<string, TaskState>

const Ctx = createContext<TaskInfoMap>(new Map())

export function TaskInfoProvider({
  value,
  children,
}: {
  value: TaskInfoMap
  children: ReactNode
}) {
  return createElement(Ctx.Provider, { value }, children)
}

/** Returns the folded TaskState for a given server-assigned task id (`#N`),
 *  or `undefined` when the id is unknown (e.g. the TaskCreate that assigned
 *  it is out of the retained history window, or its result hasn't landed
 *  yet so the `#N` was never learned). */
export function useTaskInfo(taskId: string | undefined): TaskState | undefined {
  const map = useContext(Ctx)
  if (!taskId) return undefined
  return map.get(taskId)
}
