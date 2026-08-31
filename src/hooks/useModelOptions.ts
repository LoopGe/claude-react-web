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
// load — and every open (enabled false → true) refetches, so edits made in
// Settings → Profile while the picker was closed show up on the next open
// without a page reload. The /config call is cheap (small JSON, same-origin).
// During a refetch the previous result stays in state, so the list doesn't
// flash empty.
//
// For always-enabled consumers (SettingsPanel passes a constant `true`)
// there is no open/close gesture to refetch on — those are covered by the
// `crw-profiles-changed` window event that useProfiles emits after every
// successful mutation: it bumps `profilesTick`, which re-runs the effect
// and refetches.

import { useEffect, useState } from 'react'
import { api } from './useApi'
import { readRecentModels } from '../utils/recent-models'
import { onProfilesChanged } from '../utils/profiles-events'
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
  /** Server-derived list. Empty until the first fetch resolves. We tag it
   *  with the full fetch identity (sessionId AND profileId) so a parent
   *  that swaps either without remounting won't briefly show the previous
   *  session's / profile's list while the new fetch is in flight. */
  const [data, setData] = useState<{
    sessionId: string
    profileId?: string
    models: ModelOption[]
    defaultModel?: string
    modelGroups: ModelGroupConfig[]
  } | null>(null)
  /** Bumped when another part of the app mutates profiles (Settings →
   *  Profile edits) — the invalidation signal for always-enabled
   *  consumers like SettingsPanel, which have no open/close gesture to
   *  piggyback a refetch on. */
  const [profilesTick, setProfilesTick] = useState(0)

  useEffect(() => onProfilesChanged(() => setProfilesTick((t) => t + 1)), [])

  useEffect(() => {
    if (!enabled) return
    const ac = new AbortController()
    ;(async () => {
      let cfg: { models?: string[]; modelGroups?: ModelGroupConfig[] } | null = null

      // When the session is pinned to a profile, resolve models from
      // that profile.  Fall through to /config when the profile is not
      // found or the /profiles call fails.
      if (profileId) {
        try {
          const data = await api.get<{ profiles: { id: string; modelList: string[]; modelGroups: ModelGroupConfig[] }[] }>('/profiles', { signal: ac.signal })
          if (ac.signal.aborted) return
          const profile = data.profiles?.find((p) => p.id === profileId)
          if (profile) {
            cfg = { models: profile.modelList, modelGroups: profile.modelGroups }
          }
        } catch {
          if (ac.signal.aborted) return
          // Fall through to /config below.
        }
      }

      // Fallback: active profile via /config (no profileId, or profile
      // not found / fetch failed above).
      if (!cfg) {
        try {
          cfg = await api.get<{ models?: string[]; modelGroups?: ModelGroupConfig[] }>('/config', { signal: ac.signal })
        } catch {
          if (ac.signal.aborted) return
          // Failed — the picker shows only recents; reopening (enabled
          // false → true) retries the fetch naturally.
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

      setData({ sessionId, profileId, models: merged, defaultModel, modelGroups: cfg.modelGroups ?? [] })
    })()
    return () => { ac.abort() }
  }, [sessionId, enabled, profileId, profilesTick])

  // Only use server-derived models when they match the full fetch identity
  // — both the session and the profile it's pinned to. Guards against
  // showing stale data if the parent reuses this hook instance across a
  // sessionId or profileId change (ChatPanel doesn't, but other call sites
  // might): while the refetch for the new identity is in flight (or if it
  // fails), the old identity's list must not render as if it were current.
  const fresh = data && data.sessionId === sessionId && data.profileId === profileId ? data : null
  const models = fresh ? fresh.models : []
  const defaultModel = fresh?.defaultModel
  const modelGroups = fresh ? fresh.modelGroups : []

  // Reading localStorage every render is fine — it's synchronous and
  // microsecond-scale, and the picker only re-renders a handful of times
  // per second.
  const recents = readRecentModels()

  return { models, recents, defaultModel, modelGroups }
}
