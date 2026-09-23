import { describe, it, expect } from 'vitest'
import { createJsonlPageCache, type JsonlDeps } from './jsonl-cache.js'
import { paginateJsonl } from './history-reader.js'

function jsonl(lines: Array<Record<string, unknown>>): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

const SID = 'cache-sess-1'

type FakeFile = { content: string; mtimeMs: number; size: number }

/** In-memory transcript store. Mutate `files` between calls to simulate
 *  appends / rewrites / deletes. `size` must be kept consistent with
 *  `content.length` by the caller (the helper below does it), EXCEPT in
 *  tests that deliberately fake a stat/read race. */
function makeDeps() {
  const files = new Map<string, FakeFile>()
  let readFileCalls = 0
  const deps: JsonlDeps = {
    async locate(sessionId) {
      const f = files.get(sessionId)
      if (!f) return null
      return { path: sessionId, stat: { mtimeMs: f.mtimeMs, size: f.size } }
    },
    async readFile(path) {
      readFileCalls++
      const f = files.get(path)
      if (!f) throw new Error(`ENOENT: ${path}`)
      return f.content
    },
  }
  return {
    deps,
    files,
    readFileCalls: () => readFileCalls,
    put(sessionId: string, content: string, mtimeMs = 1000) {
      files.set(sessionId, { content, mtimeMs, size: content.length })
    },
  }
}

const TRANSCRIPT = jsonl([
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
  { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [] } },
  { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
])

describe('jsonl-cache — full parse, hit, invalidation', () => {
  it('first read parses the file and returns a correct page', async () => {
    const t = makeDeps()
    t.put(SID, TRANSCRIPT)
    const cache = createJsonlPageCache(t.deps)
    const page = await cache.readPage(SID, { limit: 100 })
    expect(page.totalCount).toBe(3)
    expect(page.messages.map((m) => (m as { uuid?: string }).uuid)).toEqual(['u1', 'a1', 'u2'])
    expect(t.readFileCalls()).toBe(1)
  })

  it('unchanged stat → cache hit: no readFile, identical page', async () => {
    const t = makeDeps()
    t.put(SID, TRANSCRIPT)
    const cache = createJsonlPageCache(t.deps)
    const first = await cache.readPage(SID, { limit: 100 })
    const second = await cache.readPage(SID, { limit: 100 })
    expect(t.readFileCalls()).toBe(1)
    expect(second).toEqual(first)
  })

  it('cached pages match paginateJsonl exactly (all window shapes)', async () => {
    const t = makeDeps()
    t.put(SID, TRANSCRIPT)
    const cache = createJsonlPageCache(t.deps)
    for (const opts of [
      { limit: 100 },
      { limit: 2 },
      { before: 2, limit: 2 },
      { before: 0, limit: 2 },
      { beforeUuid: 'u2', limit: 2 },
      { beforeUuid: 'missing', limit: 2 },
    ]) {
      const viaCache = await cache.readPage(SID, opts)
      const direct = paginateJsonl(TRANSCRIPT, SID, opts)
      expect(viaCache).toEqual(direct)
    }
  })

  it('file shrank → full re-parse (rewritten transcript)', async () => {
    const t = makeDeps()
    t.put(SID, TRANSCRIPT)
    const cache = createJsonlPageCache(t.deps)
    await cache.readPage(SID, { limit: 100 })
    // Rewrite with SHORTER content: only one message survives.
    t.put(SID, jsonl([{ type: 'user', uuid: 'u9', message: { role: 'user', content: 'new' } }]), 2000)
    const page = await cache.readPage(SID, { limit: 100 })
    expect(t.readFileCalls()).toBe(2)
    expect(page.totalCount).toBe(1)
    expect(page.messages.map((m) => (m as { uuid?: string }).uuid)).toEqual(['u9'])
  })

  it('same size but new mtime → full re-parse (defensive)', async () => {
    const t = makeDeps()
    t.put(SID, TRANSCRIPT)
    const cache = createJsonlPageCache(t.deps)
    await cache.readPage(SID, { limit: 100 })
    // Same length, different content: uuid swap keeps length identical.
    const sameLength = TRANSCRIPT.replace('first', 'firsT')
    t.put(SID, sameLength, 3000)
    const page = await cache.readPage(SID, { limit: 100 })
    expect(t.readFileCalls()).toBe(2)
    expect((page.messages[0] as { message?: { content?: string } }).message?.content).toBe('firsT')
  })

  it('normalizes once at parse time: consumedAt stamped, trim applied', async () => {
    const t = makeDeps()
    t.put(
      SID,
      jsonl([
        { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } },
        { type: 'user', uuid: 't1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'r' }] } },
      ]),
    )
    const cache = createJsonlPageCache(t.deps)
    const page = await cache.readPage(SID, { limit: 100 })
    const prompt = page.messages[0] as { consumedAt?: number; parent_tool_use_id?: string | null }
    const toolResult = page.messages[1] as { parent_tool_use_id?: string | null; consumedAt?: number }
    expect(prompt.consumedAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'))
    expect(prompt.parent_tool_use_id).toBeNull()
    expect(toolResult.parent_tool_use_id).toBe('tu1')
    expect(toolResult.consumedAt).toBeUndefined()
  })
})
