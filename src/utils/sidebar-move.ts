// Move math shared by context-menu "Move up / Move down" actions. Pure so the
// callers (sidebar cards, the collapsed-sidebar nav strip) only wire the
// result into their reorder handlers.
//
// Mirrors SessionList's keyboard-reorder semantics: a session moves within
// its own section only — section boundaries are hard edges, and the rendered
// `sec.sessions` list is the sole authority (group.sessionIds can drift
// mid-deletion and must not be consulted).

import type { SidebarSection } from '../types'

export function sidebarMoveTarget(
  sections: SidebarSection[],
  id: string,
  direction: 'up' | 'down',
): { targetId: string; groupId?: string } | null {
  for (const sec of sections) {
    const idx = sec.sessions.findIndex((s) => s.id === id)
    if (idx < 0) continue
    const nextIdx = direction === 'up' ? idx - 1 : idx + 1
    if (nextIdx < 0 || nextIdx >= sec.sessions.length) return null
    return {
      targetId: sec.sessions[nextIdx].id,
      ...(sec.kind === 'group' ? { groupId: sec.group.id } : {}),
    }
  }
  return null
}
