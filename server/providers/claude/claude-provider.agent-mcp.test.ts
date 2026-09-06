import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { AgentDefinitionStore } from '../../agent-definition-store.js'
import { McpConfigStore } from '../../mcp-config.js'
import { injectAgentDefinitions } from './claude-provider.js'

function makeStores() {
  const dir = mkdtempSync(join(tmpdir(), 'cw-admcp-'))
  const agentStore = new AgentDefinitionStore({ stateDir: dir })
  const mcpStore = new McpConfigStore({ stateDir: dir })
  return { agentStore, mcpStore }
}

describe('injectAgentDefinitions per-agent MCP resolution', () => {
  it('resolves a known server string to { name: config }', async () => {
    const { agentStore, mcpStore } = makeStores()
    await agentStore.load()
    mcpStore.upsert({ name: 'known', type: 'stdio', command: 'echo' } as never)
    agentStore.upsert({ name: 'a', description: 'd', prompt: 'p', enabled: true, createdAt: 1, updatedAt: 1, mcpServers: ['known'] } as never)
    const opts: Options = {}
    injectAgentDefinitions(opts, agentStore, mcpStore)
    const def = opts.agents!['a'] as { mcpServers?: unknown[] }
    expect(def.mcpServers).toEqual([{ known: { type: 'stdio', command: 'echo' } }])
  })
  it('drops an unknown server name rather than leaving a bare string', async () => {
    const { agentStore, mcpStore } = makeStores()
    await agentStore.load()
    agentStore.upsert({ name: 'b', description: 'd', prompt: 'p', enabled: true, createdAt: 1, updatedAt: 1, mcpServers: ['ghost'] } as never)
    const opts: Options = {}
    injectAgentDefinitions(opts, agentStore, mcpStore)
    const def = opts.agents!['b'] as { mcpServers?: unknown[] }
    expect(def.mcpServers ?? []).toEqual([]) // 'ghost' never configured => dropped
  })
  it('leaves an already-{name:config} entry untouched', async () => {
    const { agentStore, mcpStore } = makeStores()
    await agentStore.load()
    agentStore.upsert({ name: 'c', description: 'd', prompt: 'p', enabled: true, createdAt: 1, updatedAt: 1, mcpServers: [{ inline: { type: 'stdio', command: 'x' } }] } as never)
    const opts: Options = {}
    injectAgentDefinitions(opts, agentStore, mcpStore)
    const def = opts.agents!['c'] as { mcpServers?: unknown[] }
    expect(def.mcpServers).toEqual([{ inline: { type: 'stdio', command: 'x' } }])
  })
})