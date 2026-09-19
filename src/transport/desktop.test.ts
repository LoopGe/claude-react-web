import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesktopTransport } from './desktop'

// The desktop transport composes two halves: REST reuses the web fetch wrapper
// (the host proxies /api under crw://), realtime delegates to the preload
// bridge. These lock that composition.

describe('createDesktopTransport', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it('routes request through fetch against /api (web semantics)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
      text: () => Promise.resolve('{}'),
    })
    vi.stubGlobal('fetch', fetchMock)
    const connect = vi.fn()
    const t = createDesktopTransport({ connect })

    const body = await t.request('/sessions')
    expect(body).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions', expect.anything())
    expect(connect).not.toHaveBeenCalled()
  })

  it('preserves the ApiError status from a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ error: { code: 'denied', message: 'nope' } }),
      text: () => Promise.resolve(''),
    }))
    const t = createDesktopTransport({ connect: vi.fn() })
    await expect(t.request('/x')).rejects.toMatchObject({ status: 403, message: 'nope', code: 'denied' })
  })

  it('delegates connect to the preload bridge', () => {
    const conn = { send: vi.fn(), close: vi.fn() }
    const connect = vi.fn().mockReturnValue(conn)
    const t = createDesktopTransport({ connect })

    const handlers = { onFrame: vi.fn(), onOpen: vi.fn(), onClose: vi.fn() }
    const got = t.connect(handlers, { url: 'ignored' })
    expect(connect).toHaveBeenCalledWith(handlers, { url: 'ignored' })
    expect(got).toBe(conn)
  })
})
