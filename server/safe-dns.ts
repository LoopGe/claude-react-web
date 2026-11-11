// Shared connection-time DNS gate.
//
// An `http`/`https` Agent can be given a custom `lookup`. Whatever that lookup
// puts in its callback is the address Node connects to; it does not resolve the
// hostname again. Returning an address that passed an IP predicate therefore
// closes the resolve-then-re-resolve TOCTOU (DNS rebinding) that a separate
// pre-check alone leaves open — a hostname can answer public once and private a
// moment later.
//
// Two callers share this implementation with different policies: the app-plugin
// network broker (`isPrivateIP`) and the native WebFetch/WebSearch policy
// (`isNonPublicIp`). Each keeps its own blocklist; there is one lookup.
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export interface LookupAddress {
  address: string
  family: number
}

export type SafeLookup = (
  hostname: string,
  opts: { all?: boolean } | null,
  cb: (err: NodeJS.ErrnoException | null, addresses: unknown, family?: number) => void,
) => void

/** Build the custom lookup an Agent should use. `isBlocked` is the caller's
 *  full policy: every resolved address (and an IP literal) is passed through
 *  it, and the lookup fails if ANY address is blocked.
 *
 *  Node ≥20 enables Happy Eyeballs (`autoSelectFamily`) by default, which
 *  invokes the lookup with `all: true` and expects `(err, addresses[])` — NOT
 *  `(err, ip, family)`. Both shapes are handled, or the socket fails with
 *  `ERR_INVALID_IP_ADDRESS` because it destructures `addresses[0]` off a string.
 *  When `all` is set, the FULL pre-validated array is returned. */
export function createSafeLookup(isBlocked: (ip: string) => boolean): SafeLookup {
  return (hostname, opts, cb) => {
    const host = hostname.replace(/^\[|\]$/g, '') // strip IPv6 brackets
    const ver = isIP(host)
    if (ver > 0) {
      if (isBlocked(host)) return cb(new Error(`target IP is not allowed: ${host}`) as NodeJS.ErrnoException, '', 0)
      if (opts?.all) return cb(null, [{ address: host, family: ver }])
      return cb(null, host, ver)
    }
    void dnsLookup(host, { all: true }).then(
      (addrs) => {
        const unsafe = addrs.find((a) => isBlocked(a.address))
        if (unsafe) return cb(new Error(`host ${host} resolves to a disallowed address (${unsafe.address})`) as NodeJS.ErrnoException, '', 0)
        if (opts?.all) return cb(null, addrs)
        const first = addrs[0]
        if (!first) return cb(new Error(`host ${host} did not resolve`) as NodeJS.ErrnoException, '', 0)
        cb(null, first.address, first.family === 6 ? 6 : 4)
      },
      (err) => cb(err as NodeJS.ErrnoException, '', 0),
    )
  }
}