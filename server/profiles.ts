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

/** Narrow untrusted JSON into a ProviderProfile[]. Malformed entries are
 *  dropped (never blocks config load); missing scalar fields fall back to the
 *  synthetic fallback; a blank authToken is allowed (matches the unset-token
 *  starter state — the server still refuses to spawn without one). */
export function coerceProfiles(raw: unknown, fallback: ProviderProfile): ProviderProfile[] {
  if (!Array.isArray(raw)) return []
  const byId = new Map<string, ProviderProfile>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      log.warn('dropping malformed profile (not an object)')
      continue
    }
    const e = entry as Record<string, unknown>
    const id = typeof e.id === 'string' ? e.id.trim() : ''
    const name = typeof e.name === 'string' ? e.name.trim() : ''
    if (!id || !name) {
      log.warn('dropping profile with a missing/blank id or name')
      continue
    }
    const baseUrl = typeof e.baseUrl === 'string' && e.baseUrl.trim()
      ? e.baseUrl.trim().replace(/\/+$/, '')
      : fallback.baseUrl
    const modelList = Array.isArray(e.modelList) && e.modelList.length > 0
      ? (e.modelList as unknown[]).filter((m): m is string => typeof m === 'string' && !!m.trim())
      : [...fallback.modelList]
    const recapModel = typeof e.recapModel === 'string' && e.recapModel.trim()
      ? e.recapModel.trim() : fallback.recapModel
    const commitMessageModel = typeof e.commitMessageModel === 'string' && e.commitMessageModel.trim()
      ? e.commitMessageModel.trim() : fallback.commitMessageModel
    const authToken = typeof e.authToken === 'string' ? e.authToken.trim() : ''
    byId.set(id, {
      id, name, authToken, baseUrl, modelList,
      modelGroups: coerceModelGroups(e.modelGroups),
      recapModel, commitMessageModel,
    })
  }
  return [...byId.values()]
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
    modelList: Array.isArray(f.modelList) && f.modelList.length > 0
      ? f.modelList.filter((m) => typeof m === 'string' && m.trim())
      : [...fallback.modelList],
    modelGroups: Array.isArray(f.modelGroups) ? coerceModelGroups(f.modelGroups) : [...fallback.modelGroups],
    recapModel: typeof f.recapModel === 'string' && f.recapModel.trim()
      ? f.recapModel.trim() : fallback.recapModel,
    commitMessageModel: typeof f.commitMessageModel === 'string' && f.commitMessageModel.trim()
      ? f.commitMessageModel.trim() : fallback.commitMessageModel,
  }
}
