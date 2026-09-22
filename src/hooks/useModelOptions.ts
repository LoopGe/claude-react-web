// Lazy-fetch the model options for a session, used by the ModelPicker
// dropdown in ChatPanel (and any other consumer that wants the same list).
//
// Thin React wrapper over `src/state/modelOptionsStore` — THE shared
// model/group snapshot. App's New-session dialog, ChatPanel's ModelPicker and
// SettingsPanel all read the same generation: one `/config` (or `/profiles`)
// fetch feeds everyone, and `crw-profiles-changed` invalidates once.
//
// We return a *structured* result rather than a flat string list so the
// picker can group and label entries:
//
//   - models: the server-configured modelList from /api/config (the custom
//       proxy models the user explicitly listed). We deliberately do NOT
//       merge in the SDK's supportedModels (/api/sessions/:id/models): the
//       gateway advertises extra models (e.g. *-omni) the user didn't ask
//       for, so the picker would show entries beyond the configured list.
//   - recents: localStorage models the user typed in NewSession before,
//       kept separate so the picker can show a "Recent" group and so the
//       list isn't empty while the API call is in flight / fails.
//
// Fetching is gated on `enabled`. ChatPanel only enables this when the
// picker is open, so we don't fire a request per open panel on every page
// load — and every open (enabled false → true) force-refetches through the
// store, so edits made in Settings → Profile while the picker was closed
// show up on the next open without a page reload. Concurrent opens share
// one in-flight request (store dedupe). During a refetch the previous
// result stays in the store, so the list doesn't flash empty.
//
// `sessionId` is kept for call-site compatibility but is NOT part of the
// fetch key: the list is a function of the profile, not the session. The
// store keys by `profileId` ('' = active profile).

import { useEffect, useState } from 'react'
import { readRecentModels } from '../utils/recent-models'
import {
  fetchModelOptions,
  peekModelOptions,
  subscribeModelOptions,
  type ModelOption,
  type ModelOptionsSnapshot,
} from '../state/modelOptionsStore'
import type { ModelGroupConfig } from '../types/config'

export type { ModelOption } from '../state/modelOptionsStore'

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

export function useModelOptions(_sessionId: string, enabled: boolean, profileId?: string): ModelOptions {
  // Bumped by the store whenever any fetch lands (or invalidate clears it) —
  // re-renders every consumer off the same generation. NOT a fetch dep of the
  // force-refresh effect: a notify→tick→force-fetch→notify loop would
  // stampede the API.
  const [tick, setTick] = useState(0)
  /** Last fetch RESULT for the current profileId. Needed when the store
   *  deliberately does not cache (missing pinned profile → ephemeral
   *  active-profile fallback): peek() stays null, but the picker must still
   *  show that fallback rather than an empty list. Dropped on every store
   *  notify (invalidate / new generation) so recovery can retry. */
  const [last, setLast] = useState<{ profileId?: string; snap: ModelOptionsSnapshot } | null>(null)
  useEffect(
    () =>
      subscribeModelOptions(() => {
        setTick((t) => t + 1)
        setLast(null)
      }),
    [],
  )

  // Open / profile switch → force refresh (picker reopen sees profile edits).
  // Concurrent consumers join the same in-flight request (store dedupe).
  useEffect(() => {
    if (!enabled) return
    void fetchModelOptions(profileId, { force: true })
      .then((snap) => setLast({ profileId, snap }))
      .catch(() => {
        // Failed — the picker shows only recents / the previous snapshot;
        // reopening (enabled false → true) retries.
      })
  }, [enabled, profileId])

  // Invalidate recovery (SettingsPanel path: enabled stays true, so there is
  // no open/close gesture). When the store drops the snapshot and we have no
  // ephemeral fallback either, pull again — without `force`, so a landing
  // fetch is not immediately re-requested.
  useEffect(() => {
    if (!enabled) return
    if (peekModelOptions(profileId)) return
    if (last && last.profileId === profileId) return
    void fetchModelOptions(profileId)
      .then((snap) => setLast({ profileId, snap }))
      .catch(() => {
        /* retried on next open / invalidate */
      })
  }, [enabled, profileId, tick, last])

  // Profile-scoped: while a switch is in flight, peek() for the NEW profile
  // is null (not the old profile's list). `last` is scoped the same way.
  const snap =
    peekModelOptions(profileId) ?? (last && last.profileId === profileId ? last.snap : null)
  const models = snap?.models ?? []
  const defaultModel = snap?.defaultModel
  const modelGroups = snap?.modelGroups ?? []

  // Reading localStorage every render is fine — it's synchronous and
  // microsecond-scale, and the picker only re-renders a handful of times
  // per second.
  const recents = readRecentModels()

  return { models, recents, defaultModel, modelGroups }
}
