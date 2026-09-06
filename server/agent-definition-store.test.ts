import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentDefinitionStore, coerceStoredAgentDefinition } from './agent-definition-store.js'

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'cw-ads-'))
  return new AgentDefinitionStore({ stateDir: dir })
}

function baseDef(over = {}) {
  return { name: 'reviewer', description: 'Reviews code', prompt: 'You are a reviewer.', enabled: true, createdAt: 1, updatedAt: 1, ...over }
}

describe('AgentDefinitionStore', () => {
  let store: AgentDefinitionStore
  beforeEach(async () => { store = makeStore(); await store.load() })

  it('loads empty on a missing/corrupt file', async () => {
    expect(store.list()).toEqual([])
  })

  it('round-trips upsert/remove via getKey = name', async () => {
    store.upsert(baseDef())
    store.upsert(baseDef({ name: 'r2', description: 'b' }))
    expect(store.get('reviewer')?.prompt).toBe('You are a reviewer.')
    store.remove('reviewer')
    expect(store.has('reviewer')).toBe(false)
    expect(store.get('r2')).toBeDefined()
  })

  it('getEnabledDefinitions strips bookkeeping and filters disabled', () => {
    store.upsert(baseDef())
    store.upsert(baseDef({ name: 'off', enabled: false }))
    const defs = store.getEnabledDefinitions()
    expect(Object.keys(defs)).toEqual(['reviewer'])
    expect(defs.reviewer).not.toHaveProperty('name')
    expect(defs.reviewer).not.toHaveProperty('enabled')
    expect(defs.reviewer).toHaveProperty('prompt', 'You are a reviewer.')
  })

  it('coerceStoredAgentDefinition rejects malformed entries', () => {
    expect(coerceStoredAgentDefinition({ name: 'x' })).toBeNull() // missing prompt/description
    expect(coerceStoredAgentDefinition(baseDef({ prompt: '' }))).toBeNull()
    expect(coerceStoredAgentDefinition(baseDef({ name: 42 }))).toBeNull()
    expect(coerceStoredAgentDefinition(baseDef({ model: '' }))).toBeNull() // empty model rejected
    expect(coerceStoredAgentDefinition(baseDef())).not.toBeNull()
  })

  it('coerceStoredAgentDefinition rejects garbage in optional agent fields', () => {
    // invalid memory enum
    expect(coerceStoredAgentDefinition(baseDef({ memory: 'bad' }))).toBeNull()
    // invalid effort
    expect(coerceStoredAgentDefinition(baseDef({ effort: 'ultra' }))).toBeNull()
    // invalid permissionMode
    expect(coerceStoredAgentDefinition(baseDef({ permissionMode: 'everything' }))).toBeNull()
    // non-finite maxTurns (NaN / Infinity both rejected)
    expect(coerceStoredAgentDefinition(baseDef({ maxTurns: Number.NaN }))).toBeNull()
    expect(coerceStoredAgentDefinition(baseDef({ maxTurns: Infinity }))).toBeNull()
    // non-boolean background
    expect(coerceStoredAgentDefinition(baseDef({ background: 'yes' }))).toBeNull()
    // a valid tools array of non-empty strings passes
    expect(coerceStoredAgentDefinition(baseDef({ tools: ['Read', 'Bash'] }))).not.toBeNull()
    // but an empty-string tool is still rejected
    expect(coerceStoredAgentDefinition(baseDef({ tools: ['Read', ''] }))).toBeNull()
  })
})
