// Provider-profile CRUD + activation. All writes serialize through the config
// write queue (queueConfigWrite) because profiles is a nested array needing
// read-modify-write semantics — never a blind PUT /config.

import { Hono } from 'hono'
import { HttpError } from '../errors.js'
import { safeJson } from './index.js'
import {
  config as serverConfig, DEFAULT_PROFILE, loadConfig, queueConfigWrite,
} from '../config.js'
import { coerceProfileEntries, maskToken, normalizeModelList, normalizeProfileId } from '../profiles.js'
import { createLogger } from '../log.js'
import type { SessionManager } from '../session-manager.js'

const log = createLogger('profiles')

/** A raw profile entry's normalized id — '' for a malformed entry. */
function profileEntryId(entry: unknown): string {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return ''
  return normalizeProfileId((entry as { id?: unknown }).id)
}

function toWire(profiles: readonly unknown[], activeProfileId: string) {
  return {
    profiles: profiles.map((p) => {
      const raw = p as Record<string, unknown>
      return {
        id: raw.id,
        name: raw.name,
        authTokenMasked: maskToken(typeof raw.authToken === 'string' ? raw.authToken : undefined),
        baseUrl: raw.baseUrl,
        modelList: raw.modelList,
        modelGroups: raw.modelGroups ?? [],
        recapModel: raw.recapModel,
        commitMessageModel: raw.commitMessageModel,
        isActive: raw.id === activeProfileId,
      }
    }),
    activeProfileId,
  }
}

