import { describe, expect, it } from 'vitest'
import {
  diffPermissions,
  hasPermission,
  hostMatches,
  isValidHost,
  normalisePermissions,
  type PermissionSpec,
} from './permissions.js'

const p = (perm: PermissionSpec) => perm

describe('normalisePermissions', () => {
  it('accepts bare string permissions', () => {
    const { permissions, unknown } = normalisePermissions(['storage', 'ai.request'])
    expect(unknown).toEqual([])
    expect(permissions.map((x) => x.permission)).toEqual(['storage', 'ai.request'])
  })

  it('drops unknown permissions into `unknown`', () => {
    const { permissions, unknown } = normalisePermissions(['storage', 'nukes.launch' as never])
    expect(permissions.map((x) => x.permission)).toEqual(['storage'])
    expect(unknown).toEqual(['nukes.launch'])
  })

  it('dedupes equivalent entries', () => {
    const { permissions } = normalisePermissions(['storage', 'storage'])
    expect(permissions).toHaveLength(1)
  })

  it('normalises + dedupes network.fetch hosts', () => {
    const { permissions } = normalisePermissions([
      p({ permission: 'network.fetch', params: { hosts: ['API.example.com', 'api.example.com', 'b.example.com'] } }),
    ])
    expect(permissions[0].params.hosts).toEqual(['api.example.com', 'b.example.com'])
  })
})

describe('isValidHost', () => {
  it('accepts bare hosts and wildcards', () => {
    expect(isValidHost('api.example.com')).toBe(true)
    expect(isValidHost('*.example.com')).toBe(true)
  })
  it('rejects IPs, ports, schemes, double wildcards', () => {
    expect(isValidHost('127.0.0.1')).toBe(false)
    expect(isValidHost('api.example.com:8080')).toBe(false)
    expect(isValidHost('https://api.example.com')).toBe(false)
    expect(isValidHost('**.example.com')).toBe(false)
    expect(isValidHost('api.*.com')).toBe(false)
  })

  it('rejects integer/hex/octal IP-literal forms (SSRF defense)', () => {
    expect(isValidHost('2130706433')).toBe(false) // decimal 127.0.0.1
    expect(isValidHost('0x7f000001')).toBe(false) // hex
    expect(isValidHost('017700000001')).toBe(false) // octal
    expect(isValidHost('123')).toBe(false) // bare decimal label
  })
})

describe('diffPermissions', () => {
  const net = (hosts: string[]) => normalisePermissions([
    p({ permission: 'network.fetch', params: { hosts } }),
  ]).permissions

  it('added permission is an escalation', () => {
    const d = diffPermissions([], normalisePermissions(['storage']).permissions)
    expect(d.isEscalation).toBe(true)
    expect(d.added).toHaveLength(1)
  })

  it('removed permission is not an escalation', () => {
    const d = diffPermissions(normalisePermissions(['storage', 'ai.request']).permissions, normalisePermissions(['storage']).permissions)
    expect(d.isEscalation).toBe(false)
    expect(d.removed).toHaveLength(1)
  })

  it('broadened network host set is an escalation', () => {
    const d = diffPermissions(net(['a.example.com']), net(['a.example.com', 'b.example.com']))
    expect(d.isEscalation).toBe(true)
    expect(d.broadened).toHaveLength(1)
  })

  it('narrowed network host set is not an escalation', () => {
    const d = diffPermissions(net(['a.example.com', 'b.example.com']), net(['a.example.com']))
    expect(d.isEscalation).toBe(false)
  })
})

describe('hasPermission', () => {
  const granted = normalisePermissions([
    'storage',
    p({ permission: 'network.fetch', params: { hosts: ['*.example.com', 'api.foo.io'] } }),
  ]).permissions

  it('non-network permission is plain membership', () => {
    expect(hasPermission(granted, 'storage')).toBe(true)
    expect(hasPermission(granted, 'ai.request')).toBe(false)
  })

  it('network.fetch matches exact + wildcard', () => {
    expect(hasPermission(granted, 'network.fetch', { host: 'api.example.com' })).toBe(true)
    expect(hasPermission(granted, 'network.fetch', { host: 'sub.api.example.com' })).toBe(true)
    expect(hasPermission(granted, 'network.fetch', { host: 'api.foo.io' })).toBe(true)
  })

  it('network.fetch rejects unlisted host', () => {
    expect(hasPermission(granted, 'network.fetch', { host: 'evil.example.org' })).toBe(false)
  })

  it('hostMatches direct + wildcard', () => {
    expect(hostMatches('api.example.com', 'api.example.com')).toBe(true)
    expect(hostMatches('sub.example.com', '*.example.com')).toBe(true)
    expect(hostMatches('example.com', '*.example.com')).toBe(false) // wildcard needs a sub-label
    expect(hostMatches('notexample.com', '*.example.com')).toBe(false)
  })
})
