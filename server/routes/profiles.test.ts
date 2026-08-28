import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { buildProfilesRouter } from './profiles.js'
import { createErrorHandler } from '../errors.js'

function appWith(configDir: string) {
  const app = new Hono()
  app.onError(createErrorHandler('[profiles]'))
  app.route('/', buildProfilesRouter(configDir))
  return app
}

describe('profiles router', () => {
  it('round-trips CRUD and masks tokens', async () => {
    // Use a temp dir seeded with a Default profile via fs (same as config tests).
    const { promises: fs } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = await fs.mkdtemp(join(tmpdir(), 'crw-profiles-routes-'))
    await fs.writeFile(join(dir, 'config.json'), JSON.stringify({
      profiles: [{ id: 'default', name: 'Default', authToken: 'sk-ant-abcdef', baseUrl: 'https://api.anthropic.com', modelList: ['m1'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c' }],
      activeProfileId: 'default',
    }))
    const app = appWith(dir)

    const created = await app.request('/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Second', authToken: 'tok-two', baseUrl: 'https://gw2', modelList: ['m2'] }),
    })
    expect(created.status).toBe(201)
    const createdJson = (await created.json()) as { profile: { id: string; authTokenMasked: string } }
    expect(createdJson.profile.id).toBeTruthy()
    expect(createdJson.profile.authTokenMasked).toBe('****-two')

    const list = (await (await app.request('/profiles')).json()) as { profiles: Array<{ authTokenMasked: string }> }
    expect(list.profiles).toHaveLength(2)
    expect(list.profiles[0].authTokenMasked).toBe('****cdef')

    const del = await app.request('/profiles/default', { method: 'DELETE' })
    expect(del.status).toBe(400) // active profile cannot be deleted
    await fs.rm(dir, { recursive: true, force: true })
  })
})
