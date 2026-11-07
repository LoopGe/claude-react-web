import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildMcpTools, createMcpTools, MCP_READ_ONLY_TOOLS } from './mcp-tools.js'

const host = {
  list: vi.fn(() => []),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  setEnabled: vi.fn(),
  attach: vi.fn(async () => ({ alreadyAttached: false, added: ['pw'], removed: [], errors: {} })),
  detach: vi.fn(async () => ({ alreadyAttached: false, added: [], removed: ['pw'], errors: {} })),
  test: vi.fn(),
}

function call(name: string, input: unknown, sessionId?: string) {
  const def = buildMcpTools(host, { sessionId }).find((t) => t.name === name)
  if (!def) throw new Error(`no tool ${name}`)
  return def.handler(input as never, undefined)
}
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.find((c) => c.type === 'text')?.text ?? ''

beforeEach(() => vi.clearAllMocks())

describe('mcp-tools', () => {
  it('declares its read-only set as a subset of the built tools', () => {
    const names = new Set(buildMcpTools(host).map((t) => t.name))
    expect([...MCP_READ_ONLY_TOOLS].every((n) => names.has(n))).toBe(true)
  })

  it('add requires a session id', async () => {
    const res = await call('add', { name: 'pw', command: 'node' })
    expect(res.isError).toBe(true)
    expect(text(res)).toMatch(/session/i)
  })

  it('add creates then attaches to the calling session', async () => {
    host.get.mockReturnValue(null)
    host.create.mockReturnValue({ name: 'pw' })
    const res = await call('add', { name: 'pw', command: 'node' }, 's1')
    expect(host.create).toHaveBeenCalled()
    expect(host.attach).toHaveBeenCalledWith('s1', 'pw')
    expect(text(res)).toContain('"added"')
  })

  it('add refuses an existing name without overwrite', async () => {
    host.get.mockReturnValue({ name: 'pw' })
    const res = await call('add', { name: 'pw', command: 'node' }, 's1')
    expect(res.isError).toBe(true)
    expect(text(res)).toMatch(/overwrite/)
    expect(host.update).not.toHaveBeenCalled()
  })

  it('add with overwrite updates instead of creating', async () => {
    host.get.mockReturnValue({ name: 'pw' })
    host.update.mockReturnValue({ name: 'pw' })
    await call('add', { name: 'pw', command: 'node', overwrite: true }, 's1')
    expect(host.update).toHaveBeenCalled()
    expect(host.create).not.toHaveBeenCalled()
  })

  it('update forwards the partial without the name', async () => {
    host.update.mockReturnValue({ name: 'pw' })
    await call('update', { name: 'pw', args: ['y.js'] }, 's1')
    expect(host.update).toHaveBeenCalledWith('pw', { args: ['y.js'] })
  })

  it('test delegates to the host', async () => {
    host.test.mockResolvedValue({ success: true, status: 'connected' })
    const res = await call('test', { name: 'pw' }, 's1')
    expect(host.test).toHaveBeenCalledWith('pw')
    expect(text(res)).toContain('"connected"')
  })

  it('remove detaches from the calling session', async () => {
    await call('remove', { name: 'pw' }, 's1')
    expect(host.remove).toHaveBeenCalledWith('pw')
    expect(host.detach).toHaveBeenCalledWith('s1', 'pw')
  })

  it('set_enabled(false) detaches; true attaches', async () => {
    await call('set_enabled', { name: 'pw', enabled: false }, 's1')
    expect(host.detach).toHaveBeenCalledWith('s1', 'pw')
    await call('set_enabled', { name: 'pw', enabled: true }, 's1')
    expect(host.attach).toHaveBeenCalledWith('s1', 'pw')
  })

  it('builds a server with the expected name and flags', () => {
    const server = createMcpTools(host)
    expect(server.name).toBe('mcp-tools')
    expect(server.defaultEnabled).toBe(true)
    expect(server.requiresCwd).toBe(false)
  })
})