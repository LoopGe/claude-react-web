// Lazy-fetch the model options for a session, used by the ModelPicker
// dropdown in ChatPanel (and any other consumer that wants the same list).
//
// We return a *structured* result rather than a flat string list so the
// picker can group and label entries:
//
//   - models: the server-configured modelList from /api/config (the custom
//       proxy models the user explicitly listed). We deliberately do NOT
//       merge in the SDK's supportedModels (/api/sessions/:id/models): the
//       gateway advertises extra models (e.g. *-omni) the user didn't ask
//       for, so the picker would show entries beyond the configured list.
//       Only the user's own config drives the dropdown.
//   - recents: localStorage models the user type in NewSession before,
//       kept separate so the picker can show a "Recent" group and so the
//       list isn't empty while the API call is in flight / fails.
//
// Fetching is gated on `enabled`. ChatPanel only enables this when the
// picker is open, so we don't fire a request per open panel on every page
// load. After the first successful fetch the result is kept in state for
// the lifetime of the hook instance. The /config call is so cheap (small
// JSON, same-origin) that one hit per opened panel isn't worth a cache.

import { useEffect, useRef, useState } from 'react'
import { api } from './useApi'
import { readRecentModels } from '../utils/recent-models'
import type { ModelGroupConfig } from '../types/config'

export interface ModelOption {
  id: string
  displayName?: string
}

export interface ModelOptions {
  /** The user's configured modelList (config.modelList), in order. */
  models: ModelOption[]
  /** Recent model ids from localStorage (raw strings). */
  recents: string[]
  /** The server-side default model id (config.modelList[0]) — the same
   *  value the server pins when a session is created without an explicit
   *  model. Used by the picker to mark the default as selected for a
   *  session whose model is still empty. Undefined until /config resolves. */
  defaultModel?: string
  /** The user's configured ModelGroups (config.modelGroups), in order. */
  modelGroups: ModelGroupConfig[]
}

export function useModelOptions(sessionId: string, enabled: boolean, profileId?: string): ModelOptions {
  /** Server-derived list (SDK ∪ config). Empty until the first fetch
   *  resolves. We tag it with the sessionId it was fetched for so a
   *  parent that swaps sessions without remounting won't briefly show
   *  the previous session's list. */
  const [data, setData] = useState<{
    sessionId: string
    models: ModelOption[]
    defaultModel?: string
    modelGroups: ModelGroupConfig[]
  } | null>(null)
  /** Sentinel for "already fetched (or in-flight) for this sessionId".
   *  A ref rather than state so successful fetches don't cascade-render
   *  the component a second time after the data state update. */
  const fetchedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    // Include profileId in the cache key so a profile switch on the same
    // session triggers a fresh fetch.
    const fetchKey = profileId ? `${sessionId}:${profileId}` : sessionId
    if (fetchedRef.current === fetchKey) return
    fetchedRef.current = fetchKey
    const ac = new AbortController()
    ;(async () => {
      let cfg: { models?: string[]; modelGroups?: ModelGroupConfig[] }

      // When the session is pinned to a profile, resolve models from
      // that profile instead of the global /config.
      if (profileId) {
        try {
          const data = await api.get<{ profiles: { id: string; modelList: string[]; modelGroups: ModelGroupConfig[] }[] }>('/profiles', { signal: ac.signal })
          if (ac.signal.aborted) return
          const profile = data.profiles?.find((p) => p.id === profileId)
          if (profile) {
            cfg = { models: profile.modelList, modelGroups: profile.modelGroups }
          } else {
            // Profile not found — fall through to /config.
            fetchedRef.current = null
            return
          }
        } catch {
          if (ac.signal.aborted) return
          fetchedRef.current = null
          return
        }
      } else {
        try {
          cfg = await api.get<{ models?: string[]; modelGroups?: ModelGroupConfig[] }>('/config', { signal: ac.signal })
        } catch {
          if (ac.signal.aborted) return
          // Leave fetchedRef cleared so a subsequent open of the picker
          // retries rather than showing only recents forever.
          fetchedRef.current = null
          return
        }
        if (ac.signal.aborted) return
      }

      const cfgIds = cfg.models ?? []
      // The server's default is the first configured model — the same value
      // create() pins (config.defaultModel === modelList[0]). Capture it so
      // the picker can mark it selected for a not-yet-set session.
      const defaultModel = cfgIds[0]

      // Only the user's configured models, deduped by id, in order.
      const seen = new Set<string>()
      const merged: ModelOption[] = []
      for (const id of cfgIds) {
        if (id && !seen.has(id)) {
          seen.add(id)
          merged.push({ id })
        }
      }

      setData({ sessionId, models: merged, defaultModel, modelGroups: cfg.modelGroups ?? [] })
    })()
    return () => { ac.abort() }
  }, [sessionId, enabled, profileId])

  // Only use server-derived models when they belong to the current
  // session — guards against showing stale data if the parent reuses
  // this hook instance across sessionId changes (ChatPanel doesn't, but
  // other call sites might).
  const fresh = data && data.sessionId === sessionId ? data : null
  const models = fresh ? fresh.models : []
  const defaultModel = fresh?.defaultModel
  const modelGroups = fresh ? fresh.modelGroups : []

  // Reading localStorage every render is fine — it's synchronous and
  // microsecond-scale, and the picker only re-renders a handful of times
  // per second.
  const recents = readRecentModels()

  return { models, recents, defaultModel, modelGroups }
}
