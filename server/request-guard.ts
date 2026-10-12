// Request guard — Host allowlist + Origin rule shared by HTTP and the WS
// upgrade, plus the JSON Content-Type predicate used by safeJsonValue.
//
// Threat model: the server listens on loopback without auth by default, so
// any web page the user visits can aim requests at it. Three browser-side
// attacks are closed here:
//   - DNS rebinding: an attacker hostname re-resolved to 127.0.0.1 makes the
//     page "same-origin" with us. The browser still sends `Host: attacker…`,
//     so a Host allowlist (loopback names, the bound host, LAN IPs when
//     LAN-bound — all on the bound port) rejects it.
//   - Cross-site writes (CSRF): a foreign page can POST "simple" requests
//     without preflight. Writes carrying a foreign `Origin` are refused.
//     (JSON writes additionally need `Content-Type: application/json`, which
//     a cross-site form/no-cors fetch cannot send without a preflight.)
//   - Cross-site WebSocket hijack: WS upgrades are not covered by CORS, so the
//     upgrade gets the same Origin rule.
//
// The guard is only installed when the app has a real TCP bind. The desktop
// host serves `crw://app` through in-process `app.fetch` with no listener, so
// there is no Host/Origin to defend (and its requests carry Host `app`).
//
// Keep this module free of config/session imports so both transports (and
// their tests) can construct it cheaply.

import type { IncomingMessage } from 'node:http'
import type { Context, MiddlewareHandler } from 'hono'
import { isLoopbackHost, lanIPv4Addresses } from './net.js'
import { createLogger } from './log.js'

const log = createLogger('guard')

export interface BindAddress {
  host: string
  port: number
}

/** Vite dev server port default — mirrors vite.config.ts (`VITE_PORT || 5174`). */
export const DEFAULT_VITE_PORT = 5174

/** Origins of the Vite dev server. Its `/api` proxy uses `changeOrigin`, which
 *  rewrites Host to the API target but leaves Origin as the dev page origin,
 *  so these must be trusted for dev-mode writes and the proxied WS. Trusted
 *  ONLY in a dev runtime (`trustDevOrigins`, see server/dev-mode.ts
 *  isDevRuntime): 5174 is also Vite's fallback port for any other local
 *  project, which must not drive a production instance. */
export function devOrigins(vitePort = Number(process.env.VITE_PORT) || DEFAULT_VITE_PORT): string[] {
  return [
    `http://localhost:${vitePort}`,
    `http://127.0.0.1:${vitePort}`,
    `http://[::1]:${vitePort}`,
  ]
}

/** `application/json`, optionally with parameters (charset), case-insensitive. */
export function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false
  return /^application\/json\s*(;|$)/i.test(value.trim())
}

/** Parse a Host header into a lowercased hostname (IPv6 keeps its brackets)
 *  and a numeric port (80 when absent). Returns null for anything malformed. */
export function parseHostHeader(value: string | undefined | null): { hostname: string; port: number } | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  if (!v || /[\s@/\\?#]/.test(v)) return null
  let hostname: string
  let portStr: string | undefined
  if (v.startsWith('[')) {
    const end = v.indexOf(']')
    if (end === -1) return null
    hostname = v.slice(0, end + 1)
    const rest = v.slice(end + 1)
    if (rest) {
      if (!rest.startsWith(':')) return null
      portStr = rest.slice(1)
    }
  } else {
    const parts = v.split(':')
    if (parts.length > 2) return null
    hostname = parts[0]
    portStr = parts[1]
  }
  if (!hostname || hostname === '[]') return null
  let port = 80
  if (portStr !== undefined) {
    if (!/^\d{1,5}$/.test(portStr)) return null
    port = Number(portStr)
    if (port < 1 || port > 65535) return null
  }
  return { hostname, port }
}

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]'])

/** Normalize a bind host into Host-header form (lowercase, IPv6 bracketed). */
function normalizeBindHost(host: string): string {
  const h = host.trim().toLowerCase()
  if (h.includes(':') && !h.startsWith('[')) return `[${h}]`
  return h
}

export interface RequestGuard {
  /** Host header names this server on the bound port. */
  isAllowedHost(hostHeader: string | undefined | null): boolean
  /** Exact-origin allowlist: `http://<allowed host>:<bound port>` or a dev origin. */
  isTrustedOrigin(origin: string): boolean
  /** Origin rule for writes / WS: absent → allowed, `null` → rejected,
   *  otherwise must be trusted. */
  isAllowedRequestOrigin(origin: string | undefined | null): boolean
}

