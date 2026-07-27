import { describe, expect, it } from 'vitest'
import { validateManifest } from './manifest-validator.js'
import type { PluginManifest } from './manifest.js'

const base: PluginManifest = {
  manifestVersion: 1,
  id: 'com.example.plugin',
  name: 'Example',
  version: '1.0.0',
  engines: { claudeReactWeb: '^2.5.0', node: '>=20' },
  runtime: { service: 'dist/service.mjs' },
  permissions: ['storage', { permission: 'network.fetch', params: { hosts: ['api.example.com'] } }],
  contributes: {
    commands: [
      { id: 'com.example.plugin.run', title: 'Run' },
      { id: 'com.example.plugin.select', title: 'On selection', category: 'message.selection' },
    ],
    contextMenus: [
      { id: 'com.example.plugin.menu', location: 'message.selectionContextMenu', commandId: 'com.example.plugin.select', title: 'Example' },
    ],
    actions: [
      { id: 'com.example.plugin.header', location: 'chat.header', commandId: 'com.example.plugin.run', title: 'Run' },
    ],
    configuration: { properties: [{ key: 'com.example.plugin.target', type: 'string', title: 'Target', default: 'a' }] },
  },
}

const opts = { hostVersion: '2.6.0', hostNodeMajor: 20 }

describe('validateManifest — happy path', () => {
  it('accepts a well-formed manifest', () => {
    const r = validateManifest(base, opts)
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.permissions).toHaveLength(2)
    expect(r.contributions?.commands).toHaveLength(2)
    expect(r.contributions?.contextMenus).toHaveLength(1)
    expect(r.contributions?.actions).toHaveLength(1)
    expect(r.contributions?.configuration.properties).toHaveLength(1)
  })
})

describe('validateManifest — structural errors', () => {
  it('rejects wrong manifestVersion', () => {
    const r = validateManifest({ ...base, manifestVersion: 2 as 1 }, opts)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/manifestVersion/)
  })

  it('rejects bad id', () => {
    const r = validateManifest({ ...base, id: 'Bad Id' }, opts)
    expect(r.ok).toBe(false)
  })

  it('rejects missing runtime.service', () => {
    const r = validateManifest({ ...base, runtime: { service: '' } }, opts)
    expect(r.ok).toBe(false)
  })

  it('rejects absolute service path', () => {
    const r = validateManifest({ ...base, runtime: { service: '/evil.mjs' } }, opts)
    expect(r.ok).toBe(false)
  })

  it('rejects non-.mjs service', () => {
    const r = validateManifest({ ...base, runtime: { service: 'dist/service.js' } }, opts)
    expect(r.ok).toBe(false)
  })

  it('rejects engines mismatch', () => {
    const r = validateManifest({ ...base, engines: { claudeReactWeb: '^3.0.0', node: '>=20' } }, opts)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/claudeReactWeb/)
  })

  it('rejects node mismatch', () => {
    const r = validateManifest({ ...base, engines: { claudeReactWeb: '^2.5.0', node: '>=99' } }, opts)
    expect(r.ok).toBe(false)
  })
})

describe('validateManifest — contribution diagnostics (warnings, not errors)', () => {
  it('flags contribution id not prefixed by plugin id', () => {
    const r = validateManifest({
      ...base,
      contributes: { ...base.contributes, commands: [{ id: 'com.other.run', title: 'X' }] },
    }, opts)
    expect(r.ok).toBe(true)
    expect(r.warnings.join()).toMatch(/must be prefixed/)
    expect(r.contributions?.commands).toHaveLength(0)
  })

  it('flags unknown contextMenu location', () => {
    const r = validateManifest({
      ...base,
      contributes: {
        ...base.contributes,
        contextMenus: [{ id: 'com.example.plugin.m', location: 'nowhere' as never, commandId: 'com.example.plugin.run', title: 'x' }],
      },
    }, opts)
    expect(r.ok).toBe(true)
    expect(r.warnings.join()).toMatch(/unknown location/)
  })

  it('flags contextMenu pointing at a non-plugin command', () => {
    const r = validateManifest({
      ...base,
      contributes: {
        ...base.contributes,
        contextMenus: [{ id: 'com.example.plugin.m', location: 'message.selectionContextMenu', commandId: 'com.other.run', title: 'x' }],
      },
    }, opts)
    expect(r.ok).toBe(true)
    expect(r.warnings.join()).toMatch(/commandId must reference a plugin command/)
  })

  it('flags malformed when clause', () => {
    const r = validateManifest({
      ...base,
      contributes: {
        ...base.contributes,
        commands: [{ id: 'com.example.plugin.run', title: 'Run', when: 'a || b' }],
      },
    }, opts)
    expect(r.ok).toBe(true)
    expect(r.warnings.join()).toMatch(/malformed 'when'/)
    expect(r.contributions?.commands).toHaveLength(0)
  })

  it('drops unknown permissions to warnings', () => {
    const r = validateManifest({ ...base, permissions: ['storage', 'nukes.launch' as never] }, opts)
    expect(r.ok).toBe(true)
    expect(r.warnings.join()).toMatch(/unknown permission ignored/)
    expect(r.permissions).toHaveLength(1)
  })

  it('flags configuration key not prefixed', () => {
    const r = validateManifest({
      ...base,
      contributes: { ...base.contributes, configuration: { properties: [{ key: 'target', type: 'string', title: 'T' }] } },
    }, opts)
    expect(r.ok).toBe(true)
    expect(r.warnings.join()).toMatch(/configuration key must be prefixed/)
  })

  it('resolves valid statusIndicators', () => {
    const r = validateManifest({
      ...base,
      contributes: {
        ...base.contributes,
        statusIndicators: [{ id: 'com.example.plugin.working', asset: 'assets/nyan.svg', when: 'session.working == true' }],
      },
    }, opts)
    expect(r.ok).toBe(true)
    expect(r.contributions?.statusIndicators).toHaveLength(1)
    expect(r.contributions?.statusIndicators[0].asset).toBe('assets/nyan.svg')
  })

  it('flags statusIndicator with bad asset path', () => {
    const r = validateManifest({
      ...base,
      contributes: {
        ...base.contributes,
        statusIndicators: [{ id: 'com.example.plugin.working', asset: '../../../etc/passwd' }],
      },
    }, opts)
    expect(r.ok).toBe(true)
    expect(r.warnings.join()).toMatch(/asset/)
    expect(r.contributions?.statusIndicators).toHaveLength(0)
  })

  it('flags statusIndicator with id not prefixed', () => {
    const r = validateManifest({
      ...base,
      contributes: {
        ...base.contributes,
        statusIndicators: [{ id: 'other.working', asset: 'assets/x.svg' }],
      },
    }, opts)
    expect(r.ok).toBe(true)
    expect(r.warnings.join()).toMatch(/must be prefixed/)
  })

  it('flags statusIndicator with malformed when', () => {
    const r = validateManifest({
      ...base,
      contributes: {
        ...base.contributes,
        statusIndicators: [{ id: 'com.example.plugin.working', asset: 'assets/x.svg', when: 'a || b' }],
      },
    }, opts)
    expect(r.ok).toBe(true)
    expect(r.warnings.join()).toMatch(/malformed 'when'/)
  })
})
