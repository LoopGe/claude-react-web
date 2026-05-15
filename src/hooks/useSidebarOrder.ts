// Sidebar session ordering: user-defined drag-and-drop order persisted
// in localStorage, with server-side lastActivityAt as fallback.

import { useCallback, useMemo } from 'react'
import { useLocalStorage } from './useLocalStorage'
import { SIDEBAR_ORDER_KEY } from '../constants/storageKeys'
import type { SessionInfo } from '../types'

export interface UseSidebarOrderResult {
  sidebarOrder: string[]
  setSidebarOrder: (v: string[] | ((prev: string[]) => string[])) => void
  orderedSessions: SessionInfo[]
  handleReorderSidebar: (draggedId: string, targetId: string, position: 'before' | 'after') => void
}

export function useSidebarOrder(sessions: SessionInfo[]): UseSidebarOrderResult {
  const [sidebarOrder, setSidebarOrder] = useLocalStorage<string[]>(SIDEBAR_ORDER_KEY, [])

  /** Final sidebar order: sidebarOrder[] wins for ids it contains; anything
   *  not listed falls back to the server's lastActivityAt sort. */
  const orderedSessions = useMemo(() => {
    const byId = new Map(sessions.map((s) => [s.id, s]))
    const ordered: SessionInfo[] = []
    const seen = new Set<string>()
    for (const id of sidebarOrder) {
      const s = byId.get(id)
      if (s) {
        ordered.push(s)
        seen.add(id)
      }
    }
    for (const s of sessions) if (!seen.has(s.id)) ordered.push(s)
    return ordered
  }, [sessions, sidebarOrder])

  const handleReorderSidebar = useCallback(
    (draggedId: string, targetId: string, position: 'before' | 'after') => {
      if (draggedId === targetId) return
      const currentIds = orderedSessions.map((s) => s.id)
      const without = currentIds.filter((id) => id !== draggedId)
      const targetIdx = without.indexOf(targetId)
      if (targetIdx < 0) return
      const insertAt = position === 'before' ? targetIdx : targetIdx + 1
      without.splice(insertAt, 0, draggedId)
      setSidebarOrder(without)
    },
    [orderedSessions, setSidebarOrder],
  )

  return { sidebarOrder, setSidebarOrder, orderedSessions, handleReorderSidebar }
}
