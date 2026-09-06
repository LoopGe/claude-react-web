import { useCallback, useEffect, useState } from 'react'
import { api } from './useApi'
import type { StoredAgentDefinition } from '../types'

export interface UseAgentDefinitionsResult {
  agents: StoredAgentDefinition[]
  error: string | null
  refresh: () => Promise<void>
  toggleEnabled: (name: string, enabled: boolean) => Promise<void>
  remove: (name: string) => Promise<void>
}

export function useAgentDefinitions(): UseAgentDefinitionsResult {
  const [agents, setAgents] = useState<StoredAgentDefinition[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ agents: StoredAgentDefinition[] }>('/agent-definitions')
      setAgents(r.agents ?? [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    // setAgents happens after `await` (async fetch), never synchronously —
    // the rule's cascading-render concern doesn't apply to this fetch-on-mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  const toggleEnabled = useCallback(
    async (name: string, enabled: boolean) => {
      const def = agents.find((a) => a.name === name)
      if (!def) return
      await api.put<{ agent: StoredAgentDefinition }>(
        `/agent-definitions/${encodeURIComponent(name)}`,
        { data: { enabled } },
      )
      await refresh()
    },
    [agents, refresh],
  )

  const remove = useCallback(
    async (name: string) => {
      await api.delete(`/agent-definitions/${encodeURIComponent(name)}`)
      await refresh()
    },
    [refresh],
  )

  return { agents, error, refresh, toggleEnabled, remove }
}
