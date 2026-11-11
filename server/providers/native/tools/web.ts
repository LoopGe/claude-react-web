// server/providers/native/tools/web.ts
//
// Shared HTTP policy for WebFetch and WebSearch. Both tools fetch
// untrusted remote content from inside the server process, so every request
// goes through one place that enforces:
//   - HTTP(S) only, URL ≤ 2048 chars, no embedded credentials;
//   - non-public IP targets blocked (SSRF), on the first hop AND every
//     redirect hop, including literal addresses and DNS-resolved hostnames;
//   - `redirect: 'manual'` with per-hop re-validation, ≤ 5 redirects, and no
//     origin changes (a redirect may move within its origin, never to another
//     scheme/host/port);
//   - response body ≤ 5 MiB and decoded text ≤ 100k chars;
//   - one deadline for the whole chain, combined with the turn's interrupt
//     signal through `AbortSignal.any`.
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { ToolInputError } from './types.js'

export const MAX_URL_LENGTH = 2048
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
export const MAX_TEXT_CHARS = 100_000
export const MAX_REDIRECTS = 5
export const WEB_TIMEOUT_MS = 30_000

/** Sent on every request: some sites answer the default undici user agent
 *  with a block page, and DuckDuckGo's HTML endpoint requires a browser-like
 *  one to serve result markup at all. */
export const WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const ACCEPT_HEADER = 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5'

// ── Address classification ──────────────────────────────────────────

function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return [nums[0], nums[1], nums[2], nums[3]]
}

/** Non-public IPv4 ranges: unspecified, private, loopback, link-local,
 *  CGNAT, documentation, benchmarking, multicast and reserved space. Anything
 *  the public internet cannot route to is refused. */
const NON_PUBLIC_V4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16 (includes 169.254.169.254)
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xc0000000, 24], // 192.0.0.0/24
  [0xc0000200, 24], // 192.0.2.0/24
  [0xc6120000, 15], // 198.18.0.0/15
  [0xc6336400, 24], // 198.51.100.0/24
  [0xcb007100, 24], // 203.0.113.0/24
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved
]

function isNonPublicIpv4(octets: readonly number[]): boolean {
  const value =
    (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0) >>> 0
  return NON_PUBLIC_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (value & mask) >>> 0 === (base & mask) >>> 0
  })
}

/** Expand an IPv6 literal to eight 16-bit groups. An embedded dotted-quad
 *  tail (e.g. `::ffff:127.0.0.1`) is rewritten to two hex groups first. */
function parseIpv6(ip: string): number[] | null {
  let addr = ip
  const zone = addr.indexOf('%')
  if (zone >= 0) addr = addr.slice(0, zone)
  if (addr.includes('.')) {
    const lastColon = addr.lastIndexOf(':')
    if (lastColon < 0) return null
    const v4 = parseIpv4(addr.slice(lastColon + 1))
    if (!v4) return null
    const hi = ((v4[0] << 8) | v4[1]).toString(16)
    const lo = ((v4[2] << 8) | v4[3]).toString(16)
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`
  }
  const halves = addr.split('::')
  if (halves.length > 2) return null
  const parseGroups = (part: string): number[] | null => {
    if (part === '') return []
    const groups: number[] = []
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
      groups.push(parseInt(group, 16))
    }
    return groups
  }
  const left = parseGroups(halves[0])
  const right = parseGroups(halves[1] ?? '')
  if (!left || !right) return null
  if (halves.length === 2) {
    const fill = 8 - left.length - right.length
    if (fill < 1) return null
    return [...left, ...Array<number>(fill).fill(0), ...right]
  }
  return left.length === 8 ? left : null
}

function isNonPublicIpv6(groups: readonly number[]): boolean {
  if (groups.every((g) => g === 0)) return true // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true // ::1
  if ((groups[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((groups[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((groups[0] & 0xff00) === 0xff00) return true // ff00::/8 multicast
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true // 2001:db8::/32
  // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible addresses:
  // classify the embedded address, not the v6 wrapper.
  const embedded: [number, number, number, number] = [
    groups[6] >> 8,
    groups[6] & 0xff,
    groups[7] >> 8,
    groups[7] & 0xff,
  ]
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return isNonPublicIpv4(embedded)
  }
  if (groups.slice(0, 6).every((g) => g === 0)) return isNonPublicIpv4(embedded)
  return false
}

/** True for any address the public internet cannot route to (IPv4 or IPv6). */
export function isNonPublicIp(ip: string): boolean {
  const host = ip.replace(/^\[|\]$/g, '')
  const v4 = parseIpv4(host)
  if (v4) return isNonPublicIpv4(v4)
  const v6 = parseIpv6(host)
  if (v6) return isNonPublicIpv6(v6)
  // Not an IP literal. `isIP` is the gate at the call site, so reaching here
  // means the caller passed something else; treat it as unsafe rather than
  // silently allowing an unparseable host.
  return !isIP(host)
}

/** Resolve a hostname (or classify an IP literal) and refuse every host that
 *  maps onto non-public space. Resolution failure is a tool error: the
 *  request cannot succeed and must not fall through to a bare `fetch`, which
 *  would resolve the name a second time with no check. */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) {
    if (isNonPublicIp(host)) throw new ToolInputError(`blocked non-public address: ${host}`)
    return
  }
  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await lookup(host, { all: true, verbatim: true })
  } catch (err) {
    throw new ToolInputError(`could not resolve host ${host}: ${(err as Error).message}`)
  }
  if (addresses.length === 0) throw new ToolInputError(`could not resolve host ${host}`)
  for (const { address } of addresses) {
    if (isNonPublicIp(address)) {
      throw new ToolInputError(`blocked non-public address ${address} for host ${host}`)
    }
  }
}

/** Validate one URL against the shared policy. Async because a hostname must
 *  be resolved before the connection is allowed. */
export async function validateWebUrl(raw: string): Promise<URL> {
  if (raw.length > MAX_URL_LENGTH) {
    throw new ToolInputError(`URL exceeds ${MAX_URL_LENGTH} characters`)
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ToolInputError(`invalid URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolInputError(`only HTTP(S) URLs are supported (got ${url.protocol})`)
  }
  if (url.username || url.password) {
    throw new ToolInputError('URLs with embedded credentials are not allowed')
  }
  if (!url.hostname) throw new ToolInputError(`URL has no host: ${raw}`)
  if (url.href.length > MAX_URL_LENGTH) {
    throw new ToolInputError(`URL exceeds ${MAX_URL_LENGTH} characters`)
  }
  await assertPublicHost(url.hostname)
  return url
}

