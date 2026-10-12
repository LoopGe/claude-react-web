// End-to-end (in-process) checks of the HTTP security boundary assembled by
// buildApp: the request guard (Host allowlist + Origin rule on writes), the
// exact-origin CORS reflection, and the JSON Content-Type requirement.

import { describe, expect, it } from 'vitest'
import { buildApp } from './app.js'

const BIND = { host: '127.0.0.1', port: 3499 }
const BASE = `http://127.0.0.1:${BIND.port}`

describe('production runtime (no trustDevOrigins)', () => {
  const { app } = buildApp({ bind: BIND })

  it('403s a write from the Vite dev origin and does not CORS-reflect it', async () => {
    const res = await app.request(`${BASE}/api/sessions/does-not-exist/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5174' },
      body: JSON.stringify({ model: 'x' }),
    })
    expect(res.status).toBe(403)
    const pre = await app.request(`${BASE}/api/sessions`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5174', 'access-control-request-method': 'POST' },
    })
    expect(pre.headers.get('access-control-allow-origin')).toBeFalsy()
  })
})

describe('buildApp security boundary (bound to 127.0.0.1:3499, dev runtime)', () => {
  const { app } = buildApp({ bind: BIND, trustDevOrigins: true })

  const writeModel = (headers: Record<string, string>, body = JSON.stringify({ model: 'x' })) =>
    app.request(`${BASE}/api/sessions/does-not-exist/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    })

  describe('Host allowlist (DNS rebinding)', () => {
    it('allows the bound loopback host', async () => {
      const res = await app.request(`${BASE}/api/health`)
      expect(res.status).toBe(200)
    })

    it('allows localhost on the bound port', async () => {
      const res = await app.request(`${BASE}/api/health`, { headers: { host: `localhost:${BIND.port}` } })
      expect(res.status).toBe(200)
    })

    it('403s a foreign Host', async () => {
      const res = await app.request(`${BASE}/api/health`, { headers: { host: 'evil.example:3499' } })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'forbidden: host not allowed' })
    })

    it('403s a loopback Host on the wrong port', async () => {
      const res = await app.request(`${BASE}/api/health`, { headers: { host: '127.0.0.1:9999' } })
      expect(res.status).toBe(403)
    })

    it('403s a rebinding Host on API and non-API paths', async () => {
      const api = await app.request(`${BASE}/api/health`, { headers: { host: 'rebind.attacker.example:3499' } })
      expect(api.status).toBe(403)
      const page = await app.request(`${BASE}/`, { headers: { host: 'attacker.example:3499' } })
      expect(page.status).toBe(403)
      expect(await page.text()).toBe('Forbidden')
    })
  })

  describe('Origin rule on writes (CSRF)', () => {
    it('403s a cross-origin POST', async () => {
      const res = await writeModel({ origin: 'https://evil.example' })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'forbidden: origin not allowed' })
    })

    it('403s Origin: null (sandboxed iframe / file://)', async () => {
      const res = await writeModel({ origin: 'null' })
      expect(res.status).toBe(403)
    })

    it('allows a same-origin POST', async () => {
      const res = await writeModel({ origin: BASE })
      expect(res.status).toBe(404)
    })

    it('allows the Vite dev origin', async () => {
      const res = await writeModel({ origin: 'http://localhost:5174' })
      expect(res.status).toBe(404)
      const res2 = await writeModel({ origin: 'http://127.0.0.1:5174' })
      expect(res2.status).toBe(404)
    })

    it('allows a POST with no Origin (curl / CLI)', async () => {
      const res = await writeModel({})
      expect(res.status).toBe(404)
    })

    it('does not block a cross-origin GET, but does not CORS-expose it', async () => {
      const res = await app.request(`${BASE}/api/health`, { headers: { origin: 'https://evil.example' } })
      expect(res.status).toBe(200)
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })
  })

  describe('exact-origin CORS reflection', () => {
    const preflight = (origin: string) =>
      app.request(`${BASE}/api/sessions`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      })

    it('does not reflect another loopback port', async () => {
      const res = await preflight('http://localhost:9999')
      expect(res.headers.get('access-control-allow-origin')).toBeFalsy()
    })

    it('reflects the Vite dev origin', async () => {
      const res = await preflight('http://localhost:5174')
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5174')
    })

    it('reflects the bound origin', async () => {
      const res = await preflight(BASE)
      expect(res.headers.get('access-control-allow-origin')).toBe(BASE)
    })
  })

  describe('JSON Content-Type on writes', () => {
    it('415s a text/plain JSON body', async () => {
      const res = await writeModel({ origin: BASE, 'content-type': 'text/plain;charset=UTF-8' })
      expect(res.status).toBe(415)
      expect(await res.json()).toEqual({ error: 'Content-Type must be application/json' })
    })

    it('415s a JSON body with no Content-Type', async () => {
      const res = await app.request(`${BASE}/api/sessions/does-not-exist/model`, {
        method: 'POST',
        body: new Blob([JSON.stringify({ model: 'x' })]),
      })
      expect(res.status).toBe(415)
    })

    it('passes application/json (with charset) through to the handler', async () => {
      const res = await writeModel({ 'content-type': 'application/json; charset=utf-8' })
      expect(res.status).toBe(404)
    })

    it('415s text/plain on POST /api/fs/mkdir', async () => {
      const res = await app.request(`${BASE}/api/fs/mkdir`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ parent: '/tmp', name: 'x' }),
      })
      expect(res.status).toBe(415)
    })

    it('keeps POST /api/fs/mkdir malformed-JSON as 400', async () => {
      const res = await app.request(`${BASE}/api/fs/mkdir`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      })
      expect(res.status).toBe(400)
    })
  })
})

describe('buildApp with no bind (desktop crw:// in-process path)', () => {
  const { app } = buildApp()

  it('installs no Host/Origin guard', async () => {
    // The desktop host forwards renderer requests as crw://app/api/... with
    // Origin crw://app and no TCP listener (desktop/main.ts registerProtocol).
    const res = await app.fetch(new Request('crw://app/api/health', { headers: { origin: 'crw://app' } }))
    expect(res.status).toBe(200)
    const res2 = await app.request('/api/health', { headers: { host: 'evil.example' } })
    expect(res2.status).toBe(200)
  })

  it('still accepts the desktop renderer JSON write shape', async () => {
    // webRequest sets Content-Type: application/json for every body, and
    // desktop/main.ts copies the renderer headers onto the in-process Request.
    const res = await app.fetch(new Request('crw://app/api/sessions/does-not-exist/model', {
      method: 'POST',
      headers: { origin: 'crw://app', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x' }),
    }))
    expect(res.status).toBe(404)
  })
})
