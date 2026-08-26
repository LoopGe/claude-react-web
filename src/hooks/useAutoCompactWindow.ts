// Shared POST path for setting / clearing a session's auto-compact window,
// used by both the chat-bar ContextBar and the SettingsPanel Context tab.
// The marker (ContextBar) owns the %→tokens inversion; this hook only ships
// the absolute token count (or null = reset to auto) to the server and
// propagates the returned SessionInfo.

import { useCallback } from 'react'
import type { SessionInfo } from '../types'
import { api } from './useApi'
import { useToast } from './useToast'

export function useAutoCompactWindow(
  session: SessionInfo,
  onSessionUpdate: (s: SessionInfo) => void,
) {
  const toast = useToast()

  const commitWindow = useCallback(
    async (windowTokens: number | null) => {
      try {
        const r = await api.post<{ session: SessionInfo }>(
          `/sessions/${session.id}/auto-compact-window`,
          { window: windowTokens },
        )
        onSessionUpdate(r.session)
      } catch (e) {
        toast.error(`Couldn't update auto-compact window: ${(e as Error).message}`)
      }
    },
    [session.id, onSessionUpdate, toast],
  )

  return { commitWindow }
}
