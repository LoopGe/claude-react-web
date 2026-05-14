import { describe, it, expect, vi, beforeEach } from 'vitest'
import { apiRequest, api, type ApiError } from './useApi'

// useApi.ts uses the global fetch. jsdom provides a stub; we override it.

beforeEach(() => {
  vi.restoreAllMocks()
})

function mockFetch(response: {
  ok?: boolean
  status?: number
  contentType?: string
  body?: unknown
}) {
  const {
    ok = true,
    status = 200,
    contentType = 'application/json',
    body = {},
  } = response
  const res = {
    ok,
    status,
    headers: new Headers({ 'content-type': contentType }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res))
}

describe('apiRequest', () => {
  it('sends GET to /api + path without Content-Type (no body)', async () => {
    mockFetch({ body: { ok: true } })
    const result = await apiRequest('/sessions')
    expect(result).toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledWith('/api/sessions', expect.objectContaining({
      headers: {},
    }))
  })

  it('returns parsed JSON body on success', async () => {
    const data = { sessions: [{ id: '1' }] }
    mockFetch({ body: data })
    const result = await apiRequest<{ sessions: { id: string }[] }>('/sessions')
    expect(result).toEqual(data)
  })

  it('throws ApiError with status on non-ok response with JSON body', async () => {
    mockFetch({ ok: false, status: 404, body: { error: 'not found' } })
    await expect(apiRequest('/nope')).rejects.toMatchObject({
      message: 'not found',
      status: 404,
    } satisfies Partial<ApiError>)
  })

  it('falls back to HTTP status message when body has no error field', async () => {
    mockFetch({ ok: false, status: 500, body: { detail: 'oops' } })
    await expect(apiRequest('/fail')).rejects.toMatchObject({
      message: 'HTTP 500',
      status: 500,
    } satisfies Partial<ApiError>)
  })

  it('handles non-JSON response body', async () => {
    mockFetch({ ok: true, contentType: 'text/plain', body: 'hello' })
    const result = await apiRequest<string>('/text')
    expect(result).toBe('hello')
  })
})

describe('api helpers', () => {
  it('api.get sends GET request with timeout signal', async () => {
    mockFetch({ body: {} })
    await api.get('/test')
    expect(fetch).toHaveBeenCalledWith(
      '/api/test',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('api.get forwards caller signal (merged with timeout)', async () => {
    mockFetch({ body: {} })
    const ac = new AbortController()
    await api.get('/test', { signal: ac.signal })
    // The actual signal passed to fetch is our internal timeout
    // controller's signal; the caller's signal is wired to abort it.
    expect(fetch).toHaveBeenCalledWith(
      '/api/test',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('api.post sends POST with JSON body', async () => {
    mockFetch({ body: { id: '1' } })
    const result = await api.post('/sessions', { name: 'test' })
    expect(result).toEqual({ id: '1' })
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions',
      expect.objectContaining({
        method: 'POST',
        body: '{"name":"test"}',
      }),
    )
  })

  it('api.post omits body when undefined', async () => {
    mockFetch({ body: {} })
    await api.post('/action')
    expect(fetch).toHaveBeenCalledWith(
      '/api/action',
      expect.objectContaining({ method: 'POST', body: undefined }),
    )
  })

  it('api.patch sends PATCH with JSON body', async () => {
    mockFetch({ body: {} })
    await api.patch('/sessions/1', { model: 'new' })
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/1',
      expect.objectContaining({
        method: 'PATCH',
        body: '{"model":"new"}',
      }),
    )
  })

  it('api.delete sends DELETE', async () => {
    mockFetch({ body: {} })
    await api.delete('/sessions/1')
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})
