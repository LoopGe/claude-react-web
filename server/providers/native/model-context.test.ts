import { describe, expect, it, vi } from 'vitest'
import type { ProviderProfile } from '../../config.js'
import {
  DEFAULT_CONTEXT_WINDOW,
  NativeModelContextResolver,
  type NativeModelDiscovery,
  type NativeModelRoute,
} from './model-context.js'

function makeProfile(id = 'profile-a', modelContextWindows?: Readonly<Record<string, number>>): ProviderProfile {
  return {
    id,
    name: id,
    authToken: `token-for-${id}`,
    baseUrl: 'https://gateway.example',
    modelList: ['vendor/model'],
    modelGroups: [],
    recapModel: '',
    commitMessageModel: '',
    ...(modelContextWindows ? { modelContextWindows } : {}),
  }
}

function makeRoute(overrides: Partial<NativeModelRoute> = {}): NativeModelRoute {
  const profile = overrides.profile ?? makeProfile()
  const baseUrl = overrides.baseUrl ?? profile.baseUrl
  return {
    profile,
    providerId: profile.id,
    baseUrl,
    model: 'vendor/model',
    api: 'anthropic-messages',
    credentials: vi.fn(() => ({ baseUrl, authToken: profile.authToken })),
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('NativeModelContextResolver', () => {
  it('uses exact overrides without discovery or credentials', async () => {
    const retrieve = vi.fn(async () => 999_999)
    const discovery: NativeModelDiscovery = { retrieve }
    const resolver = new NativeModelContextResolver({ discovery })
    const profile = makeProfile('profile-a', {
      'vendor/large': 1_000_000,
      'vendor/small': 128_000,
    })
    const large = makeRoute({ profile, model: 'vendor/large' })
    const small = makeRoute({ profile, model: 'vendor/small' })

    await expect(resolver.resolve(large)).resolves.toEqual({ contextWindow: 1_000_000, source: 'override' })
    await expect(resolver.resolve(small)).resolves.toEqual({ contextWindow: 128_000, source: 'override' })
    expect(retrieve).not.toHaveBeenCalled()
    expect(large.credentials).not.toHaveBeenCalled()
    expect(small.credentials).not.toHaveBeenCalled()
  })

  it('falls back without discovery or credentials when no strategy exists', async () => {
    const retrieve = vi.fn(async () => 999_999)
    const resolver = new NativeModelContextResolver({ discovery: { retrieve } })
    const route = makeRoute({ api: 'unsupported' as NativeModelRoute['api'] })

    await expect(resolver.resolve(route)).resolves.toEqual({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      source: 'fallback',
    })
    expect(DEFAULT_CONTEXT_WINDOW).toBe(200_000)
    expect(retrieve).not.toHaveBeenCalled()
    expect(route.credentials).not.toHaveBeenCalled()
  })

  it('returns a reliable endpoint value unchanged', async () => {
    const resolver = new NativeModelContextResolver({
      discovery: { retrieve: vi.fn(async () => 512_000) },
    })

    await expect(resolver.resolve(makeRoute())).resolves.toEqual({
      contextWindow: 512_000,
      source: 'endpoint',
    })
  })

  it('coalesces concurrent resolves for the same route', async () => {
    const pending = deferred<number | undefined>()
    const retrieve = vi.fn(() => pending.promise)
    const resolver = new NativeModelContextResolver({ discovery: { retrieve } })
    const route = makeRoute()

    const first = resolver.resolve(route)
    const second = resolver.resolve(route)
    await flushMicrotasks()
    expect(retrieve).toHaveBeenCalledTimes(1)
    pending.resolve(1_000_000)

    await expect(first).resolves.toEqual({ contextWindow: 1_000_000, source: 'endpoint' })
    await expect(second).resolves.toEqual({ contextWindow: 1_000_000, source: 'endpoint' })
  })

  it('does not share values across profiles or base URLs', async () => {
    const retrieve = vi.fn(async (route: NativeModelRoute) => {
      if (route.profile.id === 'profile-b') return 128_000
      if (route.baseUrl === 'https://other.example') return 256_000
      return 1_000_000
    })
    const resolver = new NativeModelContextResolver({ discovery: { retrieve } })
    const original = makeRoute()
    const otherProfile = makeRoute({ profile: makeProfile('profile-b') })
    const otherBase = makeRoute({ baseUrl: 'https://other.example' })

    await expect(resolver.resolve(original)).resolves.toMatchObject({ contextWindow: 1_000_000 })
    await expect(resolver.resolve(otherProfile)).resolves.toMatchObject({ contextWindow: 128_000 })
    await expect(resolver.resolve(otherBase)).resolves.toMatchObject({ contextWindow: 256_000 })
    expect(retrieve).toHaveBeenCalledTimes(3)
  })

  it('serves a successful value from cache for five minutes', async () => {
    let now = 10_000
    const retrieve = vi.fn(async () => 400_000)
    const resolver = new NativeModelContextResolver({ discovery: { retrieve }, now: () => now })
    const route = makeRoute()

    await resolver.resolve(route)
    now += 299_999
    await expect(resolver.resolve(route)).resolves.toEqual({ contextWindow: 400_000, source: 'endpoint' })
    expect(retrieve).toHaveBeenCalledTimes(1)
  })

  it('returns expired last-good immediately and refreshes only once in the background', async () => {
    let now = 0
    const pending = deferred<number | undefined>()
    const retrieve = vi.fn()
      .mockResolvedValueOnce(400_000)
      .mockReturnValueOnce(pending.promise)
    const resolver = new NativeModelContextResolver({ discovery: { retrieve }, now: () => now })
    const route = makeRoute()
    await resolver.resolve(route)

    now = 300_000
    await expect(resolver.resolve(route)).resolves.toEqual({ contextWindow: 400_000, source: 'endpoint' })
    await expect(resolver.resolve(route)).resolves.toEqual({ contextWindow: 400_000, source: 'endpoint' })
    await flushMicrotasks()
    expect(retrieve).toHaveBeenCalledTimes(2)

    pending.resolve(500_000)
    await flushMicrotasks()
    await expect(resolver.resolve(route)).resolves.toEqual({ contextWindow: 500_000, source: 'endpoint' })
  })

  it('keeps last-good after a failed refresh and retries after thirty seconds', async () => {
    let now = 0
    const retry = deferred<number | undefined>()
    const retrieve = vi.fn()
      .mockResolvedValueOnce(1_000_000)
      .mockRejectedValueOnce(new Error('offline'))
      .mockReturnValueOnce(retry.promise)
    const resolver = new NativeModelContextResolver({ discovery: { retrieve }, now: () => now })
    const route = makeRoute()
    await resolver.resolve(route)

    now = 300_000
    await expect(resolver.resolve(route)).resolves.toMatchObject({ contextWindow: 1_000_000 })
    await flushMicrotasks()
    expect(retrieve).toHaveBeenCalledTimes(2)

    now += 29_999
    await expect(resolver.resolve(route)).resolves.toMatchObject({ contextWindow: 1_000_000 })
    expect(retrieve).toHaveBeenCalledTimes(2)

    now += 1
    await expect(resolver.resolve(route)).resolves.toMatchObject({ contextWindow: 1_000_000 })
    await flushMicrotasks()
    expect(retrieve).toHaveBeenCalledTimes(3)
    retry.resolve(128_000)
    await flushMicrotasks()
    await expect(resolver.resolve(route)).resolves.toMatchObject({ contextWindow: 128_000 })
  })

  it('cools a fallback failure for thirty seconds before retrying', async () => {
    let now = 0
    const retrieve = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(300_000)
    const resolver = new NativeModelContextResolver({ discovery: { retrieve }, now: () => now })
    const route = makeRoute()

    await expect(resolver.resolve(route)).resolves.toEqual({ contextWindow: 200_000, source: 'fallback' })
    now = 29_999
    await expect(resolver.resolve(route)).resolves.toEqual({ contextWindow: 200_000, source: 'fallback' })
    expect(retrieve).toHaveBeenCalledTimes(1)

    now = 30_000
    await expect(resolver.resolve(route)).resolves.toEqual({ contextWindow: 300_000, source: 'endpoint' })
    expect(retrieve).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ])('treats a %s discovery value as unconfirmed', async (_name, value) => {
    const resolver = new NativeModelContextResolver({
      discovery: { retrieve: vi.fn(async () => value) },
    })

    await expect(resolver.resolve(makeRoute())).resolves.toEqual({
      contextWindow: 200_000,
      source: 'fallback',
    })
  })

  it('treats a discovery exception as unconfirmed', async () => {
    const resolver = new NativeModelContextResolver({
      discovery: { retrieve: vi.fn(async () => { throw new Error('offline') }) },
    })

    await expect(resolver.resolve(makeRoute())).resolves.toEqual({
      contextWindow: 200_000,
      source: 'fallback',
    })
  })

  it('isolates a new profile generation from a late completion for the old object', async () => {
    const oldPending = deferred<number | undefined>()
    const newPending = deferred<number | undefined>()
    const retrieve = vi.fn()
      .mockReturnValueOnce(oldPending.promise)
      .mockReturnValueOnce(newPending.promise)
    const resolver = new NativeModelContextResolver({ discovery: { retrieve } })
    const oldRoute = makeRoute({ profile: makeProfile('same-id') })
    const newRoute = makeRoute({ profile: makeProfile('same-id') })

    const oldResult = resolver.resolve(oldRoute)
    await flushMicrotasks()
    const newResult = resolver.resolve(newRoute)
    await flushMicrotasks()
    expect(retrieve).toHaveBeenCalledTimes(2)

    newPending.resolve(128_000)
    await expect(newResult).resolves.toEqual({ contextWindow: 128_000, source: 'endpoint' })
    oldPending.resolve(1_000_000)
    await expect(oldResult).resolves.toEqual({ contextWindow: 1_000_000, source: 'endpoint' })

    await expect(resolver.resolve(newRoute)).resolves.toEqual({ contextWindow: 128_000, source: 'endpoint' })
    expect(retrieve).toHaveBeenCalledTimes(2)
  })
})
