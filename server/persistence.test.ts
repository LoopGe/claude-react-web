import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SessionStore, type SessionMeta } from './persistence.js'
import { tempDir } from './__test-utils__/index.js'

function makeMeta(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    createdAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_000_000,
    messageCount: 0,
    terminated: false,
    ...overrides,
  }
}

describe('SessionStore', () => {
  let dir: string

  beforeEach(() => {
    dir = tempDir('store')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('returns empty list when file does not exist', async () => {
    const store = new SessionStore({ stateDir: dir })
    expect(await store.load()).toEqual([])
    expect(store.list()).toEqual([])
  })

  it('is tolerant to a corrupt JSON file', async () => {
    writeFileSync(join(dir, 'sessions.json'), '{not json')
    const store = new SessionStore({ stateDir: dir })
    // Should not throw; treats corruption as empty state.
    expect(await store.load()).toEqual([])
  })

  it('ignores non-array top-level JSON', async () => {
    writeFileSync(join(dir, 'sessions.json'), '{"foo":"bar"}')
    const store = new SessionStore({ stateDir: dir })
    expect(await store.load()).toEqual([])
  })

  it('upsert + flush writes atomically and round-trips', async () => {
    const store = new SessionStore({ stateDir: dir })
    await store.load()
    store.upsert(makeMeta('a', { title: 'first' }))
    store.upsert(makeMeta('b', { title: 'second' }))
    await store.flush()

    const raw = readFileSync(join(dir, 'sessions.json'), 'utf8')
    const parsed = JSON.parse(raw) as SessionMeta[]
    expect(parsed).toHaveLength(2)
    expect(parsed.map((m) => m.id).sort()).toEqual(['a', 'b'])

    // A fresh store sees what we just wrote.
    const store2 = new SessionStore({ stateDir: dir })
    const loaded = await store2.load()
    expect(loaded).toHaveLength(2)
    expect(store2.get('a')?.title).toBe('first')
  })

  it('remove() drops the entry from the next flush', async () => {
    const store = new SessionStore({ stateDir: dir })
    await store.load()
    store.upsert(makeMeta('a'))
    store.upsert(makeMeta('b'))
    await store.flush()
    store.remove('a')
    await store.flush()

    const store2 = new SessionStore({ stateDir: dir })
    const loaded = await store2.load()
    expect(loaded.map((m) => m.id)).toEqual(['b'])
  })

  it('upsert debounces and coalesces rapid writes', async () => {
    const store = new SessionStore({ stateDir: dir })
    await store.load()
    // 100 upserts in a tight loop before any await — debounce should collapse
    // these into one disk write that carries the final state.
    for (let i = 0; i < 100; i++) {
      store.upsert(makeMeta(`id-${i % 5}`, { messageCount: i }))
    }
    await store.flush()

    const parsed = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')) as SessionMeta[]
    expect(parsed).toHaveLength(5)
    // The last write for id-0 was at i=95, so messageCount=95, etc.
    const byId = Object.fromEntries(parsed.map((m) => [m.id, m.messageCount]))
    expect(byId['id-0']).toBe(95)
    expect(byId['id-4']).toBe(99)
  })

  it('flush() with nothing dirty is a no-op', async () => {
    const store = new SessionStore({ stateDir: dir })
    await store.load()
    await store.flush()
    // No file should have been created since we never upserted.
    expect(() => readFileSync(join(dir, 'sessions.json'))).toThrow()
  })

  it('coerces missing optional fields on load', async () => {
    // Simulate an older format that lacks messageCount / terminated.
    writeFileSync(
      join(dir, 'sessions.json'),
      JSON.stringify([{ id: 'legacy', createdAt: 1, lastActivityAt: 2 }]),
    )
    const store = new SessionStore({ stateDir: dir })
    const loaded = await store.load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatchObject({
      id: 'legacy',
      messageCount: 0,
      terminated: false,
    })
  })

  it('drops items without an id on load', async () => {
    writeFileSync(
      join(dir, 'sessions.json'),
      JSON.stringify([{ id: 'ok' }, { title: 'no-id' }, null, 'string']),
    )
    const store = new SessionStore({ stateDir: dir })
    const loaded = await store.load()
    expect(loaded.map((m) => m.id)).toEqual(['ok'])
  })

  // ── gitStartSha persistence ─────────────────────────────────────
  it('preserves gitStartSha across upsert + reload', async () => {
    const sha = 'abcdef1234567890abcdef1234567890abcdef12'
    const store = new SessionStore({ stateDir: dir })
    await store.load()
    store.upsert(makeMeta('a', { gitStartSha: sha }))
    await store.flush()

    const store2 = new SessionStore({ stateDir: dir })
    const loaded = await store2.load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].gitStartSha).toBe(sha)
  })

  // ── enabledPlugins persistence ─────────────────────────────────
  it('round-trips enabledPlugins', async () => {
    const store = new SessionStore({ stateDir: dir })
    await store.load()
    store.upsert(makeMeta('a', { enabledPlugins: ['plugA@mp1', 'plugB@mp1'] }))
    await store.flush()

    const store2 = new SessionStore({ stateDir: dir })
    await store2.load()
    const reloaded = store2.get('a')
    expect(reloaded?.enabledPlugins).toEqual(['plugA@mp1', 'plugB@mp1'])
  })

  it('round-trips enabledPlugins absent as undefined', async () => {
    const store = new SessionStore({ stateDir: dir })
    await store.load()
    store.upsert(makeMeta('a')) // no enabledPlugins
    await store.flush()

    const store2 = new SessionStore({ stateDir: dir })
    await store2.load()
    const reloaded = store2.get('a')
    expect(reloaded?.enabledPlugins).toBeUndefined()
  })

  it('round-trips enabledPlugins empty array as [] (not undefined)', async () => {
    const store = new SessionStore({ stateDir: dir })
    await store.load()
    store.upsert(makeMeta('a', { enabledPlugins: [] }))
    await store.flush()

    const store2 = new SessionStore({ stateDir: dir })
    await store2.load()
    const reloaded = store2.get('a')
    // Empty array must survive the round-trip as [] — NOT collapsed to undefined.
    expect(reloaded?.enabledPlugins).toEqual([])
  })

  it('drops non-string entries from enabledPlugins during coerce', async () => {
    writeFileSync(
      join(dir, 'sessions.json'),
      JSON.stringify([
        { id: 'a', createdAt: 1, lastActivityAt: 1, messageCount: 0, terminated: false, enabledPlugins: ['ok', 42, null] },
      ]),
    )
    const store = new SessionStore({ stateDir: dir })
    const loaded = await store.load()
    expect(loaded).toHaveLength(1)
    // Non-string entries cause the whole array to be dropped (undefined).
    expect(loaded[0].enabledPlugins).toBeUndefined()
  })

  it('drops non-string gitStartSha during coerce', async () => {
    writeFileSync(
      join(dir, 'sessions.json'),
      JSON.stringify([
        // gitStartSha is a number — invalid → silently dropped to undefined.
        { id: 'a', createdAt: 1, lastActivityAt: 1, messageCount: 0, terminated: false, gitStartSha: 42 },
      ]),
    )
    const store = new SessionStore({ stateDir: dir })
    const loaded = await store.load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].gitStartSha).toBeUndefined()
  })

  it('round-trips a valid memory object', async () => {
    writeFileSync(
      join(dir, 'sessions.json'),
      JSON.stringify([
        {
          id: 'a', createdAt: 1, lastActivityAt: 1, messageCount: 0, terminated: false,
          memory: { autoMemoryEnabled: true, autoMemoryDirectory: ' ~/mem ', autoDreamEnabled: false },
        },
      ]),
    )
    const store = new SessionStore({ stateDir: dir })
    const loaded = await store.load()
    // Directory is trimmed; booleans pass through.
    expect(loaded[0].memory).toEqual({ autoMemoryEnabled: true, autoMemoryDirectory: '~/mem', autoDreamEnabled: false })
  })

  it('drops invalid memory keys and empty directories during coerce', async () => {
    writeFileSync(
      join(dir, 'sessions.json'),
      JSON.stringify([
        {
          id: 'a', createdAt: 1, lastActivityAt: 1, messageCount: 0, terminated: false,
          memory: { autoMemoryEnabled: 'yes', autoMemoryDirectory: '   ', autoDreamEnabled: true },
        },
      ]),
    )
    const store = new SessionStore({ stateDir: dir })
    const loaded = await store.load()
    expect(loaded[0].memory).toEqual({ autoDreamEnabled: true })
  })

  it('coerces an all-invalid / empty memory object to undefined', async () => {
    writeFileSync(
      join(dir, 'sessions.json'),
      JSON.stringify([
        { id: 'a', createdAt: 1, lastActivityAt: 1, messageCount: 0, terminated: false, memory: { autoMemoryEnabled: 1 } },
        { id: 'b', createdAt: 1, lastActivityAt: 1, messageCount: 0, terminated: false, memory: {} },
        { id: 'c', createdAt: 1, lastActivityAt: 1, messageCount: 0, terminated: false, memory: 'nope' },
      ]),
    )
    const store = new SessionStore({ stateDir: dir })
    const loaded = await store.load()
    expect(loaded[0].memory).toBeUndefined()
    expect(loaded[1].memory).toBeUndefined()
    expect(loaded[2].memory).toBeUndefined()
  })

  // ── thinking (ThinkingSetting) persistence ──────────────────────
  it('round-trips a valid thinking setting', async () => {
    const store = new SessionStore({ stateDir: dir })
    await store.load()
    store.upsert(makeMeta('a', { thinking: { type: 'enabled', budgetTokens: 8192 } }))
    store.upsert(makeMeta('b', { thinking: { type: 'adaptive' } }))
    await store.flush()

    const store2 = new SessionStore({ stateDir: dir })
    await store2.load()
    expect(store2.get('a')?.thinking).toEqual({ type: 'enabled', budgetTokens: 8192 })
    expect(store2.get('b')?.thinking).toEqual({ type: 'adaptive' })
  })

  it('rounds fractional / non-integer budgets during coerce', async () => {
    writeFileSync(
      join(dir, 'sessions.json'),
      JSON.stringify([
        { id: 'a', createdAt: 1, lastActivityAt: 1, messageCount: 0, terminated: false, thinking: { type: 'enabled', budgetTokens: 8191.6 } },
      ]),
    )
    const store = new SessionStore({ stateDir: dir })
    const loaded = await store.load()
    expect(loaded[0].thinking).toEqual({ type: 'enabled', budgetTokens: 8192 })
  })

  it('drops malformed thinking values during coerce', async () => {
    writeFileSync(
      join(dir, 'sessions.json'),
      JSON.stringify([
        { id: 'a', createdAt: 1, lastActivityAt: 1, messageCount: 0, terminated: false, thinking: { type: 'wild' } },
        { id: 'b', createdAt: 1, lastActivityAt: 1, messageCount: 0, terminated: false, thinking: 'adaptive' },
        { id: 'c', createdAt: 1, lastActivityAt: 1, messageCount: 0, terminated: false, thinking: { type: 'enabled', budgetTokens: -5 } },
        { id: 'd', createdAt: 1, lastActivityAt: 1, messageCount: 0, terminated: false, thinking: null },
      ]),
    )
    const store = new SessionStore({ stateDir: dir })
    const loaded = await store.load()
    for (const m of loaded) expect(m.thinking).toBeUndefined()
  })
})
