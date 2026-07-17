import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { PromptUuidStore, rewriteSeedPromptUuids, type PromptUuidEntry } from './prompt-uuid-store.js'

/** Build a top-level user-prompt SDKMessage (a disk-seed entry) with the given
 *  (on-disk SDK) uuid + text. */
function userPrompt(uuid: string, text: string): SDKMessage {
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    message: { role: 'user', content: text },
  } as unknown as SDKMessage
}
function asstMsg(uuid: string, text: string): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as unknown as SDKMessage
}
/** A paired sidecar entry: server uuid `u` ↔ SDK disk uuid `v`. */
function entry(u: string, v: string): PromptUuidEntry {
  return { u, v }
}

describe('rewriteSeedPromptUuids (exact v→u lookup)', () => {
  it('rewrites a seed prompt uuid V -> U when the map has V', () => {
    const seed = [userPrompt('V1', 'hi'), asstMsg('a1', 'reply')]
    const out = rewriteSeedPromptUuids(seed, [entry('U1', 'V1')])
    expect(out[0].uuid).toBe('U1') // prompt rewritten
    expect(out[1].uuid).toBe('a1') // assistant untouched
  })

  it('rewrites multiple prompts by exact uuid, including same-text prompts (no shift)', () => {
    // The #1 regression: two same-text "ok" prompts. Exact v→u lookup maps
    // each disk V to its own server U — no positional shift, unlike the old
    // positional+hash scheme.
    const seed = [userPrompt('V1', 'ok'), userPrompt('V2', 'ok'), asstMsg('a1', 'r')]
    const out = rewriteSeedPromptUuids(seed, [entry('U1', 'V1'), entry('U2', 'V2')])
    expect(out[0].uuid).toBe('U1')
    expect(out[1].uuid).toBe('U2')
  })

  it('leaves a seed prompt unchanged when its V is not in the map (unpaired / SDK-injected)', () => {
    // V2 was sent right before a crash (never echoed → no v pairing) OR is an
    // SDK-injected <task-notification>; either way no mapping → left as V,
    // client signature fallback then handles it.
    const seed = [userPrompt('V1', 'hi'), userPrompt('V2', 'ho')]
    const out = rewriteSeedPromptUuids(seed, [entry('U1', 'V1')])
    expect(out[0].uuid).toBe('U1')
    expect(out[1].uuid).toBe('V2') // unchanged
  })

  it('skips unpaired sidecar entries (v undefined) — they carry no disk uuid', () => {
    const seed = [userPrompt('V1', 'hi')]
    const out = rewriteSeedPromptUuids(seed, [{ u: 'U1' }, { u: 'U2', v: 'V2' }])
    expect(out[0].uuid).toBe('V1') // V1 not in the map (only V2 is) → unchanged
  })

  it('bails (no rewrite) when promptUuids is null/empty (old / fresh session)', () => {
    const seed = [userPrompt('V1', 'hi')]
    expect(rewriteSeedPromptUuids(seed, null)).toBe(seed)
    expect(rewriteSeedPromptUuids(seed, [])).toBe(seed)
    expect(rewriteSeedPromptUuids(seed, undefined)).toBe(seed)
  })

  it('bails when no entry is paired (all v undefined)', () => {
    const seed = [userPrompt('V1', 'hi')]
    const out = rewriteSeedPromptUuids(seed, [{ u: 'U1' }])
    expect(out[0].uuid).toBe('V1') // nothing to look up → unchanged
  })

  it('leaves non-prompt frames (assistant / tool_result-bearing user) untouched', () => {
    const toolResult = {
      type: 'user',
      uuid: 'TR1',
      parent_tool_use_id: 'tu1',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }] },
    } as unknown as SDKMessage
    const seed = [userPrompt('V1', 'hi'), toolResult, asstMsg('a1', 'r')]
    // Even if TR1's uuid coincidentally equaled a paired v, it has a parent_tool_use_id → skipped.
    const out = rewriteSeedPromptUuids(seed, [entry('U1', 'V1'), entry('U-TR', 'TR1')])
    expect(out[0].uuid).toBe('U1') // prompt rewritten
    expect(out[1].uuid).toBe('TR1') // tool_result-bearing user NOT rewritten (parent set)
    expect(out[2].uuid).toBe('a1') // assistant not rewritten
  })

  it('does not rewrite when u === v (already consistent — idempotent)', () => {
    const seed = [userPrompt('V1', 'hi')]
    const out = rewriteSeedPromptUuids(seed, [entry('V1', 'V1')])
    expect(out[0].uuid).toBe('V1')
    expect(out).toBe(seed) // no mutation
  })
})

describe('PromptUuidStore', () => {
  let dir: string
  let store: PromptUuidStore
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'prompt-uuid-'))
    store = new PromptUuidStore(dir, 3) // small cap for cap-testing
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('save / load roundtrip', async () => {
    const entries = [entry('U1', 'V1'), entry('U2', 'V2')]
    await store.save('s1', entries)
    const loaded = await store.load('s1')
    expect(loaded).toEqual(entries)
  })

  it('load returns null when no sidecar exists', async () => {
    expect(await store.load('missing')).toBeNull()
  })

  it('caps to the newest historyCap entries on save', async () => {
    const entries = [entry('U1', 'V1'), entry('U2', 'V2'), entry('U3', 'V3'), entry('U4', 'V4')]
    await store.save('s1', entries) // cap = 3 -> keep newest 3 (U2, U3, U4)
    const loaded = await store.load('s1')
    expect(loaded?.map((e) => e.u)).toEqual(['U2', 'U3', 'U4'])
  })

  it('remove deletes the sidecar', async () => {
    await store.save('s1', [entry('U1', 'V1')])
    await store.remove('s1')
    expect(await store.load('s1')).toBeNull()
  })

  it('remove is a no-op when no sidecar exists', async () => {
    await expect(store.remove('never')).resolves.toBeUndefined()
  })

  it('no-ops load/save/remove when stateDir is undefined (standalone buildApp / unit tests)', async () => {
    const noop = new PromptUuidStore(undefined, 500)
    await expect(noop.load('s1')).resolves.toBeNull()
    await expect(noop.save('s1', [entry('U1', 'V1')])).resolves.toBeUndefined()
    await expect(noop.remove('s1')).resolves.toBeUndefined()
  })
})
