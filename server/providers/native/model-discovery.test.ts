import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderProfile } from '../../config.js'
import { getLogConfig, setLogConfig } from '../../log.js'
import { AnthropicModelDiscovery } from './model-discovery.js'
import type { NativeModelRoute } from './model-context.js'

const TOKEN = 'test-discovery-token'
const BASE_URL = 'https://gateway.example'
const MODEL = 'vendor/model'

function makeRoute(): NativeModelRoute {
  const profile: ProviderProfile = {
    id: 'profile-a',
    name: 'Profile A',
    authToken: TOKEN,
    baseUrl: BASE_URL,
    modelList: [MODEL],
    modelGroups: [],
    recapModel: '',
    commitMessageModel: '',
  }
  return {
    profile,
    providerId: profile.id,
    baseUrl: BASE_URL,
    model: MODEL,
    api: 'anthropic-messages',
    credentials: vi.fn(() => ({ baseUrl: BASE_URL, authToken: TOKEN })),
  }
}

function modelBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MODEL,
    type: 'model',
    display_name: 'Vendor Model',
    created_at: '2026-01-01T00:00:00Z',
    capabilities: {},
    max_input_tokens: 512_000,
    max_tokens: 16_384,
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function errorFrom(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.catch((reason: unknown) => reason)
  expect(error).toBeInstanceOf(Error)
  return error as Error
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('AnthropicModelDiscovery', () => {
  it('retrieves the encoded exact model with lazy credentials and Anthropic headers', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(modelBody()))
    const route = makeRoute()
    const discovery = new AnthropicModelDiscovery({ fetchFn })

    await expect(discovery.retrieve(route)).resolves.toBe(512_000)
    expect(route.credentials).toHaveBeenCalledTimes(1)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('https://gateway.example/v1/models/vendor%2Fmodel')
    expect(init?.method).toBe('GET')
    expect(init?.redirect).toBe('error')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
  })

  it('accepts a valid response without an id', async () => {
    const body = modelBody()
    delete body.id
    const discovery = new AnthropicModelDiscovery({
      fetchFn: vi.fn<typeof fetch>(async () => jsonResponse(body)),
    })

    await expect(discovery.retrieve(makeRoute())).resolves.toBe(512_000)
  })

  it('rejects capacity from a response whose id names another model', async () => {
    const discovery = new AnthropicModelDiscovery({
      fetchFn: vi.fn<typeof fetch>(async () => jsonResponse(modelBody({ id: 'vendor/other' }))),
    })

    await expect(discovery.retrieve(makeRoute())).resolves.toBeUndefined()
  })

  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['string', '512000'],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ])('returns undefined for a %s max_input_tokens field', async (_name, value) => {
    const discovery = new AnthropicModelDiscovery({
      fetchFn: vi.fn<typeof fetch>(async () => jsonResponse(modelBody({ max_input_tokens: value }))),
    })

    await expect(discovery.retrieve(makeRoute())).resolves.toBeUndefined()
  })

  it('never substitutes the output max_tokens for context capacity', async () => {
    const body = modelBody()
    delete body.max_input_tokens
    const discovery = new AnthropicModelDiscovery({
      fetchFn: vi.fn<typeof fetch>(async () => jsonResponse(body)),
    })

    await expect(discovery.retrieve(makeRoute())).resolves.toBeUndefined()
  })

  it.each([302, 401, 404, 500])('rejects HTTP %s without exposing credentials or the response body', async (status) => {
    const secretBody = `secret-response-body-${status}`
    const discovery = new AnthropicModelDiscovery({
      fetchFn: vi.fn<typeof fetch>(async () => new Response(secretBody, { status })),
    })

    const error = await errorFrom(discovery.retrieve(makeRoute()))
    expect(error.message).toContain(String(status))
    expect(error.message).not.toContain(TOKEN)
    expect(error.message).not.toContain(secretBody)
  })

  it('cancels a non-success response body before rejecting', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    const discovery = new AnthropicModelDiscovery({
      fetchFn: vi.fn<typeof fetch>(async () => new Response(body, { status: 500 })),
    })

    await expect(discovery.retrieve(makeRoute())).rejects.toThrow(/500/)
    expect(cancelled).toBe(true)
  })

  it('rejects invalid JSON without exposing the response body', async () => {
    const secretBody = 'invalid-json-secret-body'
    const discovery = new AnthropicModelDiscovery({
      fetchFn: vi.fn<typeof fetch>(async () => new Response(secretBody)),
    })

    const error = await errorFrom(discovery.retrieve(makeRoute()))
    expect(error.message).toMatch(/json/i)
    expect(error.message).not.toContain(TOKEN)
    expect(error.message).not.toContain(secretBody)
  })

  it('accepts a valid body at the 64 KiB boundary', async () => {
    const text = JSON.stringify(modelBody()).padEnd(65_536, ' ')
    expect(new TextEncoder().encode(text)).toHaveLength(65_536)
    const discovery = new AnthropicModelDiscovery({
      fetchFn: vi.fn<typeof fetch>(async () => new Response(text)),
    })

    await expect(discovery.retrieve(makeRoute())).resolves.toBe(512_000)
  })

  it('rejects a stream as soon as it exceeds 64 KiB', async () => {
    const chunk = new Uint8Array(65_536)
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk)
      },
    })
    const discovery = new AnthropicModelDiscovery({
      fetchFn: vi.fn<typeof fetch>(async () => new Response(body)),
    })

    await expect(discovery.retrieve(makeRoute())).rejects.toThrow(/64 KiB/)
  })

  it('sanitizes network failures', async () => {
    const discovery = new AnthropicModelDiscovery({
      fetchFn: vi.fn<typeof fetch>(async () => {
        throw new Error(`network failed with ${TOKEN}`)
      }),
    })

    const error = await errorFrom(discovery.retrieve(makeRoute()))
    expect(error.message).not.toContain(TOKEN)
    expect(error.message).toMatch(/request failed/i)
  })

  it('settles a request that ignores abort after five seconds', async () => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | null | undefined
    const fetchFn = vi.fn<typeof fetch>((_input, init) => {
      requestSignal = init?.signal
      return new Promise<Response>(() => {})
    })
    const discovery = new AnthropicModelDiscovery({ fetchFn })

    let settled = false
    const observed = discovery.retrieve(makeRoute()).catch((error: unknown) => {
      settled = true
      return error
    })
    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.resolve()
    expect(settled).toBe(true)
    expect(requestSignal?.aborted).toBe(true)
    expect(await observed).toMatchObject({ message: expect.stringMatching(/timed out/i) })
  })

  it('keeps credentials and response bodies out of diagnostic logs', async () => {
    const previous = getLogConfig()
    const secretBody = 'secret-log-response-body'
    const urlPassword = 'secret-url-password'
    const route = makeRoute()
    route.baseUrl = `https://user:${urlPassword}@gateway.example`
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    setLogConfig({ level: 'debug', scopes: ['native-model-discovery'] })
    try {
      const discovery = new AnthropicModelDiscovery({
        fetchFn: vi.fn<typeof fetch>(async () => new Response(secretBody, { status: 503 })),
      })
      await expect(discovery.retrieve(route)).rejects.toThrow(/503/)
      const output = logSpy.mock.calls.flat().join(' ')
      expect(output).toContain('503')
      expect(output).not.toContain(TOKEN)
      expect(output).not.toContain(secretBody)
      expect(output).not.toContain(urlPassword)
    } finally {
      setLogConfig(previous)
    }
  })
})
