import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUpdateSkipStore } from './update-skip-store.js'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crw-skip-'))
  file = join(dir, 'update-skipped.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

describe('createUpdateSkipStore', () => {
  it('roundtrips a skip through the file (a new instance sees it)', () => {
    const store = createUpdateSkipStore(file)
    expect(store.isSkipped('1.2.0')).toBe(false)
    store.skip('1.2.0')
    expect(store.isSkipped('1.2.0')).toBe(true)
    expect(createUpdateSkipStore(file).isSkipped('1.2.0')).toBe(true)
  })

  it('caps the list at 50, evicting the oldest', () => {
    const store = createUpdateSkipStore(file)
    for (let i = 0; i <= 50; i++) store.skip(`v${i}`)
    expect(store.isSkipped('v0')).toBe(false)
    expect(store.isSkipped('v1')).toBe(true)
    expect(store.isSkipped('v50')).toBe(true)
  })

  it('a missing file means an empty list', () => {
    const store = createUpdateSkipStore(file)
    expect(store.isSkipped('1.2.0')).toBe(false)
  })

  it('a corrupt file means an empty list, not a throw', () => {
    writeFileSync(file, 'this is not json')
    const store = createUpdateSkipStore(file)
    expect(store.isSkipped('1.2.0')).toBe(false)
    store.skip('1.2.0')
    expect(createUpdateSkipStore(file).isSkipped('1.2.0')).toBe(true)
  })
})