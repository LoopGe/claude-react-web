// server/providers/native/tools/web.ts
//
// Shared HTTP policy for WebFetch and WebSearch. Both tools fetch
// untrusted remote content from inside the server process, so every request
// goes through one place that enforces:
//   - HTTP(S) only, URL ≤ 2048 chars, no embedded credentials;
//   - non-public IP targets blocked (SSRF), on the first hop AND every
//     redirect hop, including literal addresses and DNS-resolved hostnames;
//   - redirects followed manually with per-hop re-validation, ≤ 5 redirects,
//     and no origin changes (a redirect may move within its origin, never to
//     another scheme/host/port);
//   - response body ≤ 5 MiB and a decoded-text window of ≤ 100k chars,
//     applied AFTER `offset`;
//   - one deadline for the whole chain, combined with the turn's interrupt
//     signal through `AbortSignal.any`.
//
// Transport is the built-in `node:http` / `node:https` request API, not global
// `fetch`, because each Agent carries a custom `lookup` that resolves the
// hostname and returns ONLY verified addresses. Node connects to those
// addresses without re-resolving, so a DNS answer that flips from public to
// private between validation and connect (DNS rebinding) cannot land. `fetch`
// re-resolves independently and would reopen that TOCTOU on every hop.
import { request as httpRequest, Agent as HttpAgent, type IncomingMessage } from 'node:http'
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Readable, type Transform } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { createSafeLookup } from '../../../safe-dns.js'
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

/** Ask for the encodings the decoder below knows. Without this Node's request
 *  sends nothing and servers generally answer identity, but a proxy/CDN may
 *  still compress. */
const ACCEPT_ENCODING = 'gzip, deflate, br'

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
  // IPv6 transition prefixes that encode an IPv4 destination: NAT64's
  // well-known prefix AND its RFC 8215 local-use prefix, 6to4 and Teredo.
  // A URL like http://[64:ff9b::7f00:1]/ or http://[64:ff9b:1::7f00:1]/
  // reaches 127.0.0.1 on a NAT64 host, so both prefixes are refused.
  if (
    groups[0] === 0x0064 && // 64:ff9b::/96 and 64:ff9b:1::/48
    groups[1] === 0xff9b &&
    (groups[2] === 0 || groups[2] === 1) &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0
  ) {
    return true
  }
  if (groups[0] === 0x2002) return true // 2002::/16 6to4
  if (groups[0] === 0x2001 && groups[1] === 0) return true // 2001::/32 Teredo
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

/** The connection-time gate for both web Agents. It shares the implementation
 *  (and the Node ≥20 Happy Eyeballs `all: true` handling) with the app-plugin
 *  network broker; only the IP predicate differs — every address the socket
 *  may connect to must be public. */
export const webSafeLookup = createSafeLookup(isNonPublicIp)

/** No keep-alive: web requests are one-shot and must not leave idle sockets
 *  holding the process open. */
const httpAgent = new HttpAgent({ lookup: webSafeLookup as never })
const httpsAgent = new HttpsAgent({ lookup: webSafeLookup as never })

/** Resolve a hostname (or classify an IP literal) and refuse every host that
 *  maps onto non-public space. This is the early policy check that yields a
 *  tool error before a connection is attempted; the same predicate is also
 *  applied by the transport Agent's `lookup`, which pins the connection to the
 *  verified address and cannot be flipped by a second DNS answer. */
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
  /** Character offset into the decoded text. Applied BEFORE the 100k window
   *  cap, so a model can page past the first window of a long document. */
  offset?: number
}

export interface WebResponse {
  /** Final URL after same-origin redirects. */
  url: string
  status: number
  statusText: string
  contentType: string
  /** Bytes read from the body (before any text decoding). */
  bytes: number
  /** The decoded window: `MAX_TEXT_CHARS` characters starting at `offset`. */
  text: string
}

/** The slice of a Node `IncomingMessage` the policy needs. Kept structural so
 *  tests can answer with a plain object. */
interface RawResponse {
  status: number
  statusText: string
  headers: Record<string, string | undefined>
  body: AsyncIterable<Uint8Array>
  destroy(): void
}

/** One GET over the pinned Agent. No redirect following happens here — Node's
 *  request API never follows, which gives us the same manual-redirect
 *  contract the policy needs. The Agent's `lookup` is the DNS gate. */
