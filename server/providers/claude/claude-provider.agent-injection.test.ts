import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { AgentDefinitionStore } from '../../agent-definition-store.js'
import { injectAgentDefinitions } from './claude-provider.js'

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'cw-adji-'))
  return new AgentDefinitionStore({ stateDir: dir })
}

describe('injectAgentDefinitions', () => {
  let store: AgentDefinitionStore
  beforeEach(async () => { store = makeStore(); await store.load() })

  it('is a no-op when the store is absent', () => {
    const opts: Options = {}
    injectAgentDefinitions(opts, undefined)
    expect(opts.agents).toBeUndefined()
  })
  it('injects only enabled definitions, stripping bookkeeping', () => {
    store.upsert({ name: 'reviewer', description: 'Reviews', prompt: 'You are a reviewer.', enabled: true, createdAt: 1, updatedAt: 1 })
    store.upsert({ name: 'off', description: 'Off', prompt: 'X', enabled: false, createdAt: 1, updatedAt: 1 })
    const opts: Options = {}
    injectAgentDefinitions(opts, store)
    expect(opts.agents).toEqual({ reviewer: { description: 'Reviews', prompt: 'You are a reviewer.' } })
  })
  it('merges over pre-existing opts.agents (custom wins on name clash)', () => {
    store.upsert({ name: 'reviewer', description: 'R', prompt: 'P', enabled: true, createdAt: 1, updatedAt: 1 })
    const opts: Options = { agents: { builtin: { description: 'B', prompt: 'PB' } } }
    injectAgentDefinitions(opts, store)
    expect(Object.keys(opts.agents!)).toContain('builtin')
    expect(opts.agents!.reviewer).toBeDefined()
  })
})