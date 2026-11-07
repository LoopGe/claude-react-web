import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { McpConfigStore } from './mcp-config.js'
import { createMcpServer, updateMcpServer, removeMcpServer, setMcpServerEnabled } from './mcp-ops.js'
import { tempDir, rmRf } from './__test-utils__/index.js'

describe('mcp-ops', () => {
  let dir: string
  let store: McpConfigStore
  beforeEach(async () => {
    dir = tempDir('mcp-ops')
    store = new McpConfigStore({ stateDir: dir })
    await store.load()
  })
  afterEach(() => rmRf(dir))

  it('create validates and defaults type/enabled', () => {
    const s = createMcpServer(store, { name: 'pw', command: 'node', args: ['x.js'] })
    expect(s.type).toBe('stdio')
    expect(s.enabled).toBe(true)
    expect(store.get('pw')?.command).toBe('node')
  })

  it('create rejects a duplicate and an invalid command', () => {
    createMcpServer(store, { name: 'pw', command: 'node' })
    expect(() => createMcpServer(store, { name: 'pw', command: 'node' })).toThrow(/already exists/)
    expect(() => createMcpServer(store, { name: 'bad', command: 'curl' })).toThrow(/not in the allowlist/)
  })

  it('update merges env/headers and keeps existing keys', () => {
    createMcpServer(store, { name: 'pw', command: 'node', env: { A: '1', B: '2' } })
    const s = updateMcpServer(store, 'pw', { env: { B: '3', C: '4' } })
    expect(s.env).toEqual({ A: '1', B: '3', C: '4' })
  })

  it('remove and setEnabled reject an unknown name', () => {
    expect(() => removeMcpServer(store, 'nope')).toThrow(/not found/)
    expect(() => setMcpServerEnabled(store, 'nope', false)).toThrow(/not found/)
  })
})
