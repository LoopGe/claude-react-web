import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { buildProfilesRouter } from './profiles.js'
import { createErrorHandler } from '../errors.js'

// The test route dynamically imports the real probe; stub it so these tests
// assert which model the route asks it to test, without touching the network.
vi.mock('../config-test-connection.js', () => ({
  testConnection: vi.fn(async () => ({ status: 200, body: { ok: true } })),
}))

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

  it('clears the recap/commit model when the client sends null ("(default)")', async () => {
    const { promises: fs } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    // Namespace import, not destructuring: `config` is a reassigned `let`
    // binding, so a destructured copy would keep pointing at the object from
    // an earlier test's loadConfig.
    const configMod = await import('../config.js')
    const dir = await fs.mkdtemp(join(tmpdir(), 'crw-profiles-clear-'))
    await fs.writeFile(join(dir, 'config.json'), JSON.stringify({
      profiles: [{
        id: 'default', name: 'Gateway', authToken: 'sk-x', baseUrl: 'https://gw.example',
        modelList: ['vendor/model-a'], modelGroups: [],
        recapModel: 'vendor/recap', commitMessageModel: 'vendor/commit',
      }],
      activeProfileId: 'default',
    }))
    const app = appWith(dir)

    // src/components/ProfilesSettingsTab.tsx sends `recapModel: <id> || null`,
    // so picking "(default)" in the dropdown arrives here as null.
    const res = await app.request('/profiles/default', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recapModel: null, commitMessageModel: null }),
    })
    expect(res.status).toBe(200)

    const onDisk = JSON.parse(await fs.readFile(join(dir, 'config.json'), 'utf8'))
    expect(onDisk.profiles[0].recapModel).toBe('')
    expect(onDisk.profiles[0].commitMessageModel).toBe('')
    // And the reloaded config resolves both to "use the session's model",
    // instead of the old behaviour of skipping null and keeping 'vendor/recap'.
    expect(configMod.config.recapModel).toBe('')
    expect(configMod.config.commitMessageModel).toBe('')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('treats an explicit null recap model on create as unset, like PUT does', async () => {
    const { promises: fs } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = await fs.mkdtemp(join(tmpdir(), 'crw-profiles-create-null-'))
    await fs.writeFile(join(dir, 'config.json'), JSON.stringify({
      profiles: [{
        id: 'default', name: 'Gateway', authToken: 'sk-x', baseUrl: 'https://gw.example',
        modelList: ['vendor/model-a'], modelGroups: [],
        recapModel: 'vendor/inherited', commitMessageModel: 'vendor/inherited',
      }],
      activeProfileId: 'default',
    }))
    const app = appWith(dir)

    // The settings tab's convention is `value || null`, so a create call can
    // legitimately carry null for "unset" — it must not silently inherit the
    // active profile's model (that is what "absent" means).
    const res = await app.request('/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Second', recapModel: null, commitMessageModel: null }),
    })
    expect(res.status).toBe(201)
    const onDisk = JSON.parse(await fs.readFile(join(dir, 'config.json'), 'utf8'))
    expect(onDisk.profiles[1].recapModel).toBe('')
    expect(onDisk.profiles[1].commitMessageModel).toBe('')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('clears model groups when the client sends null, but rejects the two required fields', async () => {
    const { promises: fs } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = await fs.mkdtemp(join(tmpdir(), 'crw-profiles-required-'))
    await fs.writeFile(join(dir, 'config.json'), JSON.stringify({
      profiles: [{
        id: 'default', name: 'Gateway', authToken: 'sk-x', baseUrl: 'https://gw.example',
        modelList: ['vendor/model-a'],
        modelGroups: [{ id: 'g1', name: 'Group 1', main: 'opus', opus: 'vendor/model-a' }],
        recapModel: '', commitMessageModel: '',
      }],
      activeProfileId: 'default',
    }))
    const app = appWith(dir)
    const put = (body: Record<string, unknown>) =>
      app.request('/profiles/default', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

    // A profile may legitimately have no model groups — the card sends null
    // when its list is empty, and that must clear rather than keep.
    expect((await put({ modelGroups: null })).status).toBe(200)
    const afterClear = JSON.parse(await fs.readFile(join(dir, 'config.json'), 'utf8'))
    expect(afterClear.profiles[0].modelGroups).toEqual([])

    // The required fields reject an explicit blank instead of silently
    // keeping the old value while the card shows the field cleared.
    expect((await put({ baseUrl: null })).status).toBe(400)
    expect((await put({ baseUrl: '   ' })).status).toBe(400)
    expect((await put({ modelList: null })).status).toBe(400)
    expect((await put({ modelList: [] })).status).toBe(400)
    expect((await put({ name: '' })).status).toBe(400)

    // …and the failures left the stored profile untouched.
    const afterRejects = JSON.parse(await fs.readFile(join(dir, 'config.json'), 'utf8'))
    expect(afterRejects.profiles[0].baseUrl).toBe('https://gw.example')
    expect(afterRejects.profiles[0].modelList).toEqual(['vendor/model-a'])
    expect(afterRejects.profiles[0].name).toBe('Gateway')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('probes the profile model by default and the sentinel when asked for none', async () => {
    const { promises: fs } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { testConnection } = await import('../config-test-connection.js')
    const mockProbe = vi.mocked(testConnection)
    const dir = await fs.mkdtemp(join(tmpdir(), 'crw-profiles-probe-model-'))
    await fs.writeFile(join(dir, 'config.json'), JSON.stringify({
      profiles: [{
        id: 'default', name: 'Gateway', authToken: 'sk-x', baseUrl: 'https://gw.example',
        modelList: ['vendor/model-a'], modelGroups: [], recapModel: '', commitMessageModel: '',
      }],
      activeProfileId: 'default',
    }))
    const app = appWith(dir)

    mockProbe.mockClear()
    await app.request('/profiles/default/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(mockProbe.mock.calls[0][2]).toMatchObject({ model: 'vendor/model-a' })

    mockProbe.mockClear()
    await app.request('/profiles/default/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: '' }),
    })
    // '' is the "unset" convention, so it must mean "no model" (the free
    // sentinel probe), not "fall back to modelList[0]".
    expect(mockProbe.mock.calls[0][2]).toMatchObject({ model: '' })
    await fs.rm(dir, { recursive: true, force: true })
  })
})
