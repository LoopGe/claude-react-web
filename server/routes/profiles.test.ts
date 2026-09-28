import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { buildProfilesRouter } from './profiles.js'
import { createErrorHandler } from '../errors.js'
import { loadConfig } from '../config.js'

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

  it('templates an all-blank modelList from the active profile instead of storing []', async () => {
    // A stored `modelList: []` reads back as absent, so the reader would
    // substitute the hardcoded DEFAULT ids — unroutable on a third-party
    // gateway. POST is the third writer of this field; PUT /profiles/:id 400s
    // on an empty list and /config/setup filters first.
    const { promises: fs } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = await fs.mkdtemp(join(tmpdir(), 'crw-profiles-blank-models-'))
    await fs.writeFile(join(dir, 'config.json'), JSON.stringify({
      profiles: [{ id: 'default', name: 'Default', authToken: 'sk-ant-abcdef', baseUrl: 'https://api.anthropic.com', modelList: ['gw/model-x'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c' }],
      activeProfileId: 'default',
    }))
    const app = appWith(dir)
    // POST /profiles templates the missing fields from the ACTIVE profile, which
    // it reads off the live config — so this fixture has to be loaded, not just
    // written. (Sibling tests get this for free from an earlier write's
    // applyParsedConfig; this one must not depend on that ordering.)
    await loadConfig(dir)

    const created = await app.request('/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Second', modelList: ['', '   '] }),
    })
    expect(created.status).toBe(201)

    const written = JSON.parse(await fs.readFile(join(dir, 'config.json'), 'utf8')) as {
      profiles: { name: string; modelList: string[] }[]
    }
    expect(written.profiles.find((p) => p.name === 'Second')?.modelList).toEqual(['gw/model-x'])
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

  it('deletes every copy when two raw entries share an id', async () => {
    // The reader resolves the LAST copy (dedup, last wins). Removing only that
    // index would leave a shadowed duplicate that the id still resolves to, so
    // the delete would report success while GET /profiles kept listing it.
    const { promises: fs } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = await fs.mkdtemp(join(tmpdir(), 'crw-profiles-dup-id-'))
    await fs.writeFile(join(dir, 'config.json'), JSON.stringify({
      profiles: [
        { id: 'default', name: 'Default', authToken: 'sk-ant-abcdef', baseUrl: 'https://api.anthropic.com', modelList: ['m1'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c' },
        { id: 'p_b', name: 'B-first', authToken: 't1', baseUrl: 'https://gw', modelList: ['m1'], modelGroups: [], recapModel: '', commitMessageModel: '' },
        { id: 'p_b', name: 'B-second', authToken: 't2', baseUrl: 'https://gw', modelList: ['m1'], modelGroups: [], recapModel: '', commitMessageModel: '' },
      ],
      activeProfileId: 'default',
    }))
    const app = appWith(dir)
    await loadConfig(dir)

    const del = await app.request('/profiles/p_b', { method: 'DELETE' })
    expect(del.status).toBe(200)

    const listed = (await (await app.request('/profiles')).json()) as { profiles: { id: string }[] }
    expect(listed.profiles.map((p) => p.id)).toEqual(['default'])
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('edits and deletes the entry a padded raw id resolves to', async () => {
    // The coercion TRIMS ids, so GET /profiles lists 'p_two' while the raw entry
    // reads ' p_two '. Hand-matching the raw string 404s the edit and silently
    // no-ops the delete — a profile the UI shows but can never change.
    const { promises: fs } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = await fs.mkdtemp(join(tmpdir(), 'crw-profiles-padded-id-'))
    await fs.writeFile(join(dir, 'config.json'), JSON.stringify({
      profiles: [
        { id: 'default', name: 'Default', authToken: 'sk-ant-abcdef', baseUrl: 'https://api.anthropic.com', modelList: ['m1'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c' },
        { id: ' p_two ', name: 'Second', authToken: 'tok-two', baseUrl: 'https://gw2', modelList: ['m2'], modelGroups: [], recapModel: '', commitMessageModel: '' },
      ],
      activeProfileId: 'default',
    }))
    const app = appWith(dir)
    await loadConfig(dir)

    const put = await app.request('/profiles/p_two', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    })
    expect(put.status).toBe(200)

    const del = await app.request('/profiles/p_two', { method: 'DELETE' })
    expect(del.status).toBe(200)

    const written = JSON.parse(await fs.readFile(join(dir, 'config.json'), 'utf8')) as {
      profiles: { id: string; name: string }[]
    }
    // The padded entry is the one that was renamed and removed.
    expect(written.profiles).toHaveLength(1)
    expect(written.profiles[0].id).toBe('default')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('rejects a non-object body without a 500, and writes nothing', async () => {
    // safeJson returns `null` for a JSON `null` body, so every handler that
    // dereferences `body.<field>` used to throw a TypeError → opaque 500. This
    // covers all four body-taking handlers in this router, plus the arms beyond
    // `null`: PUT used to accept `[]` as a silent no-op write (200 ok).
    const { promises: fs } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = await fs.mkdtemp(join(tmpdir(), 'crw-profiles-null-body-'))
    await fs.writeFile(join(dir, 'config.json'), JSON.stringify({
      profiles: [{ id: 'default', name: 'Default', authToken: 'sk-ant-abcdef', baseUrl: 'https://api.anthropic.com', modelList: ['m1'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c' }],
      activeProfileId: 'default',
    }))
    const original = await fs.readFile(join(dir, 'config.json'), 'utf8')
    const app = appWith(dir)
    await loadConfig(dir)

    try {
      const send = (path: string, method: string, body?: string) => app.request(path, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body }),
      })

      for (const bad of ['null', '[]', '"x"', '42']) {
        for (const [path, method] of [
          ['/profiles', 'POST'],
          ['/profiles/default', 'PUT'],
          ['/profiles/activate', 'POST'],
          ['/profiles/default/test', 'POST'],
        ] as const) {
          const res = await send(path, method, bad)
          expect(res.status, `${method} ${path} with ${bad}`).toBe(400)
          expect(((await res.json()) as { error: string }).error)
            .toMatch(/must be a JSON object/)
        }
      }

      // A rejected write must not have touched the file.
      expect(await fs.readFile(join(dir, 'config.json'), 'utf8')).toBe(original)

      // The test endpoint still accepts a MISSING body — its long-standing
      // leniency ("no body is fine") means "probe the saved credentials".
      expect((await send('/profiles/default/test', 'POST')).status).toBe(200)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('profiles router: POST /profiles template', () => {
  /** Seed a config.json with the given profiles and load it, returning the
   *  app under test. The POST route reads `active` off the LIVE config, so
   *  every template test needs loadConfig — same reason the blank-modelList
   *  sibling above loads explicitly. */
  async function seed(profiles: unknown[], activeProfileId = 'default') {
    const { promises: fs } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = await fs.mkdtemp(join(tmpdir(), 'crw-profiles-template-'))
    await fs.writeFile(join(dir, 'config.json'), JSON.stringify({ profiles, activeProfileId }))
    await loadConfig(dir)
    const app = appWith(dir)
    const readDisk = async () =>
      JSON.parse(await fs.readFile(join(dir, 'config.json'), 'utf8')) as {
        profiles: Array<Record<string, unknown>>
      }
    const cleanup = () => fs.rm(dir, { recursive: true, force: true })
    return { app, readDisk, cleanup }
  }

  const ACTIVE = {
    id: 'default', name: 'Gateway', authToken: 'sk-x', baseUrl: 'https://gw.example',
    modelList: ['active/model-a'], modelGroups: [],
    recapModel: 'active-recap', commitMessageModel: 'active-commit',
  }

  it('copies non-credential fields from the named profile when template is a profile id', async () => {
    const OTHER = {
      id: 'p_other', name: 'Other', authToken: 'sk-other', baseUrl: 'https://other.example',
      modelList: ['other/model-1', 'other/model-2'],
      modelGroups: [{ id: 'g1', name: 'Group 1', main: 'opus', opus: 'other/model-1' }],
      recapModel: 'other-recap', commitMessageModel: 'other-commit',
    }
    const { app, readDisk, cleanup } = await seed([ACTIVE, OTHER])
    try {
      const res = await app.request('/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Third', template: 'p_other' }),
      })
      expect(res.status).toBe(201)

      const onDisk = await readDisk()
      const created = onDisk.profiles.find((p) => p.name === 'Third')
      expect(created).toBeDefined()
      // Everything the template carries except its credentials.
      expect(created?.baseUrl).toBe('https://other.example')
      expect(created?.modelList).toEqual(['other/model-1', 'other/model-2'])
      expect(created?.modelGroups).toEqual(OTHER.modelGroups)
      expect(created?.recapModel).toBe('other-recap')
      expect(created?.commitMessageModel).toBe('other-commit')
      // The token is NEVER templated — the user must type one.
      expect(created?.authToken).toBe('')
    } finally {
      await cleanup()
    }
  })

  it('templates from the active profile when template is "active" or absent', async () => {
    const { app, readDisk, cleanup } = await seed([ACTIVE])
    try {
      for (const body of [{ name: 'ViaActive', template: 'active' }, { name: 'ViaAbsent' }]) {
        const res = await app.request('/profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        expect(res.status).toBe(201)
      }

      const onDisk = await readDisk()
      for (const name of ['ViaActive', 'ViaAbsent']) {
        const created = onDisk.profiles.find((p) => p.name === name)
        expect(created?.baseUrl, name).toBe('https://gw.example')
        expect(created?.modelList, name).toEqual(['active/model-a'])
        expect(created?.recapModel, name).toBe('active-recap')
      }
    } finally {
      await cleanup()
    }
  })

  it('creates a blank profile from built-in defaults when template is "blank"', async () => {
    const { app, readDisk, cleanup } = await seed([ACTIVE])
    try {
      const res = await app.request('/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Fresh', template: 'blank' }),
      })
      expect(res.status).toBe(201)

      const onDisk = await readDisk()
      const created = onDisk.profiles.find((p) => p.name === 'Fresh')
      // Built-in defaults — NOT the active profile's gateway/model set.
      expect(created?.baseUrl).toBe('https://api.anthropic.com')
      expect(created?.modelList).toEqual([
        'anthropic/claude-sonnet-4-20250514',
        'claude-opus-4-20250514',
        'claude-haiku-3-5-20241022',
      ])
      expect(created?.modelGroups).toEqual([])
      expect(created?.recapModel).toBe('')
      expect(created?.commitMessageModel).toBe('')
      expect(created?.authToken).toBe('')
    } finally {
      await cleanup()
    }
  })

  it('lets explicitly-sent fields win over the chosen template', async () => {
    // Pre-existing rule: an explicitly-sent field beats templating (the
    // recap/commit tests above pin it for the active path). The template
    // switch must not change it for blank either.
    const { app, readDisk, cleanup } = await seed([ACTIVE])
    try {
      const res = await app.request('/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Mixed', template: 'blank', modelList: ['custom/model'] }),
      })
      expect(res.status).toBe(201)

      const onDisk = await readDisk()
      const created = onDisk.profiles.find((p) => p.name === 'Mixed')
      expect(created?.modelList).toEqual(['custom/model'])
      // The untouched fields still come from the blank template.
      expect(created?.baseUrl).toBe('https://api.anthropic.com')
    } finally {
      await cleanup()
    }
  })

  it('rejects an unknown template profile id and a non-string template with 400', async () => {
    const { app, readDisk, cleanup } = await seed([ACTIVE])
    try {
      for (const template of ['p_nope', 42, true, { id: 'p_other' }]) {
        const res = await app.request('/profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Bad', template }),
        })
        expect(res.status, `template=${JSON.stringify(template)}`).toBe(400)
        expect(((await res.json()) as { error: string }).error).toBeTruthy()
      }

      // A rejected create must not have written anything.
      const onDisk = await readDisk()
      expect(onDisk.profiles).toHaveLength(1)
    } finally {
      await cleanup()
    }
  })
})
