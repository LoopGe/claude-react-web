// Provider-profile resolution + validation. Pure functions, no import of the
// live `config` singleton (config.ts imports these, never the reverse — the
// only imports here from config.ts are TYPE-only, erased at runtime).

import type { ModelGroupConfig, ProviderProfile } from './config.js'
import { createLogger } from './log.js'

const log = createLogger('profiles')

/** The six legacy top-level credential/model fields migrated into profiles[0]. */
export interface LegacyProfileFields {
  authToken?: string
  baseUrl?: string
  modelList?: string[]
  modelGroups?: ModelGroupConfig[]
  recapModel?: string
  commitMessageModel?: string
}

/** modelList[0], or '' for an empty list. */
export function profileDefaultModel(profile: ProviderProfile): string {
  return profile.modelList[0] ?? ''
}

export function findProfile(
  profiles: readonly ProviderProfile[],
  id: string | undefined,
): ProviderProfile | undefined {
  if (!id) return undefined
  return profiles.find((p) => p.id === id)
}

/** Never throws: empty profiles / dangling id fall back to profiles[0], then
 *  to the caller-supplied synthetic fallback (DEFAULTS-derived). */
export function resolveActiveProfile(
  profiles: readonly ProviderProfile[],
  activeProfileId: string | undefined,
  fallback: ProviderProfile,
): ProviderProfile {
  if (profiles.length === 0) return fallback
  return findProfile(profiles, activeProfileId) ?? profiles[0]
}

/** Mask a token for the wire: '****' + last 4 chars. Undefined for blank. */
export function maskToken(token: string | undefined): string | undefined {
  if (!token) return undefined
  return '****' + token.slice(-4)
}

/** Validate model groups exactly as the legacy config loader did: a malformed
 *  entry is dropped with a warning, duplicate ids keep the last entry, and
 *  groups with zero tier slots are dropped. */
export function coerceModelGroups(raw: unknown): ModelGroupConfig[] {
  if (!Array.isArray(raw)) return []
  const byId = new Map<string, ModelGroupConfig>()
  for (const g of raw) {
    if (typeof g !== 'object' || g === null || Array.isArray(g)) {
      log.warn('dropping malformed model group (not an object)')
      continue
    }
    const entry = g as Record<string, unknown>
    const { id, name, main } = entry
    if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim()) {
      log.warn('dropping model group with a missing/blank id or name')
      continue
    }
    if (main !== undefined && main !== 'opus' && main !== 'sonnet' && main !== 'haiku') {
      log.warn(`dropping model group ${id}: main must be one of opus|sonnet|haiku`)
      continue
    }
    let slotOk = true
    for (const slot of ['opus', 'sonnet', 'haiku'] as const) {
      const v = entry[slot]
      if (v !== undefined && typeof v !== 'string') {
        log.warn(`dropping model group ${id}: slot ${slot} must be a string`)
        slotOk = false
        break
      }
    }
    if (!slotOk) continue
    const out: ModelGroupConfig = { id: id.trim(), name: name.trim() }
    for (const slot of ['opus', 'sonnet', 'haiku'] as const) {
      const v = entry[slot]
      if (typeof v === 'string' && v.trim()) out[slot] = v.trim()
    }
    if (main !== undefined) out.main = main as 'opus' | 'sonnet' | 'haiku'
    if (!out.opus && !out.sonnet && !out.haiku) {
      log.warn(`dropping model group ${id}: no tier slots`)
      continue
    }
    byId.set(out.id, out)
  }
  return [...byId.values()]
}

/** The coercion's id normalization, exposed so writers can match exactly the
 *  entries the reader resolves — a raw string compare misses a padded id. */
