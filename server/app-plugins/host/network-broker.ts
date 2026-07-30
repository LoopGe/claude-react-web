// Network broker — the Host API path a plugin uses to make outbound HTTPS.
//
// SSRF defenses (defense-in-depth for plugins that use network.fetch — NOT
// an OS-level sandbox; plugins are trusted local programs that can
// `import node:net` and bypass this broker entirely):
//   - HTTPS only (plain HTTP rejected).
//   - Target host must be in the granted network.fetch allowlist.
//   - A custom `https.Agent` lookup resolves the host and connects to a
//     VERIFIED IP — Node does not re-resolve, so a DNS answer that flips to
//     127.0.0.1 between resolve and connect (DNS rebinding) cannot land. Any
//     resolved address that is loopback / private / link-local / cloud
//     metadata rejects the whole lookup.
//   - Redirects followed manually (max 5); each hop is re-authorised against
//     the allowlist AND re-resolved through the safe lookup.
//   - Response body capped at maxBytes (default 1 MiB), with `truncated`.
//   - Per-call timeout.
//
// Implemented on the built-in `https` module (not global `fetch`) precisely
// so we can pass a custom `lookup` to the agent — `fetch`/undici would re-
// resolve independently and reopen the TOCTOU.

import { request as httpsRequest, type RequestOptions, Agent } from 'node:https'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { isPrivateIP } from '../../ssrf.js'
import type { PermissionChecker } from '../permission-manager.js'

const MAX_REDIRECTS = 5
const DEFAULT_MAX_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 15_000

export interface NetworkFetchOptions {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  headers?: Record<string, string>
  body?: string
  maxBytes?: number
  timeoutMs?: number
}

export interface NetworkFetchResult {
  status: number
  headers: Record<string, string>
  body: string
  truncated: boolean
}

export class NetworkBroker {
  /** Shared agent whose `lookup` pins every connection to a verified IP.
   *  One agent per broker (per plugin) is fine — keepAlive reuses sockets. */
  private readonly agent: Agent

  constructor(private readonly perm: PermissionChecker) {
    this.agent = new Agent({ lookup: safeLookup as never, keepAlive: true })
  }

  async fetch(opts: NetworkFetchOptions): Promise<NetworkFetchResult> {
    const method = opts.method ?? 'GET'
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

    let url = this.parseAndAuthorize(opts.url)
    let redirects = 0
    for (;;) {
      const res = await this.requestOnce(url, method, opts.headers, opts.body, maxBytes, timeoutMs)
      if (res.status >= 300 && res.status < 400 && res.headers['location']) {
        if (++redirects > MAX_REDIRECTS) throw new Error('too many redirects')
        // Re-authorise + re-loop: the next hop goes through parseAndAuthorize
        // (allowlist) and the agent's safe lookup (IP pin) again.
        url = this.parseAndAuthorize(new URL(res.headers['location'], url).toString())
        continue
      }
      return res
    }
  }

  private parseAndAuthorize(raw: string): URL {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new Error(`invalid url: ${raw}`)
    }
    if (url.protocol !== 'https:') throw new Error('only HTTPS is allowed')
    if (url.username || url.password) throw new Error('userinfo in URL is not allowed')
    const host = url.hostname.toLowerCase()
    this.perm.assert('network.fetch', { host }, host)
    return url
  }

  private requestOnce(
    url: URL,
    method: string,
    headers: Record<string, string> | undefined,
    body: string | undefined,
    maxBytes: number,
    timeoutMs: number,
  ): Promise<NetworkFetchResult> {
    return new Promise((resolve, reject) => {
      const options: RequestOptions = {
        method,
        headers: headers ?? {},
        agent: this.agent,
      }
      const req = httpsRequest(url, options, (res) => {
        const out: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') out[k] = v
          else if (Array.isArray(v)) out[k] = v.join(', ')
        }
        const chunks: Buffer[] = []
        let size = 0
        let truncated = false
        res.on('data', (chunk: Buffer) => {
          if (truncated) return
          size += chunk.length
          if (size > maxBytes) {
            truncated = true
            const overflow = size - maxBytes
            chunks.push(chunk.subarray(0, chunk.length - overflow))
            res.destroy()
            resolve({ status: res.statusCode ?? 0, headers: out, body: Buffer.concat(chunks).toString('utf8'), truncated })
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          if (truncated) return
          resolve({ status: res.statusCode ?? 0, headers: out, body: Buffer.concat(chunks).toString('utf8'), truncated: false })
        })
        res.on('error', reject)
      })
      req.on('error', reject)
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`network request timed out after ${timeoutMs}ms`)))
      if (body) req.write(body)
      req.end()
    })
  }
}

/** Custom DNS lookup for the https.Agent. Resolves `hostname`, rejects if ANY
 *  returned address is unsafe (loopback/private/link-local/metadata), and
 *  returns a verified address — Node then connects to THAT IP, closing the
 *  resolve-then-re-resolve TOCTOU (DNS rebinding). IP-literal hostnames are
 *  checked directly (brackets stripped for IPv6). */
function safeLookup(hostname: string, _opts: unknown, cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void): void {
  const host = hostname.replace(/^\[|\]$/g, '') // strip IPv6 brackets
  const ver = isIP(host)
  if (ver > 0) {
    if (isPrivateIP(host)) return cb(new Error(`target IP is not allowed: ${host}`) as NodeJS.ErrnoException, '', 0)
    return cb(null, host, ver)
  }
  void dnsLookup(host, { all: true }).then(
    (addrs) => {
      const unsafe = addrs.find((a) => isPrivateIP(a.address))
      if (unsafe) return cb(new Error(`host ${host} resolves to a disallowed address (${unsafe.address})`) as NodeJS.ErrnoException, '', 0)
      const first = addrs[0]
      if (!first) return cb(new Error(`host ${host} did not resolve`) as NodeJS.ErrnoException, '', 0)
      cb(null, first.address, first.family === 6 ? 6 : 4)
    },
    (err) => cb(err as NodeJS.ErrnoException, '', 0),
  )
}


