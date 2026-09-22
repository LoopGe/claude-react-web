// Shared model / model-group snapshot for the whole app.
//
// Before this store, two independent fetchers kept two generations of the
// same data: App's `/config` pull fed `serverModels` + `modelGroups` (New
// session dialog) while `useModelOptions` pulled `/config` or `/profiles`
// again for ChatPanel's ModelPicker and SettingsPanel. A profile mutation
// refreshed one and not the other, so the dialog's model list and the
// picker's group list could disagree.
//
// Now there is ONE snapshot per fetch key:
//   - `''` (or undefined) → the active profile, from GET /config
//   - a profile id        → that pinned profile, from GET /profiles
//
// In-flight requests are deduped (two consumers asking at once share one
// promise). `invalidateModelOptions()` bumps a generation counter and drops
// every snapshot — a response from a pre-invalidate request is discarded on
// landing so it cannot clobber fresher data. Wired to `crw-profiles-changed`
// at the bottom so a profile mutation cannot leave a stale generation on any
// consumer.
//
// `force` refreshes past a *completed* cache entry but never wipes it first:
// consumers keep rendering the previous list until the new one lands (and
// keep it if the refetch fails). An in-flight request is always joined.
//
// Fetches are NOT aborted per-consumer: the request is shared, so a single
// unmount must not cancel it for the others.

import { api } from '../hooks/useApi'
import type { ConfigResponse, ModelGroupConfig } from '../types/config'
import { onProfilesChanged } from '../utils/profiles-events'

export interface ModelOption {
  id: string
  displayName?: string
}

export interface ModelOptionsSnapshot {
  models: ModelOption[]
  defaultModel?: string
  modelGroups: ModelGroupConfig[]
}

const EMPTY_SNAPSHOT: ModelOptionsSnapshot = { models: [], modelGroups: [] }

type Listener = () => void
const listeners = new Set<Listener>()

function notify(): void {
  for (const cb of [...listeners]) cb()
}

