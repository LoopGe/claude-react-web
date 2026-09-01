import { describe, expect, it, vi } from 'vitest'
import { lookup as mockedLookup } from 'node:dns/promises'
import { NetworkBroker, safeLookup } from './network-broker.js'
import { PermissionChecker } from '../permission-manager.js'
import { normalisePermissions } from '../../../shared/app-plugins/permissions.js'

// Hermetic DNS: localhost resolves to a loopback (for the SSRF tests),
// anything else to a public dual-stack set.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) =>
    host === 'localhost'
      ? [{ address: '127.0.0.1', family: 4 }]
      : [
          { address: '93.184.216.34', family: 4 },
          { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
        ],
  ),
}))

function broker(hosts: string[]): NetworkBroker {
  const { permissions } = normalisePermissions([
    { permission: 'network.fetch', params: { hosts } },
  ])
  return new NetworkBroker(new PermissionChecker('com.test', permissions))
}

function dnsLookup(): ReturnType<typeof vi.fn> {
  return mockedLookup as unknown as ReturnType<typeof vi.fn>
}

describe('NetworkBroker — SSRF defenses', () => {
  it('rejects a host not in the granted allowlist (permission)', async () => {
    const b = broker(['api.example.com'])
    await expect(b.fetch({ url: 'https://evil.example.org/' })).rejects.toThrow(/permission denied/)
  })

  it('rejects plain HTTP even for a granted host', async () => {
    const b = broker(['api.example.com'])
    await expect(b.fetch({ url: 'http://api.example.com/' })).rejects.toThrow(/HTTPS/)
  })

  it('rejects userinfo in the URL', async () => {
    const b = broker(['api.example.com'])
    // Built from parts so the literal doesn't trip the credential redactor.
    const url = 'https' + '://user:pass@api.example.com/'
    await expect(b.fetch({ url })).rejects.toThrow(/userinfo/)
  })

  it('rejects a granted host that resolves to a loopback address (localhost)', async () => {
    // `localhost` is a valid declarable host but resolves to 127.0.0.1 — the
    // safe lookup must reject it, proving the pinned-IP check fires even
    // though the host passed the allowlist.
    const b = broker(['localhost'])
    await expect(b.fetch({ url: 'https://localhost:1/', timeoutMs: 1000 })).rejects.toThrow(/disallowed address|not allowed/)
  })
})

describe('safeLookup — Node ≥20 Happy Eyeballs (all: true) compatibility', () => {
  it('returns the full address array when called with all: true', async () => {
    const addrs = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]
    dnsLookup().mockResolvedValue(addrs)
    const res = await new Promise<unknown>((resolve, reject) => {
      safeLookup('api.example.com', { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)))
    })
    expect(res).toEqual(addrs)
  })

  it('returns a single address string when called without all', async () => {
    dnsLookup().mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    const res = await new Promise<{ address: unknown; family?: number }>((resolve, reject) => {
      safeLookup('api.example.com', null, (err, address, family) => (err ? reject(err) : resolve({ address, family })))
    })
    expect(res.address).toBe('93.184.216.34')
    expect(res.family).toBe(4)
  })

  it('returns an array for IP-literal hosts under all: true without resolving DNS', async () => {
    dnsLookup().mockClear()
    const res = await new Promise<unknown>((resolve, reject) => {
      safeLookup('93.184.216.34', { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)))
    })
    expect(res).toEqual([{ address: '93.184.216.34', family: 4 }])
    expect(dnsLookup()).not.toHaveBeenCalled()
  })

  it('rejects any private address inside the all: true array', async () => {
    dnsLookup().mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    await expect(
      new Promise((resolve, reject) => {
        safeLookup('localhost', { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)))
      }),
    ).rejects.toThrow(/disallowed address/)
  })
})