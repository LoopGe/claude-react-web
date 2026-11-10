import { describe, expect, it, vi } from 'vitest'
import { createSessionSearchIndex } from './session-search-index'
import type { TranscriptPageResponse } from '../shared/transcript-page.js'

type FixtureMessage = { seq: number; uuid: string; msg: Record<string, unknown> }

function textMessage(seq: number, uuid: string, role: 'user' | 'assistant', text: string, extra: Record<string, unknown> = {}) {
  return {
    seq,
    uuid,
    msg: { type: role, uuid, parent_tool_use_id: null, message: { role, content: [{ type: 'text', text }] }, ...extra },
  }
}

function toolUseMessage(seq: number, uuid: string, id: string) {
  return {
    seq,
    uuid,
    msg: {
      type: 'assistant',
      uuid,
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] },
    },
  }
}

function toolResultMessage(seq: number, uuid: string, toolUseId: string, text: string, parent: string | null = null) {
  return {
    seq,
    uuid,
    msg: {
      type: 'user',
      uuid,
      parent_tool_use_id: parent,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
    },
  }
}

function makeDeps(fixtures: Record<string, FixtureMessage[]>) {
  let generation = 0
  const pageOf = (all: FixtureMessage[], before: number | undefined, limit: number): TranscriptPageResponse => {
    const headSeq = (all.at(-1)?.seq ?? -1) + 1
    const bound = before ?? headSeq
    const below = all.filter((m) => m.seq < bound)
    const picked = below.slice(-limit)
    return {
      generation,
      headSeq,
      totalCount: all.length,
      startIndex: picked[0]?.seq ?? bound,
      hasMore: below.length > picked.length,
      messages: picked.map(({ seq, msg }) => ({ seq, msg })),
      tombstones: [],
    }
  }
  const getWindow = vi.fn(async (id: string, before?: number, limit = 1000) => pageOf(fixtures[id] ?? [], before, limit))
  const getAfter = vi.fn(async (id: string, afterSeq: number, limit = 1000) => {
    const all = fixtures[id] ?? []
    return {
      generation,
      headSeq: (all.at(-1)?.seq ?? -1) + 1,
      totalCount: all.length,
      messages: all.filter((m) => m.seq > afterSeq).slice(0, limit).map(({ seq, uuid, msg }) => ({ seq, uuid, msg })),
    }
  })
  const isDegraded = vi.fn(async () => false)
  return { getWindow, getAfter, isDegraded, setGeneration: (g: number) => { generation = g } }
}

function fixture(): Record<string, FixtureMessage[]> {
  return {
    s1: [
      textMessage(0, 'u0', 'user', 'how do I cache?'),
      textMessage(1, 'a1', 'assistant', 'use search cache'),
      toolUseMessage(2, 'a2', 'tu1'),
      toolResultMessage(3, 'u3', 'tu1', 'error: boom', 'tu1'),
      textMessage(4, 'u4', 'user', 'next question'),
      textMessage(5, 'a5', 'assistant', 'search is hard'),
      // sidechain inner stream — no main-view row
      textMessage(6, 'a6', 'assistant', 'search inside agent', { parent_tool_use_id: 'tu1' }),
      // hidden harness injection
      textMessage(7, 'u7', 'user', '<task-notification><task-id>t</task-id><status>completed</status></task-notification>'),
      // mid-run steering: a real top-level user prompt, starts a new turn
      textMessage(8, 'u8', 'user', 'search again', { steeredAt: 1 }),
    ],
    s9: [textMessage(0, 'a0', 'assistant', 'search opening')],
  }
}

describe('createSessionSearchIndex', () => {
  it('groups hits under the nearest real user prompt', async () => {
    const deps = makeDeps(fixture())
    const index = createSessionSearchIndex(deps)
    const res = await index.search('s1', 'search', 100)
    expect(res.hits.map((h) => [h.messageSeq, h.turnNo, h.turnPrompt])).toEqual([
      [1, 1, 'how do I cache?'],
      [5, 2, 'next question'],
      [8, 3, 'search again'],
    ])
  })

  it('skips sidechain and hidden frames', async () => {
    const deps = makeDeps(fixture())
    const index = createSessionSearchIndex(deps)
    const res = await index.search('s1', 'search', 100)
    expect(res.hits.map((h) => h.messageSeq)).toEqual([1, 5, 8])
  })

  it('maps a tool_result hit to its owning tool_use seq', async () => {
    const deps = makeDeps(fixture())
    const index = createSessionSearchIndex(deps)
    const res = await index.search('s1', 'boom', 100)
    expect(res.hits).toHaveLength(1)
    expect(res.hits[0]).toMatchObject({
      seq: 2,
      messageSeq: 3,
      ownerToolUseId: 'tu1',
      role: 'tool_result',
    })
  })

  it('treats a steered top-level user message as a new turn', async () => {
    const deps = makeDeps(fixture())
    const index = createSessionSearchIndex(deps)
    const res = await index.search('s1', 'search', 100)
    expect(res.hits.find((h) => h.messageSeq === 8)?.turnNo).toBe(3)
  })

  it('creates a 会话开头 group when the store has no preceding prompt', async () => {
    const deps = makeDeps(fixture())
    const index = createSessionSearchIndex(deps)
    const res = await index.search('s9', 'search', 100)
    expect(res.hits[0]).toMatchObject({ turnNo: 1, turnPrompt: '（会话开头）' })
  })

  it('caps at limit and reports totalHits/truncated', async () => {
    const messages = Array.from({ length: 120 }, (_, i) =>
      textMessage(i, `a${i}`, 'assistant', `needle ${i}`),
    )
    const deps = makeDeps({ cap: messages })
    const index = createSessionSearchIndex(deps)
    const res = await index.search('cap', 'needle', 100)
    expect(res.hits).toHaveLength(100)
    expect(res.totalHits).toBe(120)
    expect(res.truncated).toBe(true)
  })

  it('returns empty for a whitespace query without building', async () => {
    const deps = makeDeps(fixture())
    const index = createSessionSearchIndex(deps)
    const res = await index.search('s1', '   ', 100)
    expect(res.hits).toEqual([])
    expect(deps.getWindow).not.toHaveBeenCalled()
  })

  it('appends only rows above lastIndexedSeq', async () => {
    const fixtures = fixture()
    const deps = makeDeps(fixtures)
    const index = createSessionSearchIndex(deps)
    await index.search('s1', 'search', 100)
    deps.getWindow.mockClear()
    deps.getAfter.mockClear()

    fixtures.s1.push(textMessage(9, 'a9', 'assistant', 'search appended'))
    const res = await index.search('s1', 'search', 100)

    expect(deps.getWindow).not.toHaveBeenCalled()
    expect(deps.getAfter).toHaveBeenCalledWith('s1', 8, 1000)
    expect(res.hits.some((h) => h.messageSeq === 9)).toBe(true)
  })

  it('rebuilds when generation changes', async () => {
    const fixtures = fixture()
    const deps = makeDeps(fixtures)
    const index = createSessionSearchIndex(deps)
    await index.search('s1', 'search', 100)

    deps.setGeneration(1)
    fixtures.s1 = [textMessage(0, 'n0', 'user', 'fresh search')]
    deps.getWindow.mockClear()
    const res = await index.search('s1', 'search', 100)

    expect(deps.getWindow).toHaveBeenCalled()
    expect(res.hits.map((h) => h.messageSeq)).toEqual([0])
    expect(res.hits[0].turnPrompt).toBe('fresh search')
  })
})