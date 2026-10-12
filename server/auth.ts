// Web access authentication — shared-token gate for LAN exposure.
//
// The server is safe by default on loopback (no auth). When bound to a
// non-loopback host (e.g. `--host 0.0.0.0` for phone access over a LAN)
// a shared token is REQUIRED. The token can be supplied three ways, in
// precedence order:
//   1. `Authorization: Bearer <token>` header (scripts / curl)
//   2. `→ token=<token>` query param (first visit from a phone)
//   3. `crw_token` cookie (steady state after the first visit)
//
// First-visit flow: the user opens `http://<lan-ip>:<port>/→ token=XXXX`,
// the middleware validates the token, sets an httpOnly cookie, and 302s
// to the clean path. From then on the cookie carries auth on every REST
// request and on the same-origin WebSocket upgrade — the client needs no
// changes.
//
// Brute-force limiting: failed login attempts and failed explicitly
// presented tokens (`Authorization: Bearer` or `?token=`, HTTP and WS
// upgrade) are counted per TCP peer address (never X-Forwarded-For — there
// is no trust-proxy setting). After 5 failures in a minute, further login /
// Bearer / ?token= attempts get 429. Cookie failures are not counted (a
// stale cookie after a token rotation must not lock the user out).
// A `?token=` attempt carrying `Sec-Fetch-Site: cross-site` (and no Bearer)
// is counted in a separate per-peer bucket, so a hostile page firing
// `<img src="…?token=x">` can't 429 a LAN user's next sign-in. Any client
// can forge that header, so the separate bucket has the same 5/min limit:
// a forging client gets at most one extra bucket, never an unlimited one.
//
// IMPORTANT: web-auth state lives in this module's `webAuth` holder, NOT
// in the frozen `config` object. `applyParsedConfig` rebuilds and
// re-freezes `config` from DEFAULTS on every `PUT /api/config`, which
// would wipe auth state if it lived there.

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { isJsonContentType } from './request-guard.js'

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

/** Parse a `Cookie:` header value into a single name cookie's value. */
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

// --- 401 login page -----------------------------------------------------