export interface RequestGuardOptions {
  bind: BindAddress
  /** Exact origins trusted in addition to the bound ones. Default none;
   *  callers pass `devOrigins()` only in a dev runtime. */
  extraOrigins?: string[]
  lanAddresses?: () => string[]
}

export function createRequestGuard({
  bind,
  extraOrigins = [],
  lanAddresses = lanIPv4Addresses,
}: RequestGuardOptions): RequestGuard {
  const boundHost = normalizeBindHost(bind.host)
  const staticHosts = new Set(['localhost', '127.0.0.1', '[::1]'])
  if (!WILDCARD_HOSTS.has(boundHost)) staticHosts.add(boundHost)
  // Same rule as the existing allowLan / auth gating: a non-loopback bind
  // means the server is reachable over the LAN by interface IP.
  const allowLan = !isLoopbackHost(bind.host.trim().toLowerCase())

  const trustedExtra = new Set<string>()
  for (const o of extraOrigins) {
    try { trustedExtra.add(new URL(o).origin) } catch { /* ignore malformed */ }
  }

  function isAllowedHostname(hostname: string): boolean {
    if (staticHosts.has(hostname)) return true
    if (!allowLan) return false
    // Lazy: interfaces can change (Wi-Fi reconnect) and enumeration is only
    // needed for names outside the static set.
    return lanAddresses().some((ip) => ip.toLowerCase() === hostname)
  }

  const guard: RequestGuard = {
    isAllowedHost(hostHeader) {
      const parsed = parseHostHeader(hostHeader)
      if (!parsed) return false
      return parsed.port === bind.port && isAllowedHostname(parsed.hostname)
    },
    isTrustedOrigin(origin) {
      let url: URL
      try { url = new URL(origin) } catch { return false }
      if (trustedExtra.has(url.origin)) return true
      if (url.protocol !== 'http:') return false
      const port = url.port ? Number(url.port) : 80
      return port === bind.port && isAllowedHostname(url.hostname.toLowerCase())
    },
    isAllowedRequestOrigin(origin) {
      if (origin === undefined || origin === null) return true
      if (origin === 'null') return false
      return guard.isTrustedOrigin(origin)
    },
  }
  return guard
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function forbidden(c: Context, reason: string): Response {
  if (c.req.path.startsWith('/api/') || c.req.path === '/api') {
    return c.json({ error: `forbidden: ${reason}` }, 403)
  }
  return c.text('Forbidden', 403)
}

/** Hono middleware: Host allowlist on every request, Origin rule on writes. */
export function buildRequestGuardMiddleware(guard: RequestGuard): MiddlewareHandler {
  return async (c, next) => {
    // Header first: with an absolute-form request target @hono/node-server
    // builds c.req.url from the target, so the URL host could disagree with
    // the Host header the browser actually sent. URL host is only the
    // fallback for in-process requests that carry no Host header.
    let host = c.req.header('host')
    if (!host) {
      try { host = new URL(c.req.url).host } catch { host = undefined }
    }
    if (!guard.isAllowedHost(host)) {
      log.warn(`rejected ${c.req.method} ${c.req.path}: host not allowed (${JSON.stringify(host ?? '')})`)
      return forbidden(c, 'host not allowed')
    }
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin')
      if (!guard.isAllowedRequestOrigin(origin)) {
        log.warn(`rejected ${c.req.method} ${c.req.path}: origin not allowed (${JSON.stringify(origin)})`)
        return forbidden(c, 'origin not allowed')
      }
    }
    return next()
  }
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

/** Apply the Host + Origin rules to a raw WebSocket upgrade request. The
 *  Origin rule applies regardless of method (upgrades are always GET). */
export function checkUpgradeRequest(
  guard: RequestGuard,
  req: IncomingMessage,
): { ok: true } | { ok: false; reason: 'host' | 'origin' } {
  if (!guard.isAllowedHost(firstHeader(req.headers.host))) return { ok: false, reason: 'host' }
  if (!guard.isAllowedRequestOrigin(firstHeader(req.headers.origin))) return { ok: false, reason: 'origin' }
  return { ok: true }
}
