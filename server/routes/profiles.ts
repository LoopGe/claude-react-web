// Provider-profile CRUD + activation. All writes serialize through the config
// write queue (queueConfigWrite) because profiles is a nested array needing
// read-modify-write semantics — never a blind PUT /config.

import { Hono } from 'hono'
import { HttpError } from '../errors.js'
import { safeJson } from './index.js'
import {
  config as serverConfig, DEFAULT_PROFILE, loadConfig, queueConfigWrite,
} from '../config.js'
import { maskToken } from '../profiles.js'
import { createLogger } from '../log.js'

const log = createLogger('profiles')

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

export function buildProfilesRouter(configDir?: string): Hono {
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
      modelList: Array.isArray(body.modelList) && body.modelList.length > 0
        ? body.modelList.filter((m) => typeof m === 'string' && m.trim())
        : active?.modelList ?? DEFAULT_PROFILE.modelList,
      modelGroups: Array.isArray(body.modelGroups) ? body.modelGroups : active?.modelGroups ?? DEFAULT_PROFILE.modelGroups,
      recapModel: typeof body.recapModel === 'string' && body.recapModel.trim()
        ? body.recapModel.trim() : active?.recapModel ?? DEFAULT_PROFILE.recapModel,
      commitMessageModel: typeof body.commitMessageModel === 'string' && body.commitMessageModel.trim()
        ? body.commitMessageModel.trim() : active?.commitMessageModel ?? DEFAULT_PROFILE.commitMessageModel,
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
    let found = false
    await queueConfigWrite(configDir, (existing) => {
      const profiles = Array.isArray(existing.profiles) ? existing.profiles : []
      const idx = profiles.findIndex((p) => (p as Record<string, unknown>).id === id)
      if (idx === -1) throw new HttpError(404, `profile ${id} not found`)
      found = true
      const prev = profiles[idx] as Record<string, unknown>
      const next: Record<string, unknown> = { ...prev }
      if (typeof body.name === 'string' && body.name.trim()) next.name = body.name.trim()
      // authToken only written when non-empty (empty/absent = keep existing).
      if (typeof body.authToken === 'string' && body.authToken.trim()) next.authToken = body.authToken.trim()
      if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
        next.baseUrl = body.baseUrl.trim().replace(/\/+$/, '')
      }
      if (Array.isArray(body.modelList)) {
        next.modelList = body.modelList.filter((m) => typeof m === 'string' && m.trim())
      }
      if (Array.isArray(body.modelGroups)) next.modelGroups = body.modelGroups
      if (typeof body.recapModel === 'string') next.recapModel = body.recapModel.trim()
      if (typeof body.commitMessageModel === 'string') next.commitMessageModel = body.commitMessageModel.trim()
      profiles[idx] = next
      existing.profiles = profiles
    })
    if (!found) throw new HttpError(404, `profile ${id} not found`)
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
      const profiles = Array.isArray(existing.profiles) ? existing.profiles : []
      existing.profiles = profiles.filter((p) => (p as Record<string, unknown>).id !== id)
    })
    await loadConfig(configDir)
    log.info(`profile deleted id=${id}`)
    return c.json({ ok: true })
  })

  app.post('/profiles/activate', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const body = await safeJson<{ profileId?: string }>(c.req)
    const profileId = body.profileId
    if (typeof profileId !== 'string' || !serverConfig.profiles.some((p) => p.id === profileId)) {
      throw new HttpError(400, `profile ${profileId} not found`)
    }
    await queueConfigWrite(configDir, (existing) => {
      existing.activeProfileId = profileId
    })
    await loadConfig(configDir)
    log.info(`active profile switched to id=${profileId}`)
    return c.json({ ok: true, activeProfileId: serverConfig.activeProfileId })
  })

  app.post('/profiles/:id/test', async (c) => {
    if (!configDir) throw new HttpError(500, 'configDir not set')
    const id = c.req.param('id')
    const profile = serverConfig.profiles.find((p) => p.id === id)
    if (!profile) throw new HttpError(404, `profile ${id} not found`)
    if (!profile.authToken) throw new HttpError(400, 'No auth token to test — save one first')
    const { testConnection } = await import('../config-test-connection.js')
    const result = await testConnection(profile.authToken, profile.baseUrl)
    return c.json(result.body, result.status)
  })

  return app
}
