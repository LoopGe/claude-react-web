// Web-access auth gate: login, JSON-only login body, and the failure limiter
// keyed on the TCP peer address (never X-Forwarded-For / X-Real-IP).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { Hono } from 'hono'
import {
  ACCESS_COOKIE,
  __resetAuthRateLimitForTest,
  authorizeUpgrade,
  buildAuthMiddleware,
  setWebAuth,
} from './auth.js'

const TOKEN = 'secret-token'
const BASE = 'http://127.0.0.1:3499'

function makeApp() {
  const app = new Hono()
  app.use('*', buildAuthMiddleware())
  app.get('/api/ping', (c) => c.json({ ok: true }))
  app.get('/', (c) => c.text('home'))
  return app
}

/** @hono/node-server exposes the Node IncomingMessage as `c.env.incoming`. */
const peer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } })

function login(
  app: Hono,
  token: string,
  opts: { addr?: string; headers?: Record<string, string>; contentType?: string } = {},
) {
  return app.request(
    `${BASE}/api/auth/login`,
    {
      method: 'POST',
      headers: { 'content-type': opts.contentType ?? 'application/json', ...opts.headers },
      body: JSON.stringify({ token }),
    },
    opts.addr === undefined ? undefined : peer(opts.addr),
  )
}

describe('auth middleware', () => {
  let app: Hono

  beforeEach(() => {
    setWebAuth(TOKEN, true)
    app = makeApp()
  })

  afterEach(() => {
    setWebAuth('', false)
    __resetAuthRateLimitForTest()
    vi.useRealTimers()
  })

  it('is a no-op when auth is disabled', async () => {
    setWebAuth('', false)
    const res = await app.request(`${BASE}/api/ping`)
    expect(res.status).toBe(200)
    expect((await app.request(`${BASE}/`)).status).toBe(200)
  })

  it('valid login → 200 + cookie', async () => {
    const res = await login(app, TOKEN, { addr: '192.168.1.50' })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain(`${ACCESS_COOKIE}=`)
  })

  it('login with text/plain → 415', async () => {
    const res = await login(app, TOKEN, { addr: '192.168.1.50', contentType: 'text/plain' })
    expect(res.status).toBe(415)
  })

  it('5 bad logins → 401, the 6th → 429', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login(app, 'wrong', { addr: '192.168.1.50' })).status).toBe(401)
    }
    expect((await login(app, 'wrong', { addr: '192.168.1.50' })).status).toBe(429)
    // A correct token is also refused while limited.
    expect((await login(app, TOKEN, { addr: '192.168.1.50' })).status).toBe(429)
  })

  it('a rotating X-Forwarded-For / X-Real-IP does not bypass the limit', async () => {
    for (let i = 0; i < 6; i++) {
      const res = await login(app, 'wrong', {
        addr: '192.168.1.50',
        headers: { 'x-forwarded-for': `10.0.0.${i}`, 'x-real-ip': `10.0.1.${i}` },
      })
      expect(res.status).toBe(i < 5 ? 401 : 429)
    }
  })

  it('spoofing XFF to a limited address does not shift the limit to another peer', async () => {
    for (let i = 0; i < 5; i++) await login(app, 'wrong', { addr: '192.168.1.50' })
    const res = await login(app, TOKEN, { addr: '192.168.1.51', headers: { 'x-forwarded-for': '192.168.1.50' } })
    expect(res.status).toBe(200)
  })

  it('other peers are unaffected; ::ffff:-mapped IPv4 shares the bucket', async () => {
    for (let i = 0; i < 5; i++) await login(app, 'wrong', { addr: '192.168.1.50' })
    expect((await login(app, TOKEN, { addr: '192.168.1.51' })).status).toBe(200)
    expect((await login(app, TOKEN, { addr: '::ffff:192.168.1.50' })).status).toBe(429)
  })

  it('no peer address (in-process) is still limited under one shared bucket', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login(app, 'wrong')).status).toBe(401)
    }
    expect((await login(app, 'wrong')).status).toBe(429)
  })

  it('missing token stays 400 and is not counted', async () => {
    for (let i = 0; i < 8; i++) {
      expect((await login(app, '', { addr: '192.168.1.50' })).status).toBe(400)
    }
    expect((await login(app, TOKEN, { addr: '192.168.1.50' })).status).toBe(200)
  })

  it('counts failed Bearer attempts on other /api routes, then 429 until the window resets', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const ping = (token: string) =>
      app.request(`${BASE}/api/ping`, { headers: { authorization: `Bearer ${token}` } }, peer('192.168.1.60'))
    for (let i = 0; i < 5; i++) expect((await ping('wrong')).status).toBe(401)
    expect((await ping('wrong')).status).toBe(429)
    expect((await ping(TOKEN)).status).toBe(429)
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'))
    expect((await ping(TOKEN)).status).toBe(200)
  })

  it('never counts bad cookies (stale cookie after a token rotation)', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await app.request(
        `${BASE}/api/ping`,
        { headers: { cookie: `${ACCESS_COOKIE}=stale` } },
        peer('192.168.1.70'),
      )
      expect(res.status).toBe(401)
    }
    expect((await login(app, TOKEN, { addr: '192.168.1.70' })).status).toBe(200)
  })

  it('counts failed ?token= guesses, then 429 even for the right token', async () => {
    const visit = (token: string, path = '/') =>
      app.request(`${BASE}${path}?token=${encodeURIComponent(token)}`, {}, peer('192.168.1.90'))
    for (let i = 0; i < 5; i++) expect((await visit(`guess${i}`)).status).toBe(401)
    expect((await visit(TOKEN)).status).toBe(429)
    expect((await visit(TOKEN, '/api/ping')).status).toBe(429)
    // A cookie-carried request from the same peer is not gated by the limit.
    const res = await app.request(`${BASE}/api/ping`, { headers: { cookie: `${ACCESS_COOKIE}=${TOKEN}` } }, peer('192.168.1.90'))
    expect(res.status).toBe(200)
  })

  it('a valid ?token= first visit still redirects to the clean path', async () => {
    const res = await app.request(`${BASE}/?token=${TOKEN}`, {}, peer('192.168.1.91'))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
  })
})