const LOGIN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#0f1115" media="(prefers-color-scheme: dark)" />
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔐</text></svg>" />
<title>Sign in — claude-react-web</title>
<style>
  /* Colors sourced from tokens.css — keep in sync. */
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    background: #0f1115; color: #e6e8eb;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; margin: 0; padding: 1.5rem;
  }
  .card {
    max-width: 26rem; width: 100%;
    background: #15181f; border: 1px solid #262b36;
    border-radius: 12px; padding: 2rem;
  }
  h1 { font-size: 1.25rem; margin: 0 0 0.25rem; font-weight: 600; }
  .subtitle { color: #8c94a3; font-size: 0.85rem; margin: 0 0 1.5rem; line-height: 1.5; }
  label { display: block; font-size: 0.8rem; font-weight: 500; color: #8c94a3; margin-bottom: 0.4rem; }
  input[type="text"] {
    width: 100%; padding: 0.65rem 0.8rem;
    background: #0f1115; border: 1px solid #262b36;
    border-radius: 8px; color: #e6e8eb; font-size: 0.95rem; font-family: inherit;
    outline: none; transition: border-color 0.15s;
  }
  input[type="text"]:focus { border-color: #7b8cde; }
  input[type="text"]::placeholder { color: #5e6774; }
  .error-wrap { min-height: 1.6rem; margin-top: 0.5rem; }
  .error {
    color: #f87171; font-size: 0.8rem; line-height: 1.4;
    animation: shake 0.3s ease-in-out;
  }
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    20%, 60% { transform: translateX(-4px); }
    40%, 80% { transform: translateX(4px); }
  }
  @media (prefers-reduced-motion: reduce) { .error { animation: none; } }
  button {
    width: 100%; margin-top: 1rem; padding: 0.7rem;
    background: #7b8cde; color: #ffffff;
    border: none; border-radius: 8px; font-size: 0.95rem; font-weight: 600;
    cursor: pointer; transition: background 0.15s, opacity 0.15s; font-family: inherit;
  }
  button:hover { background: #5b6fc7; }
  button:active { opacity: 0.85; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .hint { margin-top: 1.25rem; font-size: 0.78rem; color: #5e6774; line-height: 1.5; }
  .hint code { background: #0f1115; padding: 0.1rem 0.35rem; border-radius: 4px; color: #7b8cde; font-size: 0.75rem; }

  @media (prefers-color-scheme: light) {
    body { background: #ffffff; color: #1a1d24; }
    .card { background: #f5f6f8; border-color: #d0d4db; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
    h1 { color: #1a1d24; }
    .subtitle { color: #5e6774; }
    label { color: #5e6774; }
    input[type="text"] { background: #ffffff; border-color: #d0d4db; color: #1a1d24; }
    input[type="text"]:focus { border-color: #4f62c8; }
    input[type="text"]::placeholder { color: #8c94a3; }
    .error { color: #dc2626; }
    button { background: #4f62c8; }
    button:hover { background: #3b4ea8; }
    .hint { color: #8c94a3; }
    .hint code { background: #f5f6f8; color: #4f62c8; }
  }
</style>
</head>
<body>
  <div class="card">
    <h1>🔒 Sign in</h1>
    <p class="subtitle">Enter the access token to continue.</p>
    <form id="f" autocomplete="off">
      <label for="tok">Access token</label>
      <input id="tok" type="text" name="token" placeholder="Paste your token here" autofocus autocomplete="off" spellcheck="false" />
      <div class="error-wrap"><p id="err" class="error" role="alert" aria-live="assertive"></p></div>
      <button type="submit" id="btn">Sign in</button>
    </form>
    <p class="hint">The token is printed where you started <code>claude-react-web</code>, or set in <code>config.json</code>.</p>
  </div>
<script>
(function() {
  var f = document.getElementById('f');
  var err = document.getElementById('err');
  var btn = document.getElementById('btn');
  var inp = document.getElementById('tok');
  f.addEventListener('submit', function(e) {
    e.preventDefault();
    var token = inp.value.trim();
    if (!token) { err.textContent = 'Please enter a token.'; return; }
    err.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token })
    })
    .then(function(r) { return r.json().then(function(b) { return { ok: r.ok, body: b }; }); })
    .then(function(res) {
      if (res.ok && res.body.ok) {
        window.location.href = '/';
      } else {
        err.textContent = res.body.error || 'Invalid token.';
        btn.disabled = false;
        btn.textContent = 'Sign in';
        inp.select();
        inp.focus();
      }
    })
    .catch(function() {
      err.textContent = 'Network error. Check the server address.';
      btn.disabled = false;
      btn.textContent = 'Sign in';
    });
  });
})();
</script>
</body>
</html>`

// --- Rate limiting (failed auth attempts) ------------------------------
//
// Keyed on the TCP peer address, never on X-Forwarded-For / X-Real-IP:
// there is no trust-proxy setting, so those headers are attacker-chosen and
// would let every attempt land in a fresh bucket. Only FAILURES count.

const AUTH_FAIL_LIMIT = 5          // max failures per window
const AUTH_FAIL_WINDOW = 60_000    // 1 minute

/** Per-address failure tracker. Stale entries are pruned periodically. */
const authFailures = new Map<string, { count: number; resetAt: number }>()

/** `::ffff:1.2.3.4` and `1.2.3.4` are the same peer; a missing address
 *  (in-process request, Unix socket) shares one `'unknown'` bucket — it is
 *  still limited, not exempt. */
function normalizeAddress(addr: string | undefined): string {
  if (!addr) return 'unknown'
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr
}

/** Peer address of a Hono request served by @hono/node-server (`c.env.incoming`
 *  is the Node IncomingMessage — the same field its getConnInfo reads).
 *  Optional-chained because getConnInfo throws when `c.env` is absent
 *  (desktop in-process app.fetch, app.request in tests). */
function remoteKeyFromContext(c: Context): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  return normalizeAddress(env?.incoming?.socket?.remoteAddress)
}

function remoteKeyFromReq(req: IncomingMessage): string {
  return normalizeAddress(req.socket?.remoteAddress)
}

function isLimited(key: string): boolean {
  const entry = authFailures.get(key)
  if (!entry) return false
  if (Date.now() > entry.resetAt) {
    authFailures.delete(key)
    return false
  }
  return entry.count >= AUTH_FAIL_LIMIT
}

function recordFailure(key: string): void {
  const now = Date.now()
  const entry = authFailures.get(key)
  if (!entry || now > entry.resetAt) {
    authFailures.set(key, { count: 1, resetAt: now + AUTH_FAIL_WINDOW })
    return
  }
  entry.count++
}

/** True only for `Sec-Fetch-Site: cross-site`; `same-site`, `same-origin`,
 *  `none` and a missing header are false. */
function isCrossSiteFetch(value: string | string[] | undefined): boolean {
  const v = Array.isArray(value) ? value[0] : value
  return v?.trim().toLowerCase() === 'cross-site'
}

/** Failure bucket for an explicitly presented token (see the header
 *  comment). A cross-site `?token=` with no Bearer header goes to its own
 *  `|xs` bucket, so a hostile page's `<img src="…?token=x">` can't 429 the
 *  user's own sign-in. The header is client-controlled, so that bucket is
 *  still limited: a client forging it is capped like any other. Bearer
 *  always uses the peer bucket — a cross-site page can't attach
 *  `Authorization` without a CORS preflight the request guard rejects. */
function failureBucket(
  key: string,
  hasBearer: boolean,
  secFetchSite: string | string[] | undefined,
): string {
  return !hasBearer && isCrossSiteFetch(secFetchSite) ? `${key}|xs` : key
}

/** Test hook: clear every failure bucket. */
export function __resetAuthRateLimitForTest(): void {
  authFailures.clear()
}

// Prune stale entries every 5 min so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of authFailures) {
    if (now > entry.resetAt) authFailures.delete(key)
  }
}, 300_000).unref()

// --- HTTP middleware ----------------------------------------------------

/** Hono middleware enforcing the shared-token gate. No-op when auth is
 *  disabled (loopback host with no configured token).
 *
 *  `POST /api/auth/login` is whitelisted so the login page can verify a
 *  token without already carrying one. */
export function buildAuthMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const { accessToken, authEnabled } = webAuth
    if (!authEnabled) return next()

    // --- Login endpoint (no token required) ---
    const key = remoteKeyFromContext(c)

    if (c.req.method === 'POST' && c.req.path === '/api/auth/login') {
      if (isLimited(key)) {
        return c.json({ ok: false, error: 'Too many attempts. Try again in a minute.' }, 429)
      }
      // Same JSON-only rule as safeJsonValue: a cross-site text/plain POST
      // must not reach the token check.
      if (!isJsonContentType(c.req.header('content-type'))) {
        return c.json({ ok: false, error: 'Content-Type must be application/json.' }, 415)
      }
      let body: { token?: string } | null = null
      try { body = await c.req.json() } catch { /* ignore */ }
      const provided = body?.token?.trim()
      if (!provided) return c.json({ ok: false, error: 'Missing token.' }, 400)
      if (!tokensMatch(provided, accessToken)) {
        recordFailure(key)
        return c.json({ ok: false, error: 'Invalid token.' }, 401)
      }
      setCookie(c, ACCESS_COOKIE, accessToken, COOKIE_OPTS)
      return c.json({ ok: true })
    }

    // Explicitly presented tokens (Bearer header or ?token=) are
    // rate-limited/counted. Cookie failures are NOT counted: the
    // auto-generated LAN token changes on every restart, so a phone's stale
    // cookie fails on every asset of a page load and would 429 the user's
    // next login. ?token= is safe to count — the app never sends it itself;
    // only a first-visit document URL carries it, so a stale QR link costs
    // one failure.
    const hasBearer = bearer(c.req.header('authorization')) !== undefined
    const presented = hasBearer || c.req.query('token') !== undefined
    const bucket = failureBucket(key, hasBearer, c.req.header('sec-fetch-site'))
    if (presented && isLimited(bucket)) {
      if (c.req.path.startsWith('/api/')) return c.json({ error: 'too many failed attempts' }, 429)
      return c.text('Too many failed attempts. Try again in a minute.', 429)
    }
    const token = extractTokenFromHono(c)
    const ok = !!token && tokensMatch(token, accessToken)
    if (!ok && presented) recordFailure(bucket)

    if (ok) {
      // Refresh / set the cookie on every authorized request so it stays
      // alive and so a first visit via — token= persists.
      setCookie(c, ACCESS_COOKIE, accessToken, COOKIE_OPTS)
      // If the token arrived via the query string on a page navigation,
      // strip it from the URL (keeps it out of history / referer) by
      // redirecting to the clean path. The cookie was just set, so the
      // redirect passes. Only for non-API GETs — API callers that pass
      // — token= want their data, not a redirect.
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
    return c.html(LOGIN_PAGE_HTML, 401)
  }
}

// --- WebSocket upgrade gate ---------------------------------------------

/** Authorize a raw WebSocket upgrade request. `'ok'` when auth is disabled
 *  or the request carries a valid token (cookie / query / bearer). A Bearer
 *  header or `?token=` presented while the peer is over the failure limit is
 *  `'rate-limited'`; a failed Bearer / `?token=` is counted (cookie
 *  failures are not — same rule as the HTTP middleware). */
export function authorizeUpgrade(req: IncomingMessage): 'ok' | 'unauthorized' | 'rate-limited' {
  const { accessToken, authEnabled } = webAuth
  if (!authEnabled) return 'ok'
  const key = remoteKeyFromReq(req)
  const bearerToken = bearer(
    Array.isArray(req.headers.authorization)
      ? req.headers.authorization[0]
      : req.headers.authorization,
  )
  let queryToken: string | null = null
  try { queryToken = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') } catch { /* malformed */ }
  const hasBearer = bearerToken !== undefined
  const presented = hasBearer || queryToken !== null
  const bucket = failureBucket(key, hasBearer, req.headers['sec-fetch-site'])
  if (presented && isLimited(bucket)) return 'rate-limited'
  const token = extractTokenFromReq(req)
  if (!!token && tokensMatch(token, accessToken)) return 'ok'
  if (presented) recordFailure(bucket)
  return 'unauthorized'
}