// ── HTML to text ────────────────────────────────────────────────────

/** Strip script/style bodies, comments and tags, decode common entities, and
 *  collapse all whitespace. Produces one plain-text body for the model. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?(?:<\/style\s*>|$)/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#0*38;|&amp;/gi, '&')
    .replace(/&#(\d+);/g, (match, code: string) => {
      const point = Number(code)
      return point <= 0x10ffff ? String.fromCodePoint(point) : match
    })
    .replace(/&#x([0-9a-f]+);/gi, (match, code: string) => {
      const point = parseInt(code, 16)
      return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : match
    })
    .replace(/\s+/g, ' ')
    .trim()
}

function isHtml(contentType: string): boolean {
  return contentType.toLowerCase().includes('html')
}

// ── Fetch ───────────────────────────────────────────────────────────

export interface FetchWebOptions {
  /** Turn/interrupt signal. Combined with the 30s deadline. */
  signal: AbortSignal
  /** `'text'` (default) runs HTML through `htmlToText`; `'html'` returns the
   *  decoded markup for a tool that needs to parse links. */
  format?: 'text' | 'html'
  /** Extra request headers (merged over the defaults). */
  headers?: Record<string, string>
}

export interface WebResponse {
  /** Final URL after same-origin redirects. */
  url: string
  status: number
  statusText: string
  contentType: string
  /** Bytes read from the body (before any text decoding). */
  bytes: number
  /** Decoded content, capped at `MAX_TEXT_CHARS`. */
  text: string
}

async function readBodyCapped(res: Response): Promise<Uint8Array> {
  const declared = res.headers.get('content-length')
  if (declared !== null) {
    const size = Number(declared)
    if (Number.isFinite(size) && size > MAX_RESPONSE_BYTES) {
      throw new ToolInputError(`response exceeds ${MAX_RESPONSE_BYTES} bytes`)
    }
  }
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {})
      throw new ToolInputError(`response exceeds ${MAX_RESPONSE_BYTES} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** Fetch a URL under the shared web policy. Throws `ToolInputError` for every
 *  policy violation and for non-2xx responses. */
export async function fetchWeb(rawUrl: string, opts: FetchWebOptions): Promise<WebResponse> {
  // One deadline for the whole redirect chain; `any` keeps the turn's own
  // interrupt able to cancel the request immediately.
  const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(WEB_TIMEOUT_MS)])
  let current = await validateWebUrl(rawUrl)
  const origin = current.origin
  for (let redirects = 0; ; redirects++) {
    const res = await fetch(current.href, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        'user-agent': WEB_USER_AGENT,
        accept: ACCEPT_HEADER,
        ...opts.headers,
      },
    })
    if (REDIRECT_STATUSES.has(res.status)) {
      void res.body?.cancel().catch(() => {})
      const location = res.headers.get('location')
      if (!location) {
        throw new ToolInputError(`HTTP ${res.status} redirect without a Location header`)
      }
      if (redirects >= MAX_REDIRECTS) {
        throw new ToolInputError(`too many redirects (limit ${MAX_REDIRECTS})`)
      }
      // Re-validate the hop before connecting: scheme, credentials, length
      // and the resolved address are all checked again.
      const next = await validateWebUrl(new URL(location, current).href)
      if (next.origin !== origin) {
        throw new ToolInputError(`cross-origin redirect rejected (${origin} -> ${next.origin})`)
      }
      current = next
      continue
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {})
      const detail = res.statusText ? ` ${res.statusText}` : ''
      throw new ToolInputError(`HTTP ${res.status}${detail} for ${current.href}`)
    }
    const bytes = await readBodyCapped(res)
    const contentType = res.headers.get('content-type') ?? ''
    const decoded = new TextDecoder('utf-8').decode(bytes)
    const text =
      opts.format === 'html' || !isHtml(contentType) ? decoded : htmlToText(decoded)
    return {
      url: current.href,
      status: res.status,
      statusText: res.statusText,
      contentType,
      bytes: bytes.byteLength,
      text: text.slice(0, MAX_TEXT_CHARS),
    }
  }
}