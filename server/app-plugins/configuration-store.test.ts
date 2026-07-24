import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConfigurationStore } from './configuration-store.js'
import type { PluginConfigurationProperty } from '../../shared/app-plugins/contributions.js'

const props: PluginConfigurationProperty[] = [
  { key: 'p.count', type: 'number', title: 'Count', default: 5 },
  { key: 'p.name', type: 'string', title: 'Name', default: 'unset' },
  { key: 'p.flag', type: 'boolean', title: 'Flag', default: false },
]

describe('ConfigurationStore', () => {
  let dir: string
  let store: ConfigurationStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cfg-store-'))
    store = new ConfigurationStore('p', dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))

  it('applies declared defaults on read when unset', async () => {
    const cfg = await store.get(props)
    expect(cfg['p.count']).toBe(5)
    expect(cfg['p.name']).toBe('unset')
    expect(cfg['p.flag']).toBe(false)
  })

  it('persists + reads back a set value', async () => {
    await store.set(props, { 'p.count': 42, 'p.name': 'hi' })
    const cfg = await store.get(props)
    expect(cfg['p.count']).toBe(42)
    expect(cfg['p.name']).toBe('hi')
  })

  it('clearing a field with null reverts it to the declared default on next read', async () => {
    await store.set(props, { 'p.count': 42 })
    expect((await store.get(props))['p.count']).toBe(42)
    // null → server deletes the stored key → read applies the default (5).
    await store.set(props, { 'p.count': null })
    expect((await store.get(props))['p.count']).toBe(5)
  })

  it('rejects invalid values and returns errors without persisting', async () => {
    const errors = await store.set(props, { 'p.count': 'not-a-number' as never })
    expect(errors.length).toBeGreaterThan(0)
    // Unchanged — still the default.
    expect((await store.get(props))['p.count']).toBe(5)
  })
})
