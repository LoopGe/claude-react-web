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
  it('store defs are the base; pre-existing opts.agents win on name clash', () => {
    store.upsert({ name: 'reviewer', description: 'FromStore', prompt: 'StoreP', enabled: true, createdAt: 1, updatedAt: 1 })
    const opts: Options = { agents: { reviewer: { description: 'FromOpts', prompt: 'OptsP' }, builtin: { description: 'B', prompt: 'PB' } } }
    injectAgentDefinitions(opts, store)
    // builtin has no store def → still present.
    expect(Object.keys(opts.agents!)).toContain('builtin')
    // reviewer exists in both → the pre-existing opts.agents overload wins.
    expect(opts.agents!.reviewer).toEqual({ description: 'FromOpts', prompt: 'OptsP' })
  })
})
