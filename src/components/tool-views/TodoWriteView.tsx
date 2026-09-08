// TodoWrite (legacy full-snapshot todo list) tool_use view.
//
// Extracted from ToolUseBlock.tsx for modularity.

import type { ReactNode } from 'react'
import { ToolCard } from '../ToolCard'
import { IconCheck, IconCircle, IconCircleDot, IconListTodo } from '../icons/ToolIcons'
import { formatJson } from '../../utils/format'
import type { ToolViewProps } from './shared'

export function TodoWriteView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
  if (!input || !Array.isArray(input.todos)) {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const todos = input.todos as Array<Record<string, unknown>>
  const counts = {
    completed: 0,
    in_progress: 0,
    pending: 0,
  } as Record<string, number>
  for (const t of todos) {
    const s = t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending'
    counts[s]++
  }
  const chips: ReactNode[] = []
  if (counts.in_progress > 0) chips.push(
    <span key="ip" className="tool-chip tool-chip-accent">{counts.in_progress} active</span>,
  )
  if (counts.pending > 0) chips.push(
    <span key="p" className="tool-chip">{counts.pending} pending</span>,
  )
  if (counts.completed > 0) chips.push(
    <span key="c" className="tool-chip tool-chip-success">{counts.completed} done</span>,
  )

  return (
    <ToolCard
      icon={<IconListTodo />}
      title="Todo list"
      chips={<>{chips}</>}
      toolUseId={toolUseId}
      className="tool-card-todo"
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    >
      <ul className="inline-todo-list">
        {todos.map((item, i) => {
          if (!item || typeof item !== 'object') return null
          const obj = item as Record<string, unknown>
          const content = typeof obj.content === 'string' ? obj.content : String(obj.content ?? '')
          const status = obj.status
          const cls =
            status === 'completed'
              ? 'inline-todo-completed'
              : status === 'in_progress'
                ? 'inline-todo-in_progress'
                : 'inline-todo-pending'
          const Icon =
            status === 'completed' ? IconCheck : status === 'in_progress' ? IconCircleDot : IconCircle
          return (
            <li key={i} className={`inline-todo-item ${cls}`}>
              <span className="inline-todo-icon" aria-hidden>
                <Icon size={12} />
              </span>
              <span className="inline-todo-text">
                <span className="inline-todo-text-shimmer">{content}</span>
              </span>
            </li>
          )
        })}
      </ul>
    </ToolCard>
  )
}
