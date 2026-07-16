import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { PromptUuidStore, rewriteSeedPromptUuids, type PromptUuidEntry } from './prompt-uuid-store.js'
import { promptFingerprintHash, type PromptFingerprintInput } from '../shared/prompt-fingerprint.js'

/** Build a top-level user-prompt SDKMessage with the given (disk) uuid + text. */
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
/** A promptUuids entry for a prompt whose content fingerprints to the same
 *  hash as `userPrompt(serverUuid, text)` (i.e. the server-minted uuid for
 *  that text). */
function entryFor(serverUuid: string, text: string): PromptUuidEntry {
  return { u: serverUuid, h: promptFingerprintHash(userPrompt('any', text) as unknown as PromptFingerprintInput) as string }
}

describe('rewriteSeedPromptUuids', () => {
  it('rewrites the seed prompt uuids V -> U when positionally aligned', () => {
    const seed = [userPrompt('V1', 'hi'), asstMsg('a1', 'reply')]
    const promptUuids = [entryFor('U1', 'hi')]
    const out = rewriteSeedPromptUuids(seed, promptUuids)
    expect(out[0].uuid).toBe('U1') // prompt rewritten
    expect(out[1].uuid).toBe('a1') // assistant untouched
  })

  it('rewrites multiple prompts in order (positional, incl. same-text)', () => {
    const seed = [userPrompt('V1', 'ok'), userPrompt('V2', 'ok'), asstMsg('a1', 'r')]
    // Two same-text "ok" prompts: positional alignment disambiguates them.
    const promptUuids = [entryFor('U1', 'ok'), entryFor('U2', 'ok')]
    const out = rewriteSeedPromptUuids(seed, promptUuids)
    expect(out[0].uuid).toBe('U1')
    expect(out[1].uuid).toBe('U2')
  })

  it('aligns the seed against the SUFFIX of a longer promptUuids list (cap case)', () => {
    // promptUuids holds the newest historyCap prompts; the seed window only
    // contains the last 1. The seed's prompt must map to the LAST entry.
    const seed = [userPrompt('V3', 'third')]
    const promptUuids = [entryFor('U1', 'first'), entryFor('U2', 'second'), entryFor('U3', 'third')]
    const out = rewriteSeedPromptUuids(seed, promptUuids)
    expect(out[0].uuid).toBe('U3')
  })

  it('bails (returns seed unchanged) when promptUuids is null/empty (old session)', () => {
    const seed = [userPrompt('V1', 'hi')]
    expect(rewriteSeedPromptUuids(seed, null)).toBe(seed)
    expect(rewriteSeedPromptUuids(seed, [])).toBe(seed)
    expect(rewriteSeedPromptUuids(seed, undefined)).toBe(seed)
  })

  it('bails when the disk has more prompts than promptUuids recorded (offset < 0)', () => {
    // SDK injected an extra user frame promptUuids does not have (desync).
    const seed = [userPrompt('V1', 'hi'), userPrompt('V2', 'ho')]
    const promptUuids = [entryFor('U1', 'hi')] // only one recorded
    const out = rewriteSeedPromptUuids(seed, promptUuids)
    expect(out[0].uuid).toBe('V1') // unchanged — no rewrite
    expect(out[1].uuid).toBe('V2')
  })

  it('bails on a fingerprint mismatch (desync: content drifted)', () => {
    // promptUuids says the newest prompt was "hi" but disk's newest is "changed".
    const seed = [userPrompt('V1', 'changed')]
    const promptUuids = [entryFor('U1', 'hi')] // different content hash
    const out = rewriteSeedPromptUuids(seed, promptUuids)
    expect(out[0].uuid).toBe('V1') // unchanged — bail, fall back to signature dedup
  })

  it('bails when an SDK-injected <task-notification> user frame shifts alignment', () => {
    // Seed has a real prompt + a task-notification (both type user, parent null);
    // promptUuids only has the real prompt. The positional+hash verify must bail.
    const seed = [userPrompt('V1', 'hi'), userPrompt('V2', '<task-notification>done</task-notification>')]
    const promptUuids = [entryFor('U1', 'hi')]
    const out = rewriteSeedPromptUuids(seed, promptUuids)
    expect(out[0].uuid).toBe('V1') // unchanged
    expect(out[1].uuid).toBe('V2')
  })

  it('leaves a seed with no prompts unchanged', () => {
    const seed = [asstMsg('a1', 'reply')]
    const promptUuids = [entryFor('U1', 'hi')]
    const out = rewriteSeedPromptUuids(seed, promptUuids)
    expect(out[0].uuid).toBe('a1')
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
    const entries = [entryFor('U1', 'hi'), entryFor('U2', 'ho')]
    await store.save('s1', entries)
    const loaded = await store.load('s1')
    expect(loaded).toEqual(entries)
  })

  it('load returns null when no sidecar exists', async () => {
    expect(await store.load('missing')).toBeNull()
  })

  it('caps to the newest historyCap entries on save', async () => {
    const entries = [entryFor('U1', 'a'), entryFor('U2', 'b'), entryFor('U3', 'c'), entryFor('U4', 'd')]
    await store.save('s1', entries) // cap = 3 -> keep newest 3 (U2, U3, U4)
    const loaded = await store.load('s1')
    expect(loaded?.map((e) => e.u)).toEqual(['U2', 'U3', 'U4'])
  })

  it('remove deletes the sidecar', async () => {
    await store.save('s1', [entryFor('U1', 'hi')])
    await store.remove('s1')
    expect(await store.load('s1')).toBeNull()
  })

  it('remove is a no-op when no sidecar exists', async () => {
    await expect(store.remove('never')).resolves.toBeUndefined()
  })
})
