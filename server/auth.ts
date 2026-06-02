// Web access authentication — shared-token gate for LAN exposure.
//
// The server is safe by default on loopback (no auth). When bound to a
// non-loopback host (e.g. `--host 0.0.0.0` for phone access over a LAN)
// a shared token is REQUIRED. The token can be supplied three ways, in
// precedence order:
//   1. `Authorization: Bearer <token>` header (scripts / curl)
//   2. `?token=<token>` query param (first visit from a phone)
//   3. `crw_token` cookie (steady state after the first visit)
//
// First-visit flow: the user opens `http://<lan-ip>:<port>/?token=XXXX`,
// the middleware validates the token, sets an httpOnly cookie, and 302s
// to the clean path. From then on the cookie carries auth on every REST
// request and on the same-origin WebSocket upgrade — the client needs no
// changes.
//
// IMPORTANT: web-auth state lives in this module's `webAuth` holder, NOT
// in the frozen `config` object. `applyParsedConfig` rebuilds and
// re-freezes `config` from DEFAULTS on every `PUT /api/config`, which
// would wipe auth state if it lived there.

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'

export const ACCESS_COOKIE = 'crw_token'

/** Cookie attributes. No `secure` flag — the LAN is plain HTTP, and a
 *  `secure` cookie would be dropped by the browser over http://. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30 // 30 days
export const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'Lax',
  path: '/',
  maxAge: COOKIE_MAX_AGE,
} as const

// --- web-auth state holder (decoupled from frozen `config`) -------------

interface WebAuthState {
  accessToken: string
  authEnabled: boolean
}

let webAuth: WebAuthState = { accessToken: '', authEnabled: false }

export function setWebAuth(accessToken: string, authEnabled: boolean): void {
  webAuth = { accessToken, authEnabled }
}

export function getWebAuth(): WebAuthState {
  return webAuth
}

// --- token comparison ---------------------------------------------------

/** Constant-time token comparison. Hashes both sides to fixed 32-byte
 *  SHA-256 digests so `timingSafeEqual` never throws on length mismatch
 *  (it requires equal-length buffers) and no length information leaks. */
export function tokensMatch(a: string, b: string): boolean {
  if (!a || !b) return false
  const da = createHash('sha256').update(a).digest()
  const db = createHash('sha256').update(b).digest()
  return timingSafeEqual(da, db)
}

// --- token extraction ---------------------------------------------------

function bearer(authHeader: string | undefined | null): string | undefined {
  if (!authHeader) return undefined
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim())
  return m ? m[1].trim() : undefined
}

/** Parse a `Cookie:` header value into a single named cookie's value. */
function cookieFromHeader(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim())
    }
  }
  return undefined
}

/** Extract a candidate token from a Hono request context. */
export function extractTokenFromHono(c: Context): string | undefined {
  return (
    bearer(c.req.header('authorization')) ??
    c.req.query('token') ??
    getCookie(c, ACCESS_COOKIE)
  )
}

/** Extract a candidate token from a raw Node upgrade request (WebSocket).
 *  No Hono helpers are available here, so cookie/query are parsed by hand. */
export function extractTokenFromReq(req: IncomingMessage): string | undefined {
  const fromBearer = bearer(
    Array.isArray(req.headers.authorization)
      ? req.headers.authorization[0]
      : req.headers.authorization,
  )
  if (fromBearer) return fromBearer

  let fromQuery: string | undefined
  try {
    fromQuery = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') ?? undefined
  } catch {
    /* malformed URL — fall through to cookie */
  }
  if (fromQuery) return fromQuery

  const cookieHeader = Array.isArray(req.headers.cookie)
    ? req.headers.cookie.join('; ')
    : req.headers.cookie
  return cookieFromHeader(cookieHeader, ACCESS_COOKIE)
}

// --- 401 hint page ------------------------------------------------------

const LOGIN_HINT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Access token required</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #0f1115; color: #e6e6e6;
    display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1.5rem; }
  .card { max-width: 32rem; background: #181b21; border: 1px solid #2a2f3a; border-radius: 12px; padding: 1.75rem 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  p { line-height: 1.55; color: #b8c0cc; margin: 0.5rem 0; }
  code { background: #11141a; padding: 0.15rem 0.4rem; border-radius: 5px; color: #8fd3ff; }
</style>
</head>
<body>
  <div class="card">
    <h1>🔒 Access token required</h1>
    <p>This server is protected. Open the link printed in the server console — it looks like
       <code>http://&lt;ip&gt;:&lt;port&gt;/?token=…</code> — to sign in.</p>
    <p>The token is shown where you started <code>claude-react-web</code>.</p>
  </div>
</body>
</html>`

// --- HTTP middleware ----------------------------------------------------

/** Hono middleware enforcing the shared-token gate. No-op when auth is
 *  disabled (loopback host with no configured token). */
export function buildAuthMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const { accessToken, authEnabled } = webAuth
    if (!authEnabled) return next()

    const token = extractTokenFromHono(c)
    const ok = !!token && tokensMatch(token, accessToken)

    if (ok) {
      // Refresh / set the cookie on every authorized request so it stays
      // alive and so a first visit via ?token= persists.
      setCookie(c, ACCESS_COOKIE, accessToken, COOKIE_OPTS)
      // If the token arrived via the query string on a page navigation,
      // strip it from the URL (keeps it out of history / referer) by
      // redirecting to the clean path. The cookie was just set, so the
      // redirect passes. Only for non-API GETs — API callers that pass
      // ?token= want their data, not a redirect.
      if (
        c.req.method === 'GET' &&
        !c.req.path.startsWith('/api/') &&
        c.req.query('token') != null
      ) {
        const url = new URL(c.req.url)
        url.searchParams.delete('token')
        const clean = url.pathname + (url.search ? url.search : '') + url.hash
        return c.redirect(clean, 302)
      }
      return next()
    }

    // Unauthorized.
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    return c.html(LOGIN_HINT_HTML, 401)
  }
}

// --- WebSocket upgrade gate ---------------------------------------------

/** Authorize a raw WebSocket upgrade request. Returns true when auth is
 *  disabled or the request carries a valid token (cookie / query / bearer). */
export function isUpgradeAuthorized(req: IncomingMessage): boolean {
  const { accessToken, authEnabled } = webAuth
  if (!authEnabled) return true
  const token = extractTokenFromReq(req)
  return !!token && tokensMatch(token, accessToken)
}
