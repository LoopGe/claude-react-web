import { afterEach, describe, expect, it, vi } from 'vitest'
import { testConnection } from './config-test-connection.js'

// The SSRF guard resolves the hostname over real DNS; stub it so these tests
// exercise only the response classification.
vi.mock('./ssrf.js', () => ({ validateOutboundUrl: async () => ({ ok: true }) }))

const BASE = 'https://gw.example'
const SENTINEL = '__claude_react_web_connection_test__'

/** Reply with a JSON body and a status. */
function reply(status: number, body: unknown) {
  return vi.fn(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

/** Last request body the probe sent (to assert which model was probed). */
function sentModel(fetchMock: ReturnType<typeof vi.fn>): string {
  const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit
  return JSON.parse(String(init.body)).model as string
}

describe('testConnection', () => {
  const originalFetch = global.fetch
  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  describe('sentinel probe (no model given — the token+URL-first flow)', () => {
    it('reports ok for the official-API "model not found" bounce', async () => {
      const fetchMock = reply(404, { error: { type: 'not_found_error', message: 'model: unknown' } })
      global.fetch = fetchMock as unknown as typeof fetch

      const r = await testConnection('sk-good', BASE)
      expect(r.status).toBe(200)
      expect(r.body).toMatchObject({ ok: true })
      expect(sentModel(fetchMock)).toBe(SENTINEL)
    })

    it('does NOT claim an invalid token for a gateway 401/invalid_key envelope', async () => {
      // Verified live: a third-party gateway answers exactly this shape both
      // for a bad key ("API Key 不存在") and for a model it cannot route
      // ("该模型未指定供应商"), so no verdict can be honest — report the
      // provider's own words, and never the internal sentinel model id.
      global.fetch = reply(401, {
        error: { message: '该模型未指定供应商', param: 'Please provide valid API Key', code: '401', type: 'invalid_key' },
      }) as unknown as typeof fetch

      const r = await testConnection('sk-maybe-good', BASE)
      const body = r.body as { ok: boolean; status?: number; error?: string }
      expect(body.ok).toBe(false)
      expect(body.status).toBe(401)
      expect(body.error).toContain('该模型未指定供应商')
      expect(body.error).not.toBe('Invalid auth token')
      expect(body.error).not.toContain(SENTINEL)
    })

    it('reports an auth-shaped envelope as an invalid token', async () => {
      global.fetch = reply(403, {
        error: { type: 'permission_error', message: 'key lacks access' },
      }) as unknown as typeof fetch

      const r = await testConnection('sk-bad', BASE)
      expect(r.body).toMatchObject({ ok: false, error: 'Invalid auth token: key lacks access' })
    })
  })

  describe('real-model probe (the profile-test flow)', () => {
    it('reports ok on a 2xx and probes the model it was given', async () => {
      const fetchMock = reply(200, { content: [{ type: 'text', text: 'pong' }] })
      global.fetch = fetchMock as unknown as typeof fetch

      const r = await testConnection('sk-good', BASE, { model: 'vendor/model-a' })
      expect(r.body).toMatchObject({ ok: true })
      expect(sentModel(fetchMock)).toBe('vendor/model-a')
    })

    it('names the model when the endpoint rejects a model it does not serve', async () => {
      global.fetch = reply(404, {
        error: { type: 'not_found_error', message: 'model not found' },
      }) as unknown as typeof fetch

      const r = await testConnection('sk-good', BASE, { model: 'vendor/nope' })
      const body = r.body as { ok: boolean; error?: string }
      expect(body.ok).toBe(false)
      expect(body.error).toContain('vendor/nope')
      expect(body.error).toContain('model not found')
    })

    it('surfaces the provider wording for an ambiguous 401 and names the model', async () => {
      global.fetch = reply(401, {
        error: { message: 'API Key 不存在', type: 'invalid_key' },
      }) as unknown as typeof fetch

      const r = await testConnection('sk-bad', BASE, { model: 'vendor/model-a' })
      const body = r.body as { ok: boolean; status?: number; error?: string }
      expect(body.ok).toBe(false)
      expect(body.status).toBe(401)
      expect(body.error).toContain('API Key 不存在')
      expect(body.error).toContain('vendor/model-a')
    })

    it('reports an authentication_error as a bad token even on a real-model probe', async () => {
      // `authentication_error` is about the credential by definition, so it is
      // the one verdict worth asserting even when a model is on the wire.
      global.fetch = reply(401, {
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      }) as unknown as typeof fetch

      const r = await testConnection('sk-typo', BASE, { model: 'vendor/model-a' })
      expect(r.body).toMatchObject({ ok: false, error: 'Invalid auth token: invalid x-api-key' })
    })

    it('reports a rate limit as provider-side, not as a model rejection', async () => {
      // A 429 says nothing about the model: everything the user configured
      // was accepted, so it must not read as "this model is wrong".
      global.fetch = reply(429, {
        error: { type: 'rate_limit_error', message: 'rate limit exceeded' },
      }) as unknown as typeof fetch

      const r = await testConnection('sk-good', BASE, { model: 'vendor/model-a' })
      const body = r.body as { ok: boolean; error?: string }
      expect(body.ok).toBe(false)
      expect(body.error).toContain('429')
      expect(body.error).toContain('rate limit exceeded')
      expect(body.error).toContain('the credentials and model were accepted')
      expect(body.error).not.toContain('rejected the request')
    })

    it('does not blame the token for a model-entitlement error on a real model', async () => {
      // A 403 permission_error against a specific model is at least as likely
      // to be about the model as about the key, so the message must name the
      // model instead of asserting "Invalid auth token".
      global.fetch = reply(403, {
        error: { type: 'permission_error', message: 'not entitled to this model' },
      }) as unknown as typeof fetch

      const r = await testConnection('sk-good', BASE, { model: 'vendor/premium' })
      const body = r.body as { ok: boolean; error?: string }
      expect(body.ok).toBe(false)
      expect(body.error).toContain('vendor/premium')
      expect(body.error).toContain('not entitled to this model')
      expect(body.error).not.toContain('Invalid auth token')
    })
  })

  describe('auth failures', () => {
    it('reports the Anthropic auth error type verbatim', async () => {
      global.fetch = reply(401, {
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      }) as unknown as typeof fetch

      const r = await testConnection('sk-bad', BASE)
      expect(r.body).toMatchObject({ ok: false, error: 'Invalid auth token: invalid x-api-key' })
    })

    it('reports a bodyless 401 as an invalid token (proxies that strip bodies)', async () => {
      global.fetch = reply(401, '') as unknown as typeof fetch

      const r = await testConnection('sk-bad', BASE)
      expect(r.body).toMatchObject({ ok: false, status: 401, error: 'Invalid auth token' })
    })
  })

  describe('transport failures', () => {
    it('flags a 404 with a non-API body as a bad Base URL', async () => {
      global.fetch = reply(404, '<html>nginx</html>') as unknown as typeof fetch

      const r = await testConnection('sk-good', BASE)
      expect(r.body).toMatchObject({ ok: false, status: 404, error: 'Endpoint not found — check the Base URL' })
    })

    it('folds a network error into the result instead of throwing', async () => {
      global.fetch = vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch

      const r = await testConnection('sk-good', BASE)
      expect(r.body).toMatchObject({ ok: false })
      expect((r.body as { error: string }).error).toContain('Could not reach')
    })
  })
})