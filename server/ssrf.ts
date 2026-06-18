// SSRF protection: validate URLs before making outbound requests.
// Rejects private IPs, link-local addresses, metadata endpoints, and
// non-standard ports to prevent server-side request forgery.

import { isIPv4, isIPv6 } from 'node:net'
import { lookup } from 'node:dns/promises'

/** Check if a resolved IPv4 address is private / link-local / loopback. */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4) return false
  const [a, b] = parts
  // 10.0.0.0/8
  if (a === 10) return true
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true
  // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 169 && b === 254) return true
  // 0.0.0.0
  if (a === 0) return true
  return false
}

/** Check if an IPv6 address is private / loopback / link-local.
 *
 *  Handles IPv4-mapped IPv6 (::ffff:a.b.c.d) by extracting the embedded IPv4
 *  and reusing isPrivateIPv4 — this covers ALL private ranges (10/8, 172.16/12,
 *  192.168/16, 127/8, 169.254/16, 0/8) rather than enumerating prefixes,
 *  which previously missed ::ffff:172.16.x.x, ::ffff:169.254.169.254 (cloud
 *  metadata), and ::ffff:0.0.0.0. */
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  // ::1 — loopback
  if (lower === '::1') return true
  // ::ffff:a.b.c.d — IPv4-mapped: defer to the IPv4 check for full coverage.
  // The mixed notation suffix is a dotted-quad; stripping the prefix and
  // running isPrivateIPv4 catches every private/link-local IPv4 range,
  // including the cloud-metadata 169.254.169.254 that the old prefix list
  // silently allowed through.
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice('::ffff:'.length)
    if (isIPv4(v4)) return isPrivateIPv4(v4)
  }
  // fe80::/10 — link-local (fe80 through febf). The old `startsWith('fe80:')`
  // only caught the fe80 prefix and missed fe81–febf, which are also link-local.
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true
  // fc00::/7 — unique local address (fc.. and fd..)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true
  return false
}

/** Return true if the IP address is in a private / link-local / loopback range. */
function isPrivateIP(ip: string): boolean {
  if (isIPv4(ip)) return isPrivateIPv4(ip)
  if (isIPv6(ip)) return isPrivateIPv6(ip)
  return false
}

/** Hostnames that should always be blocked (cloud metadata, localhost aliases). */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google.com',
  'instance-data',
])

/** Suffixes that indicate internal / metadata services. */
const BLOCKED_SUFFIXES = ['.internal', '.local', '.localhost']

/** Allowed ports for the Anthropic API. Non-standard ports may hit internal services. */
const ALLOWED_HTTP_PORTS = new Set([80, 443, 8080, 8443])

export interface SsrfCheckResult {
  ok: boolean
  error?: string
}

/**
 * Validate a base URL before making an outbound fetch.
 *
 * Checks performed:
 *  1. URL parses and uses http/https scheme
 *  2. No CRLF / control character injection
 *  3. Hostname is not a known blocked name
 *  4. DNS-resolved IP is not in a private/link-local range
 *  5. Port is one of the standard set (80/443/8080/8443)
 */
export async function validateOutboundUrl(rawUrl: string): Promise<SsrfCheckResult> {
  // Reject control characters that could inject headers.
  // eslint-disable-next-line no-control-regex -- matching CR/LF/NUL is the explicit purpose of this SSRF guard.
  if (/[\r\n\x00]/.test(rawUrl)) {
    return { ok: false, error: 'URL contains invalid characters' }
  }

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, error: 'Invalid URL format' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `Unsupported protocol: ${url.protocol}` }
  }

  const hostname = url.hostname.toLowerCase()

  // Check blocked hostnames.
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { ok: false, error: `Hostname '${url.hostname}' is blocked` }
  }
  for (const suffix of BLOCKED_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      return { ok: false, error: `Internal hostname '${url.hostname}' is blocked` }
    }
  }

  // Check port allowlist.
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80)
  if (!ALLOWED_HTTP_PORTS.has(port)) {
    return { ok: false, error: `Port ${port} is not allowed` }
  }

  // Resolve hostname and check the resulting IP.
  try {
    const { address } = await lookup(url.hostname)
    if (isPrivateIP(address)) {
      return { ok: false, error: `'${url.hostname}' resolves to a private/internal IP` }
    }
  } catch {
    // DNS lookup failed — hostname doesn't resolve. Fail closed: a
    // non-resolving hostname could be re-bound by a hostile resolver or
    // expanded via a search domain into an internal address, and we can't
    // verify the target. The caller surfaces this as a config error.
    return { ok: false, error: `'${url.hostname}' did not resolve to an address` }
  }

  return { ok: true }
}
