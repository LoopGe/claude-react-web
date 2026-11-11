// server/safe-dns.test.ts
//
// The connection-time DNS gate shared by the app-plugin network broker and the
// native web tools. These tests drive the lookup function itself — the one a
// socket Agent calls — so a predicate regression is caught even when a caller
// also runs an independent pre-check.
import { describe, expect, it, vi } from 'vitest'
import { lookup as dnsLookup } from 'node:dns/promises'
import { createSafeLookup } from './safe-dns.js'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))

function dns(): ReturnType<typeof vi.fn> {
  return dnsLookup as unknown as ReturnType<typeof vi.fn>
}

type LookupResult = { addresses: unknown; family?: number }

function runLookup(
  lookup: ReturnType<typeof createSafeLookup>,
  host: string,
  opts: { all?: boolean } | null,
): Promise<LookupResult> {
  return new Promise((resolve, reject) => {
    lookup(host, opts, (err, addresses, family) => {
      if (err) reject(err)
      else resolve({ addresses, family })
    })
  })
}

const ALLOW_ALL = () => false
const BLOCK_10 = (ip: string) => ip === '10.0.0.5'
const BLOCK_10_AND_V6 = (ip: string) => ip === '10.0.0.5' || ip === '::1'

describe('createSafeLookup', () => {
  it('classifies an IP-literal hostname with the predicate instead of resolving', async () => {
    dns().mockClear()
    const lookup = createSafeLookup(BLOCK_10_AND_V6)

    await expect(runLookup(lookup, '10.0.0.5', null)).rejects.toThrow(/not allowed/)
    await expect(runLookup(lookup, '[10.0.0.5]', null)).rejects.toThrow(/not allowed/)
    await expect(runLookup(lookup, '[::1]', null)).rejects.toThrow(/not allowed/)
    expect(dns()).not.toHaveBeenCalled()
  })

  it('rejects a hostname when ANY resolved address fails the predicate', async () => {
    dns().mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ])
    const lookup = createSafeLookup(BLOCK_10)
    await expect(runLookup(lookup, 'mixed.example', { all: true })).rejects.toThrow(
      /resolves to a disallowed address \(10\.0\.0\.5\)/,
    )
  })

  it('returns ONLY verified addresses under Node ≥20 Happy Eyeballs (all: true)', async () => {
    const addrs = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]
    dns().mockResolvedValue(addrs)
    const predicate = vi.fn((ip: string): boolean => {
      void ip
      return false
    })
    const lookup = createSafeLookup(predicate)

    await expect(runLookup(lookup, 'api.example', { all: true })).resolves.toEqual({ addresses: addrs })
    // The predicate saw every address the connection may use — not just the
    // first one, and not only in a separate pre-check.
    expect(predicate.mock.calls.map(([ip]) => ip)).toEqual(
      expect.arrayContaining(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']),
    )
  })

  it('returns a single verified address in the legacy (err, ip, family) shape', async () => {
    dns().mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    const lookup = createSafeLookup(ALLOW_ALL)
    await expect(runLookup(lookup, 'api.example', null)).resolves.toEqual({
      addresses: '93.184.216.34',
      family: 4,
    })
    await expect(runLookup(lookup, '93.184.216.34', null)).resolves.toEqual({
      addresses: '93.184.216.34',
      family: 4,
    })
  })

  it('returns an IP-literal array under all: true without a DNS call', async () => {
    dns().mockClear()
    const lookup = createSafeLookup(BLOCK_10_AND_V6)
    await expect(runLookup(lookup, '93.184.216.34', { all: true })).resolves.toEqual({
      addresses: [{ address: '93.184.216.34', family: 4 }],
    })
    expect(dns()).not.toHaveBeenCalled()
  })

  it('fails closed when resolution returns no usable address', async () => {
    dns().mockResolvedValue([])
    const lookup = createSafeLookup(ALLOW_ALL)
    // An empty answer must be an error in BOTH shapes. Node's Happy Eyeballs
    // path (`all: true`) destructures addresses[0], so resolving `[]` there
    // would crash the process with an uncaught TypeError.
    await expect(runLookup(lookup, 'empty.example', { all: true })).rejects.toThrow(/did not resolve/)
    await expect(runLookup(lookup, 'empty.example', null)).rejects.toThrow(/did not resolve/)
  })

  it('propagates a resolver failure', async () => {
    dns().mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }))
    const lookup = createSafeLookup(ALLOW_ALL)
    await expect(runLookup(lookup, 'nope.example', null)).rejects.toThrow(/ENOTFOUND/)
  })
})