/** Subscribe to snapshot updates. Returns an unsubscribe function. */
export function subscribeModelOptions(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Cache key: '' = active profile (via /config), else a profile id. */
function keyOf(profileId?: string): string {
  return profileId ?? ''
}

interface Entry<T> {
  data: T | null
  promise: Promise<T> | null
}

/** Bumped by invalidateModelOptions() / markConfigStale(). In-flight handlers
 *  capture it and discard their result if it moved — a slow pre-invalidate
 *  response must not clobber the post-invalidate generation. */
let generation = 0
/** Generation the current /config in-flight was started at. A `force` call
 *  joins it only when both are the same generation (two pickers opening
 *  together want the same fresh body); a force after markConfigStale() sees
 *  a lower inflightGen and supersedes instead of joining a pre-mutation
 *  request. */
let inflightGen = -1

const configEntry: Entry<ConfigResponse> = { data: null, promise: null }
const byProfile = new Map<string, Entry<ModelOptionsSnapshot>>()

function entryFor(key: string): Entry<ModelOptionsSnapshot> {
  let e = byProfile.get(key)
  if (!e) {
    e = { data: null, promise: null }
    byProfile.set(key, e)
  }
  return e
}

function snapshotFromModelList(
  modelList: string[] | undefined,
  modelGroups: ModelGroupConfig[] | undefined,
): ModelOptionsSnapshot {
  const ids = modelList ?? []
  const seen = new Set<string>()
  const models: ModelOption[] = []
  for (const id of ids) {
    if (id && !seen.has(id)) {
      seen.add(id)
      models.push({ id })
    }
  }
  // The server's default is the first configured model — the same value
  // create() pins (config.defaultModel === modelList[0]).
  return { models, defaultModel: ids[0], modelGroups: modelGroups ?? [] }
}

/** Last successfully-fetched raw /config body, if any. */
export function peekConfig(): ConfigResponse | null {
  return configEntry.data
}

/** Last snapshot for `profileId` (default: active), or null if never fetched. */
export function peekModelOptions(profileId?: string): ModelOptionsSnapshot | null {
  return entryFor(keyOf(profileId)).data
}

/** Mark the cached /config body as stale WITHOUT dropping it (consumers keep
 *  rendering it until a fetch lands). Call before `fetchConfig({force})` when
 *  the caller knows the server changed (e.g. settings save) so the force does
 *  not join a still-in-flight pre-mutation request. */
export function markConfigStale(): void {
  generation += 1
}

/** Fetch (or join an in-flight) GET /config. `force` bypasses a completed
 *  cache entry. An in-flight request is joined when it belongs to the same
 *  generation (concurrent opens want one body) and superseded when the caller
 *  marked the cache stale (they need post-mutation data). The previous value
 *  stays readable until the new one lands. */
export function fetchConfig(opts?: { force?: boolean }): Promise<ConfigResponse> {
  if (configEntry.promise) {
    if (!opts?.force) return configEntry.promise
    if (inflightGen === generation) return configEntry.promise
    // Pre-stale in-flight: supersede it.
    generation += 1
  } else if (!opts?.force && configEntry.data) {
    return Promise.resolve(configEntry.data)
  }
  const gen = generation
  inflightGen = gen
  const self: { p: Promise<ConfigResponse> | null } = { p: null }
  self.p = api
    .get<ConfigResponse>('/config')
    .then((r) => {
      if (configEntry.promise === self.p) configEntry.promise = null
      if (gen !== generation) {
        // Stale: we refused to cache it — don't hand it to the caller either
        // (App's applyConfigResponse would write it over fresher state).
        return configEntry.promise ??
          (configEntry.data ? Promise.resolve(configEntry.data) : fetchConfig())
      }
      configEntry.data = r
      const active = entryFor('')
      active.data = snapshotFromModelList(r.models, r.modelGroups)
      notify()
      return r
    })
    .catch((err) => {
      if (configEntry.promise === self.p) configEntry.promise = null
      throw err
    })
  configEntry.promise = self.p
  return self.p
}

/** Fetch the model snapshot for `profileId` (default: active profile).
 *
 *  A missing / unreachable pinned profile falls back to the ACTIVE profile's
 *  list for this call only — it is NOT cached under the pinned key (that
 *  would poison every later peek of that profile and block recovery). */
export async function fetchModelOptions(
  profileId?: string,
  opts?: { force?: boolean },
): Promise<ModelOptionsSnapshot> {
  const key = keyOf(profileId)

  // Active profile: one shared /config fetch (also fills peekConfig).
  if (!key) {
    await fetchConfig(opts)
    return entryFor('').data ?? EMPTY_SNAPSHOT
  }

  const entry = entryFor(key)
  // Join in-flight only when the caller does not need post-mutation data.
  if (entry.promise && !opts?.force) return entry.promise
  if (!opts?.force && entry.data) return entry.data
  if (opts?.force) generation += 1 // supersede earlier in-flight

  const gen = generation
  const fallbackToActive = async (): Promise<ModelOptionsSnapshot> => {
    try {
      // No `force` on the fallback — we want the shared active snapshot,
      // not a second stampede.
      await fetchConfig()
      return entryFor('').data ?? EMPTY_SNAPSHOT
    } catch {
      return EMPTY_SNAPSHOT
    }
  }

  const p = (async (): Promise<ModelOptionsSnapshot> => {
    try {
      const r = await api.get<{
        profiles?: { id: string; modelList?: string[]; modelGroups?: ModelGroupConfig[] }[]
      }>('/profiles')
      if (gen !== generation) {
        // Stale: don't return the pre-invalidate body (and don't let
        // useModelOptions stash it as `last`, which would block recovery).
        return entryFor(key).data ?? EMPTY_SNAPSHOT
      }
      const profile = r.profiles?.find((x) => x.id === key)
      if (profile) {
        entry.data = snapshotFromModelList(profile.modelList, profile.modelGroups)
        notify()
        return entry.data
      }
      // Unknown profile: ephemeral fallback, not cached under `key`.
      return await fallbackToActive()
    } catch {
      if (gen !== generation) return entryFor(key).data ?? EMPTY_SNAPSHOT
      return await fallbackToActive()
    } finally {
      // Safe without an identity check: invalidateModelOptions() does
      // byProfile.clear(), so this `entry` is orphaned after a generation
      // bump and nulling it cannot clobber a newer fetch's promise.
      entry.promise = null
    }
  })()
  entry.promise = p
  return p
}

/** Drop every snapshot and notify — next fetch hits the network. In-flight
 *  responses from the previous generation are discarded on landing. */
export function invalidateModelOptions(): void {
  generation += 1
  configEntry.data = null
  configEntry.promise = null
  byProfile.clear()
  notify()
}

/** Test-only: hard reset (cache + subscribers + generation). */
export function resetModelOptionsStoreForTest(): void {
  generation += 1
  configEntry.data = null
  configEntry.promise = null
  byProfile.clear()
  listeners.clear()
}

// Profile mutations rewrite modelList / modelGroups. Invalidate before any
// consumer's own `crw-profiles-changed` handler refetches, so they all join
// one fresh generation instead of racing a stale cache.
onProfilesChanged(() => {
  invalidateModelOptions()
})