describe('authorizeUpgrade', () => {
  const req = (headers: Record<string, string>, remoteAddress = '192.168.1.80') =>
    ({ headers, url: '/api/ws', socket: { remoteAddress } }) as unknown as IncomingMessage

  beforeEach(() => setWebAuth(TOKEN, true))
  afterEach(() => {
    setWebAuth('', false)
    __resetAuthRateLimitForTest()
  })

  it('ok for a valid cookie', () => {
    expect(authorizeUpgrade(req({ cookie: `${ACCESS_COOKIE}=${TOKEN}` }))).toBe('ok')
  })

  it('unauthorized for no token', () => {
    expect(authorizeUpgrade(req({}))).toBe('unauthorized')
  })

  it('bad Bearer ×5 then rate-limited (even with the right token)', () => {
    for (let i = 0; i < 5; i++) {
      expect(authorizeUpgrade(req({ authorization: 'Bearer wrong' }))).toBe('unauthorized')
    }
    expect(authorizeUpgrade(req({ authorization: 'Bearer wrong' }))).toBe('rate-limited')
    expect(authorizeUpgrade(req({ authorization: `Bearer ${TOKEN}` }))).toBe('rate-limited')
    // A different peer is unaffected.
    expect(authorizeUpgrade(req({ authorization: `Bearer ${TOKEN}` }, '192.168.1.81'))).toBe('ok')
  })

  it('counts failed ?token= upgrades too', () => {
    const q = (token: string) =>
      ({ headers: {}, url: `/api/ws?token=${encodeURIComponent(token)}`, socket: { remoteAddress: '192.168.1.82' } }) as unknown as IncomingMessage
    for (let i = 0; i < 5; i++) expect(authorizeUpgrade(q('wrong'))).toBe('unauthorized')
    expect(authorizeUpgrade(q(TOKEN))).toBe('rate-limited')
  })

  it('ok when auth is disabled', () => {
    setWebAuth('', false)
    expect(authorizeUpgrade(req({}))).toBe('ok')
  })
})

describe('cross-site ?token= failures use a separate bucket (Sec-Fetch-Site)', () => {
  let app: Hono

  beforeEach(() => {
    __resetAuthRateLimitForTest()
    setWebAuth(TOKEN, true)
    app = makeApp()
  })

  afterEach(() => {
    setWebAuth('', false)
    __resetAuthRateLimitForTest()
  })

  const visit = (token: string, headers: Record<string, string> = {}) =>
    app.request(`${BASE}/?token=${encodeURIComponent(token)}`, { headers }, peer('192.168.1.100'))

  it('cross-site ?token= failures do not 429 the header-less sign-in', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await visit('x', { 'sec-fetch-site': 'cross-site' })).status).toBe(401)
    }
    expect((await visit(TOKEN)).status).toBe(302)
  })

  it('a client forging Sec-Fetch-Site: cross-site is still limited (6th attempt → 429)', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await visit('x', { 'sec-fetch-site': 'cross-site' })).status).toBe(401)
    }
    expect((await visit('x', { 'sec-fetch-site': 'cross-site' })).status).toBe(429)
    // Even the right token is refused in that bucket, while the
    // header-less (same-origin) sign-in from the same peer still works.
    expect((await visit(TOKEN, { 'sec-fetch-site': 'cross-site' })).status).toBe(429)
    expect((await visit(TOKEN)).status).toBe(302)
  })

  it('a cross-site Bearer failure is counted in the peer bucket', async () => {
    const api = (auth: string, headers: Record<string, string> = {}) =>
      app.request(`${BASE}/api/ping`, { headers: { authorization: auth, ...headers } }, peer('192.168.1.102'))
    for (let i = 0; i < 5; i++) {
      expect((await api('Bearer wrong', { 'sec-fetch-site': 'cross-site' })).status).toBe(401)
    }
    expect((await api(`Bearer ${TOKEN}`)).status).toBe(429)
  })

  it('header-less failures are still counted (6th presented attempt → 429)', async () => {
    for (let i = 0; i < 5; i++) expect((await visit('x')).status).toBe(401)
    expect((await visit('x')).status).toBe(429)
  })

  it('same-site failures are counted', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await visit('x', { 'sec-fetch-site': 'same-site' })).status).toBe(401)
    }
    expect((await visit(TOKEN, { 'sec-fetch-site': 'same-site' })).status).toBe(429)
  })

  it('authorizeUpgrade counts cross-site ?token= failures in their own bucket', () => {
    const q = (token: string, headers: Record<string, string | string[]> = {}) =>
      ({ headers, url: `/api/ws?token=${encodeURIComponent(token)}`, socket: { remoteAddress: '192.168.1.101' } }) as unknown as IncomingMessage
    for (let i = 0; i < 5; i++) {
      expect(authorizeUpgrade(q('wrong', { 'sec-fetch-site': 'Cross-Site' }))).toBe('unauthorized')
    }
    expect(authorizeUpgrade(q('wrong', { 'sec-fetch-site': 'Cross-Site' }))).toBe('rate-limited')
    expect(authorizeUpgrade(q(TOKEN))).toBe('ok')
  })
})
