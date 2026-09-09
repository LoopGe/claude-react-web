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

  it('coerceStoredAgentDefinition strips garbage in optional fields but keeps the agent', () => {
    // invalid memory / effort enums — strip, do not drop the agent
    const badMemory = coerceStoredAgentDefinition(baseDef({ memory: 'bad' }))
    expect(badMemory).not.toBeNull()
    expect(badMemory).not.toHaveProperty('memory')
    const badEffort = coerceStoredAgentDefinition(baseDef({ effort: 'ultra' }))
    expect(badEffort).not.toBeNull()
    expect(badEffort).not.toHaveProperty('effort')
    // non-finite maxTurns
    for (const mt of [Number.NaN, Infinity]) {
      const def = coerceStoredAgentDefinition(baseDef({ maxTurns: mt }))
      expect(def).not.toBeNull()
      expect(def).not.toHaveProperty('maxTurns')
    }
    // non-boolean background
    const badBg = coerceStoredAgentDefinition(baseDef({ background: 'yes' }))
    expect(badBg).not.toBeNull()
    expect(badBg).not.toHaveProperty('background')
    // unknown keys are dropped (closed field set)
    const extra = coerceStoredAgentDefinition(baseDef({ injected: 'x' }))
    expect(extra).not.toBeNull()
    expect(extra).not.toHaveProperty('injected')
    // a valid tools array of non-empty strings passes
    expect(coerceStoredAgentDefinition(baseDef({ tools: ['Read', 'Bash'] }))).not.toBeNull()
    // but an empty-string tool is still structurally invalid → drop
    expect(coerceStoredAgentDefinition(baseDef({ tools: ['Read', ''] }))).toBeNull()
  })

  it('accepts every SDK permissionMode including dontAsk and auto', () => {
    for (const pm of ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']) {
      const def = coerceStoredAgentDefinition(baseDef({ permissionMode: pm }))
      expect(def, `permissionMode=${pm}`).not.toBeNull()
      expect(def?.permissionMode).toBe(pm)
    }
  })

  it('strips an illegal permissionMode but keeps the agent (no silent drop)', () => {
    for (const pm of ['disabled', 'everything', 'manual']) {
      const def = coerceStoredAgentDefinition(baseDef({ permissionMode: pm }))
      expect(def, `permissionMode=${pm}`).not.toBeNull()
      expect(def, `permissionMode=${pm}`).not.toHaveProperty('permissionMode')
      expect(def?.name).toBe('reviewer')
      expect(def?.prompt).toBe('You are a reviewer.')
    }
    // The caller's object is not mutated by the strip.
    const raw: Record<string, unknown> = baseDef({ permissionMode: 'disabled' })
    coerceStoredAgentDefinition(raw)
    expect(raw.permissionMode).toBe('disabled')
  })

  it('load() migrates a legacy-disabled agent to enabled:false and does not delete it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-ads-legacy-'))
    const { writeFileSync, readFileSync } = await import('node:fs')
    const file = join(dir, 'agent-definitions.json')
    writeFileSync(file, JSON.stringify([baseDef({ permissionMode: 'disabled' })]), 'utf8')

    const s1 = new AgentDefinitionStore({ stateDir: dir })
    await s1.load()
    expect(s1.has('reviewer')).toBe(true)
    const loaded = s1.get('reviewer')
    expect(loaded).not.toHaveProperty('permissionMode')
    // Legacy 'disabled' meant "don't run" — migrate to the real off switch
    // rather than silently enabling the agent with the session default mode.
    expect(loaded?.enabled).toBe(false)
    expect(s1.getEnabledDefinitions()).toEqual({})

    // A subsequent write used to serialize only the in-memory list — with the
    // old drop-on-invalid-coerce the legacy agent would vanish from disk.
    s1.upsert(baseDef({ name: 'other', description: 'b' }))
    await s1.flush()
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Array<{ name: string; permissionMode?: string; enabled?: boolean }>
    expect(onDisk.map((a) => a.name).sort()).toEqual(['other', 'reviewer'])
    const reviewer = onDisk.find((a) => a.name === 'reviewer')
    expect(reviewer).not.toHaveProperty('permissionMode')
    expect(reviewer?.enabled).toBe(false)
  })
})
