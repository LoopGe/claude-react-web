import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import {
  checkUpgradeRequest,
  createRequestGuard,
  devOrigins,
  isJsonContentType,
  parseHostHeader,
} from './request-guard.js'

const lan = () => ['192.168.1.5']
const loopbackGuard = (port = 3499) =>
  createRequestGuard({ bind: { host: '127.0.0.1', port }, extraOrigins: devOrigins(5174), lanAddresses: lan })

describe('parseHostHeader', () => {
  it('parses host, port, IPv6 and defaults to 80', () => {
    expect(parseHostHeader('LocalHost:3499')).toEqual({ hostname: 'localhost', port: 3499 })
    expect(parseHostHeader('127.0.0.1')).toEqual({ hostname: '127.0.0.1', port: 80 })
    expect(parseHostHeader('[::1]:3499')).toEqual({ hostname: '[::1]', port: 3499 })
    expect(parseHostHeader('[::1]')).toEqual({ hostname: '[::1]', port: 80 })
  })

  it('rejects garbage', () => {
    for (const v of ['', '   ', 'a b:1', 'user@host:1', 'host/x:1', 'host:abc', 'host:70000', 'host:0', '::1:3499', '[::1', '[::1]x', undefined, null]) {
      expect(parseHostHeader(v as string)).toBeNull()
    }
  })
})

describe('createRequestGuard — Host', () => {
  it('allows loopback names on the bound port only', () => {
    const g = loopbackGuard()
    expect(g.isAllowedHost('127.0.0.1:3499')).toBe(true)
    expect(g.isAllowedHost('localhost:3499')).toBe(true)
    expect(g.isAllowedHost('[::1]:3499')).toBe(true)
    expect(g.isAllowedHost('127.0.0.1:9999')).toBe(false)
    expect(g.isAllowedHost('localhost')).toBe(false)
  })

  it('rejects rebinding / foreign hostnames', () => {
    const g = loopbackGuard()
    expect(g.isAllowedHost('evil.example:3499')).toBe(false)
    expect(g.isAllowedHost('attacker.127.0.0.1.nip.io:3499')).toBe(false)
    expect(g.isAllowedHost(undefined)).toBe(false)
    expect(g.isAllowedHost('garbage host')).toBe(false)
  })

  it('treats a missing port as 80', () => {
    expect(loopbackGuard(80).isAllowedHost('localhost')).toBe(true)
    expect(loopbackGuard(3499).isAllowedHost('localhost')).toBe(false)
  })

  it('bind 0.0.0.0 allows LAN interface IPs but not the wildcard itself', () => {
    const g = createRequestGuard({ bind: { host: '0.0.0.0', port: 3499 }, lanAddresses: lan })
    expect(g.isAllowedHost('192.168.1.5:3499')).toBe(true)
    expect(g.isAllowedHost('192.168.1.6:3499')).toBe(false)
    expect(g.isAllowedHost('0.0.0.0:3499')).toBe(false)
    expect(g.isAllowedHost('127.0.0.1:3499')).toBe(true)
  })

  it('bind to a LAN IP / hostname allows it', () => {
    expect(createRequestGuard({ bind: { host: '192.168.1.5', port: 3499 }, lanAddresses: () => [] }).isAllowedHost('192.168.1.5:3499')).toBe(true)
    expect(createRequestGuard({ bind: { host: 'MyPc.local', port: 3499 }, lanAddresses: () => [] }).isAllowedHost('mypc.local:3499')).toBe(true)
  })

  it('bind 127.0.0.1 does not expand to LAN IPs', () => {
    expect(loopbackGuard().isAllowedHost('192.168.1.5:3499')).toBe(false)
  })
})

describe('createRequestGuard — Origin', () => {
  it('trusts the exact bound origins and the Vite dev origins', () => {
    const g = loopbackGuard()
    expect(g.isTrustedOrigin('http://127.0.0.1:3499')).toBe(true)
    expect(g.isTrustedOrigin('http://localhost:3499')).toBe(true)
    expect(g.isTrustedOrigin('http://localhost:5174')).toBe(true)
    expect(g.isTrustedOrigin('http://127.0.0.1:5174')).toBe(true)
  })

  it('rejects other ports, schemes, hosts and null', () => {
    const g = loopbackGuard()
    expect(g.isTrustedOrigin('http://localhost:9999')).toBe(false)
    expect(g.isTrustedOrigin('https://127.0.0.1:3499')).toBe(false)
    expect(g.isTrustedOrigin('https://evil.example')).toBe(false)
    expect(g.isTrustedOrigin('not a url')).toBe(false)
    expect(g.isAllowedRequestOrigin('null')).toBe(false)
    expect(g.isAllowedRequestOrigin('https://evil.example')).toBe(false)
  })

  it('allows a missing Origin (curl / CLI / Node)', () => {
    expect(loopbackGuard().isAllowedRequestOrigin(undefined)).toBe(true)
  })

  it('does NOT trust the Vite dev origins by default (production runtime)', () => {
    const g = createRequestGuard({ bind: { host: '127.0.0.1', port: 3499 }, lanAddresses: lan })
    expect(g.isTrustedOrigin('http://localhost:5174')).toBe(false)
    expect(g.isAllowedRequestOrigin('http://127.0.0.1:5174')).toBe(false)
    expect(g.isTrustedOrigin('http://127.0.0.1:3499')).toBe(true)
  })

  it('LAN-bound trusts the LAN interface origin', () => {
    const g = createRequestGuard({ bind: { host: '0.0.0.0', port: 3499 }, lanAddresses: lan })
    expect(g.isTrustedOrigin('http://192.168.1.5:3499')).toBe(true)
    expect(g.isTrustedOrigin('http://192.168.1.9:3499')).toBe(false)
  })
})

describe('isJsonContentType', () => {
  it('accepts application/json with optional params', () => {
    expect(isJsonContentType('application/json')).toBe(true)
    expect(isJsonContentType('Application/JSON; charset=UTF-8')).toBe(true)
  })
  it('rejects everything else', () => {
    expect(isJsonContentType('text/plain')).toBe(false)
    expect(isJsonContentType('application/jsonp')).toBe(false)
    expect(isJsonContentType('multipart/form-data; boundary=x')).toBe(false)
    expect(isJsonContentType(undefined)).toBe(false)
  })
})

describe('checkUpgradeRequest', () => {
  const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage
  const g = loopbackGuard()

  it('accepts a good Host with no / trusted Origin', () => {
    expect(checkUpgradeRequest(g, req({ host: '127.0.0.1:3499' }))).toEqual({ ok: true })
    expect(checkUpgradeRequest(g, req({ host: '127.0.0.1:3499', origin: 'http://127.0.0.1:3499' }))).toEqual({ ok: true })
    expect(checkUpgradeRequest(g, req({ host: '127.0.0.1:3499', origin: 'http://localhost:5174' }))).toEqual({ ok: true })
  })

  it('rejects a bad Host or evil Origin', () => {
    expect(checkUpgradeRequest(g, req({ host: 'evil.example:3499' }))).toEqual({ ok: false, reason: 'host' })
    expect(checkUpgradeRequest(g, req({ host: '127.0.0.1:3499', origin: 'https://evil.example' }))).toEqual({ ok: false, reason: 'origin' })
    expect(checkUpgradeRequest(g, req({ host: '127.0.0.1:3499', origin: 'null' }))).toEqual({ ok: false, reason: 'origin' })
  })
})