export function buildProfilesRouter(configDir?: string, sm?: SessionManager): Hono {
  const app = new Hono()

  app.get('/profiles', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const profiles = serverConfig.profiles
    return c.json(toWire(profiles as unknown[], serverConfig.activeProfileId))
  })

  app.post('/profiles', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const body = await safeJson<{
      name?: string; authToken?: string; baseUrl?: string; modelList?: string[];
      modelGroups?: unknown[]; recapModel?: string; commitMessageModel?: string
    }>(c.req)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) throw new HttpError(400, 'name is required')
    const active = serverConfig.profiles.find((p) => p.id === serverConfig.activeProfileId) ?? serverConfig.profiles[0]
    const id = 'p_' + Math.random().toString(36).slice(2, 10)
    const created: Record<string, unknown> = {
      id,
      name,
      authToken: typeof body.authToken === 'string' ? body.authToken.trim() : '',
      baseUrl: typeof body.baseUrl === 'string' && body.baseUrl.trim()
        ? body.baseUrl.trim().replace(/\/+$/, '') : active?.baseUrl ?? DEFAULT_PROFILE.baseUrl,
      modelList: normalizeModelList(body.modelList, active?.modelList ?? DEFAULT_PROFILE.modelList),
      modelGroups: Array.isArray(body.modelGroups) ? body.modelGroups : active?.modelGroups ?? DEFAULT_PROFILE.modelGroups,
      // An explicitly-sent value wins on create too — including '' and null
      // ("unset", the same rule PUT /profiles/:id applies, since the settings
      // tab sends `value || null`). Only an ABSENT field templates from the
      // active profile.
      recapModel: typeof body.recapModel === 'string' || body.recapModel === null
        ? (typeof body.recapModel === 'string' ? body.recapModel.trim() : '')
        : active?.recapModel ?? DEFAULT_PROFILE.recapModel,
      commitMessageModel: typeof body.commitMessageModel === 'string' || body.commitMessageModel === null
        ? (typeof body.commitMessageModel === 'string' ? body.commitMessageModel.trim() : '')
        : active?.commitMessageModel ?? DEFAULT_PROFILE.commitMessageModel,
    }
    await queueConfigWrite(configDir, (existing) => {
      const profiles = Array.isArray(existing.profiles) ? existing.profiles : []
      existing.profiles = [...profiles, created]
    })
    await loadConfig(configDir)
    log.info(`profile created id=${id} name=${name}`)
    return c.json({ profile: toWire([created], serverConfig.activeProfileId).profiles[0] }, 201)
  })

  app.put('/profiles/:id', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const id = c.req.param('id')
    const body = await safeJson<Record<string, unknown>>(c.req)
    await queueConfigWrite(configDir, (existing) => {
      const profiles = Array.isArray(existing.profiles) ? existing.profiles : []
      // Resolve through the coercion, exactly as the reader does. Ids are trimmed
      // and deduped (last one wins) there, so comparing the RAW id string by hand
      // misses a stored ' p_two ' — a 404 for a profile GET /profiles happily
      // lists — and picks the FIRST of two duplicates while the reader uses the
      // last, so the save lands on the profile nobody reads.
      const hit = coerceProfileEntries(existing.profiles, DEFAULT_PROFILE).find((e) => e.profile.id === id)
      // Propagates out through queueConfigWrite's returned promise (the queue itself
      // stays unpoisoned), so the handler never reaches a stale-success path.
      if (!hit) throw new HttpError(404, `profile ${id} not found`)
      const idx = hit.index
      const prev = profiles[idx] as Record<string, unknown>
      const next: Record<string, unknown> = { ...prev }
      // Every field the card can send is either applied or REJECTED — never
      // silently ignored. A blank name / Base URL / empty model list is an
      // invalid profile (a blank name is dropped by coerceProfiles, an empty
      // baseUrl would fall back to the public API and spend this profile's key
      // there, and modelList[0] is the session's default model), so the card
      // gets an error instead of staying "cleared" while the server keeps the
      // old value. This mirrors POST /profiles, which already 400s on a blank
      // name.
      if (body.name !== undefined) {
        if (typeof body.name !== 'string' || !body.name.trim()) {
          throw new HttpError(400, 'name is required')
        }
        next.name = body.name.trim()
      }
      // authToken only written when non-empty (empty/absent = keep existing).
      if (typeof body.authToken === 'string' && body.authToken.trim()) next.authToken = body.authToken.trim()
      if (body.baseUrl !== undefined) {
        if (typeof body.baseUrl !== 'string' || !body.baseUrl.trim()) {
          throw new HttpError(400, 'Base URL is required')
        }
        next.baseUrl = body.baseUrl.trim().replace(/\/+$/, '')
      }
      if (body.modelList !== undefined) {
        const list = normalizeModelList(body.modelList, [])
        if (list.length === 0) throw new HttpError(400, 'a profile needs at least one model')
        next.modelList = list
      }
      // modelGroups is the one collection that CAN be empty, so null clears it
      // (the card sends null when its local group list is empty).
      if (body.modelGroups === null) next.modelGroups = []
      else if (Array.isArray(body.modelGroups)) next.modelGroups = body.modelGroups
      // An explicitly-supplied recap/commit model replaces the stored one —
      // including the CLEAR case. `null` (which the UI sends for its
      // "(default)" option) and `''` both mean "unset = use the session's own
      // model"; skipping null instead would silently keep the previous model
      // and make "(default)" a no-op that still spends on the old one.
      if (body.recapModel === null || typeof body.recapModel === 'string') {
        next.recapModel = typeof body.recapModel === 'string' ? body.recapModel.trim() : ''
      }
      if (body.commitMessageModel === null || typeof body.commitMessageModel === 'string') {
        next.commitMessageModel = typeof body.commitMessageModel === 'string' ? body.commitMessageModel.trim() : ''
      }
      profiles[idx] = next
      existing.profiles = profiles
    })
    await loadConfig(configDir)
    log.info(`profile updated id=${id}`)
    return c.json({ ok: true })
  })

  app.delete('/profiles/:id', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const id = c.req.param('id')
    if (id === serverConfig.activeProfileId) {
      throw new HttpError(400, 'cannot delete the active profile — switch active first')
    }
    if (serverConfig.profiles.length <= 1) {
      throw new HttpError(400, 'cannot delete the last remaining profile')
    }
    await queueConfigWrite(configDir, (existing) => {
      // Drop EVERY raw entry that normalizes to this id. Matching raw strings
      // misses a stored ' p_two ' (answering ok while the profile survives every
      // refresh), and removing only the winning index would leave a SHADOWED
      // duplicate behind — the id would still resolve, so the delete would report
      // success and the profile would still be listed.
      const raw = Array.isArray(existing.profiles) ? existing.profiles : []
      existing.profiles = raw.filter((p) => profileEntryId(p) !== id)
    })
    await loadConfig(configDir)
    log.info(`profile deleted id=${id}`)
    return c.json({ ok: true })
  })

  app.post('/profiles/activate', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const body = await safeJson<{ profileId?: string; restartSessions?: unknown }>(c.req)
    const profileId = body.profileId
    if (typeof profileId !== 'string' || !serverConfig.profiles.some((p) => p.id === profileId)) {
      throw new HttpError(400, `profile ${profileId} not found`)
    }
    // Optional list of live sessions to restart into the newly-active profile.
    // Sessions following global (empty profileId) re-resolve the active profile
    // at respawn, so `sm.restart` picks up the change immediately. A busy /
    // just-died session is skipped, never fatal to the activation as a whole.
    const restartSessions = Array.isArray(body.restartSessions)
      ? body.restartSessions.filter((s): s is string => typeof s === 'string')
      : []
    await queueConfigWrite(configDir, (existing) => {
      existing.activeProfileId = profileId
    })
    await loadConfig(configDir)
    const restarted: string[] = []
    const skipped: string[] = []
    if (sm) {
      for (const id of restartSessions) {
        try {
          await sm.restart(id)
          restarted.push(id)
        } catch (e) {
          skipped.push(id)
          log.warn(`[profiles] restart session ${id} skipped: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
    log.info(`active profile switched to id=${profileId}`)
    return c.json({ ok: true, activeProfileId: serverConfig.activeProfileId, restarted, skipped })
  })

  app.post('/profiles/:id/test', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const id = c.req.param('id')
    const profile = serverConfig.profiles.find((p) => p.id === id)
    if (!profile) throw new HttpError(404, `profile ${id} not found`)
    // Accept optional overrides so the client can test a dirty/unsaved token.
    let body: { authToken?: unknown; baseUrl?: unknown; model?: unknown } = {}
    try { body = await c.req.json() } catch { /* empty body is fine */ }
    if (body.authToken !== undefined && typeof body.authToken !== 'string') {
      throw new HttpError(400, 'authToken must be a string')
    }
    if (body.baseUrl !== undefined && typeof body.baseUrl !== 'string') {
      throw new HttpError(400, 'baseUrl must be a string')
    }
    if (body.model !== undefined && body.model !== null && typeof body.model !== 'string') {
      throw new HttpError(400, 'model must be a string or null')
    }
    const authToken = (typeof body.authToken === 'string' && body.authToken.trim())
      ? body.authToken.trim()
      : profile.authToken
    const baseUrl = (typeof body.baseUrl === 'string' && body.baseUrl.trim())
      ? body.baseUrl.trim().replace(/\/+$/, '')
      : profile.baseUrl
    if (!authToken) throw new HttpError(400, 'No auth token to test — save one first')
    // Which model to probe:
    //   - a non-empty `model` → that one (the Profile card sends its edited
    //     list's first entry, so a dirty list is what gets tested);
    //   - an explicit '' / null → the free sentinel probe ("verify token +
    //     URL only"), following the same '' = unset convention the model
    //     fields use — hence the distinction from "absent";
    //   - absent → the profile's own first model, because a third-party
    //     gateway answers 401/404 for a model it cannot route and the sentinel
    //     probe cannot tell that apart from a bad token.
    const requestedModel = body.model === null
      ? ''
      : typeof body.model === 'string'
        ? body.model.trim()
        : undefined
    const model = requestedModel ?? profile.modelList[0]
    const { testConnection } = await import('../config-test-connection.js')
    const result = await testConnection(authToken, baseUrl, { model })
    return c.json(result.body, result.status)
  })

  return app
}