function requestWeb(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<RawResponse> {
  const https = url.protocol === 'https:'
  return new Promise((resolve, reject) => {
    const onResponse = (res: IncomingMessage) => {
      const out: Record<string, string | undefined> = {}
      for (const [key, value] of Object.entries(res.headers)) {
        out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
      }
      resolve({
        status: res.statusCode ?? 0,
        statusText: res.statusMessage ?? '',
        headers: out,
        body: res as unknown as AsyncIterable<Uint8Array>,
        destroy: () => res.destroy(),
      })
    }
    const req = https
      ? httpsRequest(url, { method: 'GET', headers, agent: httpsAgent, signal }, onResponse)
      : httpRequest(url, { method: 'GET', headers, agent: httpAgent, signal }, onResponse)
    req.on('error', reject)
    req.end()
  })
}

const DECODERS: Record<string, () => Transform> = {
  gzip: createGunzip,
  deflate: createInflate,
  br: createBrotliDecompress,
}

interface DecodedBody {
  body: AsyncIterable<Uint8Array>
  /** True when the body is still compressed on the wire; the 5 MiB cap and
   *  `bytes` both apply to the DECODED stream. */
  compressed: boolean
  destroy(): void
}

/** `fetch` decompresses transparently; the node:http(s) rewrite has to do it
 *  explicitly. Unknown encodings fail loudly rather than being handed to the
 *  model as mojibake. */
function decodeResponseBody(res: RawResponse): DecodedBody {
  const encoding = (res.headers['content-encoding'] ?? '').trim().toLowerCase()
  if (encoding === '' || encoding === 'identity') {
    return { body: res.body, compressed: false, destroy: () => res.destroy() }
  }
  const makeDecoder = DECODERS[encoding]
  if (!makeDecoder) {
    res.destroy()
    throw new ToolInputError(`unsupported content-encoding: ${encoding}`)
  }
  const source = Readable.from(res.body)
  const decompressor = makeDecoder()
  // `pipe` does not forward errors; route a source failure (abort, socket
  // reset) into the decompressor so the reader sees it instead of hanging.
  source.on('error', (err) => decompressor.destroy(err))
  source.pipe(decompressor)
  return {
    body: decompressor as unknown as AsyncIterable<Uint8Array>,
    compressed: true,
    destroy: () => {
      source.destroy()
      decompressor.destroy()
      res.destroy()
    },
  }
}

async function readBodyCapped(res: RawResponse, decoded: DecodedBody): Promise<Buffer> {
  // `content-length` describes the wire (possibly compressed) body, so it can
  // only bound the decoded one when no decoding happens.
  if (!decoded.compressed) {
    const declared = res.headers['content-length']
    if (declared !== undefined) {
      const size = Number(declared)
      if (Number.isFinite(size) && size > MAX_RESPONSE_BYTES) {
        decoded.destroy()
        throw new ToolInputError(`response exceeds ${MAX_RESPONSE_BYTES} bytes`)
      }
    }
  }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for await (const chunk of decoded.body) {
      total += chunk.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        decoded.destroy()
        throw new ToolInputError(`response exceeds ${MAX_RESPONSE_BYTES} bytes`)
      }
      chunks.push(chunk)
    }
  } catch (err) {
    decoded.destroy()
    throw err
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
  const requestHeaders: Record<string, string> = {
    'user-agent': WEB_USER_AGENT,
    accept: ACCEPT_HEADER,
    'accept-encoding': ACCEPT_ENCODING,
    ...opts.headers,
  }
  for (let redirects = 0; ; redirects++) {
    const res = await requestWeb(current, requestHeaders, signal)
    if (REDIRECT_STATUSES.has(res.status)) {
      res.destroy()
      const location = res.headers.location
      if (!location) {
        throw new ToolInputError(`HTTP ${res.status} redirect without a Location header`)
      }
      if (redirects >= MAX_REDIRECTS) {
        throw new ToolInputError(`too many redirects (limit ${MAX_REDIRECTS})`)
      }
      // Re-validate the hop before connecting: scheme, credentials, length,
      // the resolved address pre-check, and (at connect time) the Agent's
      // pinned lookup all run again.
      let nextHref: string
      try {
        nextHref = new URL(location, current).href
      } catch {
        throw new ToolInputError(`invalid redirect location: ${location}`)
      }
      const next = await validateWebUrl(nextHref)
      if (next.origin !== origin) {
        throw new ToolInputError(`cross-origin redirect rejected (${origin} -> ${next.origin})`)
      }
      current = next
      continue
    }
    if (res.status < 200 || res.status >= 300) {
      res.destroy()
      const detail = res.statusText ? ` ${res.statusText}` : ''
      throw new ToolInputError(`HTTP ${res.status}${detail} for ${current.href}`)
    }
    const decoded = decodeResponseBody(res)
    const bytes = await readBodyCapped(res, decoded)
    const contentType = res.headers['content-type'] ?? ''
    const decompressed = new TextDecoder('utf-8').decode(bytes)
    const fullText =
      opts.format === 'html' || !isHtml(contentType) ? decompressed : htmlToText(decompressed)
    const offset = opts.offset ?? 0
    return {
      url: current.href,
      status: res.status,
      statusText: res.statusText,
      contentType,
      bytes: bytes.byteLength,
      text: fullText.slice(offset, offset + MAX_TEXT_CHARS),
    }
  }
}