export function normalizeProfileId(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

/** Sanitize a configured model list: keep only non-blank string ids, falling
 *  back to `fallback` when nothing usable survives.
 *
 *  Deciding on the FILTERED result rather than the raw array's length is the
 *  whole point: a stored all-blank list (['']) has length > 0 but yields
 *  nothing, and `modelList: []` then reads as "unset" everywhere downstream
 *  (`config.defaultModel` becomes '', and the session-planning paths lose the
 *  user's gateway ids). This is the ONE definition of that rule — every reader
 *  and writer of the field goes through it, so they cannot drift apart. */
export function normalizeModelList(raw: unknown, fallback: readonly string[]): string[] {
  const kept = Array.isArray(raw)
    ? raw.filter((m): m is string => typeof m === 'string' && !!m.trim()).map((m) => m.trim())
    : []
  return kept.length > 0 ? kept : [...fallback]
}

/** A coerced profile paired with the index it came from in the RAW (untrusted)
 *  array. Callers that WRITE a profile back need this: the reader resolves the
 *  active profile out of `coerceProfiles`, and only the raw index identifies
 *  the same entry on disk once malformed entries have been dropped and ids
 *  have been trimmed. */
export interface CoercedProfileEntry {
  profile: ProviderProfile
  index: number
}

/** Narrow untrusted JSON into ProviderProfile[], keeping each surviving
 *  entry's raw index. Malformed entries are dropped (never blocks config
 *  load); missing scalar fields fall back to the synthetic fallback; a blank
 *  authToken is allowed (matches the unset-token starter state — the server
 *  still refuses to spawn without one).
 *
 *  `coerceProfiles` is this function's projection, so the normalization is
 *  defined exactly once: trimmed ids, last-wins on a duplicate id, malformed
 *  entries dropped. A writer that re-derives any of that by hand will disagree
 *  with the reader about which entry is which. */
export function coerceProfileEntries(raw: unknown, fallback: ProviderProfile): CoercedProfileEntry[] {
  if (!Array.isArray(raw)) return []
  const byId = new Map<string, CoercedProfileEntry>()
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index]
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      log.warn('dropping malformed profile (not an object)')
      continue
    }
    const e = entry as Record<string, unknown>
    const id = normalizeProfileId(e.id)
    const name = typeof e.name === 'string' ? e.name.trim() : ''
    if (!id || !name) {
      log.warn('dropping profile with a missing/blank id or name')
      continue
    }
    const baseUrl = typeof e.baseUrl === 'string' && e.baseUrl.trim()
      ? e.baseUrl.trim().replace(/\/+$/, '')
      : fallback.baseUrl
    const modelList = normalizeModelList(e.modelList, fallback.modelList)
    const recapModel = typeof e.recapModel === 'string' && e.recapModel.trim()
      ? e.recapModel.trim() : fallback.recapModel
    const commitMessageModel = typeof e.commitMessageModel === 'string' && e.commitMessageModel.trim()
      ? e.commitMessageModel.trim() : fallback.commitMessageModel
    const authToken = typeof e.authToken === 'string' ? e.authToken.trim() : ''
    byId.set(id, {
      index,
      profile: {
        id, name, authToken, baseUrl, modelList,
        modelGroups: coerceModelGroups(e.modelGroups),
        recapModel, commitMessageModel,
      },
    })
  }
  return [...byId.values()]
}

/** `coerceProfileEntries` without the raw indices — the reader's view. */
export function coerceProfiles(raw: unknown, fallback: ProviderProfile): ProviderProfile[] {
  return coerceProfileEntries(raw, fallback).map((entry) => entry.profile)
}

/** Build a ProviderProfile from the six legacy top-level fields (migration
 *  helper). Missing fields fall back to the synthetic fallback. */
export function profileFromLegacyFields(
  f: LegacyProfileFields,
  fallback: ProviderProfile,
): ProviderProfile {
  return {
    id: 'default',
    name: 'Default',
    authToken: typeof f.authToken === 'string' ? f.authToken.trim() : '',
    baseUrl: typeof f.baseUrl === 'string' && f.baseUrl.trim()
      ? f.baseUrl.trim().replace(/\/+$/, '') : fallback.baseUrl,
    modelList: normalizeModelList(f.modelList, fallback.modelList),
    modelGroups: Array.isArray(f.modelGroups) ? coerceModelGroups(f.modelGroups) : [...fallback.modelGroups],
    recapModel: typeof f.recapModel === 'string' && f.recapModel.trim()
      ? f.recapModel.trim() : fallback.recapModel,
    commitMessageModel: typeof f.commitMessageModel === 'string' && f.commitMessageModel.trim()
      ? f.commitMessageModel.trim() : fallback.commitMessageModel,
  }
}
