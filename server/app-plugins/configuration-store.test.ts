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
    const { errors, changed } = await store.set(props, { 'p.count': 42, 'p.name': 'hi' })
    expect(errors).toEqual([])
    expect(changed).toBe(true)
    const cfg = await store.get(props)
    expect(cfg['p.count']).toBe(42)
    expect(cfg['p.name']).toBe('hi')
  })

  it('reports changed=false for a no-op PUT (values already stored)', async () => {
    const first = await store.set(props, { 'p.count': 42 })
    expect(first.changed).toBe(true)
    // Same value again → no change, no persistence work.
    const second = await store.set(props, { 'p.count': 42 })
    expect(second.changed).toBe(false)
  })

  it('reports changed=false when clearing a key that was never stored', async () => {
    const { changed } = await store.set(props, { 'p.name': null })
    expect(changed).toBe(false)
    expect((await store.get(props))['p.name']).toBe('unset')
  })

  it('clearing a field with null reverts it to the declared default on next read', async () => {
    await store.set(props, { 'p.count': 42 })
    expect((await store.get(props))['p.count']).toBe(42)
    // null → server deletes the stored key → read applies the default (5).
    const { changed } = await store.set(props, { 'p.count': null })
    expect(changed).toBe(true)
    expect((await store.get(props))['p.count']).toBe(5)
  })

  it('rejects invalid values and returns errors without persisting', async () => {
    const { errors, changed } = await store.set(props, { 'p.count': 'not-a-number' as never })
    expect(errors.length).toBeGreaterThan(0)
    expect(changed).toBe(false)
    // Unchanged — still the default.
    expect((await store.get(props))['p.count']).toBe(5)
  })
})
