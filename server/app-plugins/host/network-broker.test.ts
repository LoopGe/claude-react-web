import { describe, expect, it } from 'vitest'
import { NetworkBroker } from './network-broker.js'
import { PermissionChecker } from '../permission-manager.js'
import { normalisePermissions } from '../../../shared/app-plugins/permissions.js'

function broker(hosts: string[]): NetworkBroker {
  const { permissions } = normalisePermissions([
    { permission: 'network.fetch', params: { hosts } },
  ])
  return new NetworkBroker(new PermissionChecker('com.test', permissions))
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
