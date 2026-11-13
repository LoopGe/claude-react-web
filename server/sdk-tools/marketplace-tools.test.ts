import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  buildMarketplaceTools,
  createMarketplaceTools,
  MARKETPLACE_READ_ONLY_TOOLS,
  type MarketplaceToolsHost,
} from './marketplace-tools.js'

// The fake returns partial DTOs — only the fields the tools read — so it is
// cast to the host type the way history-tools.test.ts casts its fake.
const host = {
  list: vi.fn(() => [{ id: 'mp', displayName: 'MP' }]),
  plugins: vi.fn(() => [{ name: 'p1', enabled: false }]),
  add: vi.fn(async () => ({ id: 'mp', displayName: 'MP', plugins: [], warnings: [] })),
  checkUpdates: vi.fn(async () => []),
  setPluginEnabled: vi.fn(async () => ({ name: 'p1', enabled: true })),
  remove: vi.fn(async () => {}),
}

const asHost = host as unknown as MarketplaceToolsHost

function call(name: string, input: unknown) {
  const def = buildMarketplaceTools(asHost).find((t) => t.name === name)
  if (!def) throw new Error(`no tool ${name}`)
  return def.handler(input as never, undefined)
}
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.find((c) => c.type === 'text')?.text ?? ''

beforeEach(() => vi.clearAllMocks())

describe('marketplace-tools', () => {
  it('pins the read-only set and the per-tool annotations exactly', () => {
    expect([...MARKETPLACE_READ_ONLY_TOOLS].sort()).toEqual(['check_updates', 'list', 'plugins'])
    const tools = buildMarketplaceTools(asHost)
    const readOnlyHintOf = (name: string) => {
      const def = tools.find((t) => t.name === name)
      if (!def) throw new Error(`no tool ${name}`)
      return def.annotations?.readOnlyHint
    }
    for (const name of ['list', 'plugins', 'check_updates']) {
      expect(readOnlyHintOf(name)).toBe(true)
    }
    for (const name of ['add', 'set_plugin_enabled', 'remove']) {
      expect(readOnlyHintOf(name) ?? false).toBe(false)
    }
  })

  it('remove forwards the id when confirm is true', async () => {
    await call('remove', { id: 'mp', confirm: true })
    expect(host.remove).toHaveBeenCalledWith('mp')
  })

  it('remove refuses to call the host without confirm', async () => {
    const res = await call('remove', { id: 'mp', confirm: false })
    expect(host.remove).not.toHaveBeenCalled()
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('confirm: true')
  })

  it('add forwards url/ref to the host', async () => {
    await call('add', { url: 'https://github.com/anthropics/skills', ref: 'main' })
    expect(host.add).toHaveBeenCalledWith('https://github.com/anthropics/skills', 'main')
  })

  it('set_plugin_enabled forwards id/plugin/enabled', async () => {
    const res = await call('set_plugin_enabled', { id: 'mp', plugin: 'p1', enabled: true })
    expect(host.setPluginEnabled).toHaveBeenCalledWith('mp', 'p1', true)
    expect(text(res)).toContain('"enabled": true')
  })

  it('surfaces a host error as an isError result', async () => {
    host.add.mockRejectedValueOnce(new Error('bad url'))
    const res = await call('add', { url: 'ftp://x' })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('bad url')
  })

  it('builds a server with the expected name and flags', () => {
    const server = createMarketplaceTools(asHost)
    expect(server.name).toBe('marketplace-tools')
    expect(server.defaultEnabled).toBe(true)
    expect(server.requiresCwd).toBe(false)
  })
})
