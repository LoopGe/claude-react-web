// Network helpers shared by the CLI startup banner and the /api/access-info
// route. Kept in one place so the LAN-IP enumeration and loopback test don't
// drift between "what the console prints" and "what the QR dialog shows".

import { networkInterfaces } from 'node:os'

/** Loopback hosts need no web-access token (only the local user can reach
 *  them). `0.0.0.0` binds all interfaces and is treated as public. */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

/** Collect non-internal IPv4 addresses for printing reachable LAN URLs. */
export function lanIPv4Addresses(): string[] {
  const out: string[] = []
  const ifaces = networkInterfaces()
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address)
    }
  }
  return out
}
