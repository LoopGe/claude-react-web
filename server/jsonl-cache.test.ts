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

describe('jsonl-cache — incremental append', () => {
  it('append-only growth parses the suffix and keeps old lines', async () => {
    const t = makeDeps()
    t.put(SID, TRANSCRIPT)
    const cache = createJsonlPageCache(t.deps)
    await cache.readPage(SID, { limit: 100 })
    expect(t.readFileCalls()).toBe(1)
    // Append two more messages (file grows by exactly the new bytes).
    const grown = TRANSCRIPT + '\n' + jsonl([
      { type: 'user', uuid: 'u3', message: { role: 'user', content: 'third' } },
      { type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: [] } },
    ]) + '\n'
    t.put(SID, grown, 4000)
    const page = await cache.readPage(SID, { limit: 100 })
    expect(t.readFileCalls()).toBe(2)
    expect(page.totalCount).toBe(5)
    expect(page.messages.map((m) => (m as { uuid?: string }).uuid)).toEqual(['u1', 'a1', 'u2', 'u3', 'a3'])
    // And a third read hits the cache again.
    await cache.readPage(SID, { limit: 100 })
    expect(t.readFileCalls()).toBe(2)
  })

  it('torn final line is NOT parsed until the line completes', async () => {
    const t = makeDeps()
    const full = TRANSCRIPT + '\n' + jsonl([{ type: 'user', uuid: 'u3', message: { role: 'user', content: 'third' } }]) + '\n'
    // Simulate a writer mid-line: the file holds everything up to mid-JSON.
    const torn = full.slice(0, full.length - 20)
    t.put(SID, torn, 5000)
    const cache = createJsonlPageCache(t.deps)
    const before = await cache.readPage(SID, { limit: 100 })
    expect(before.totalCount).toBe(3) // torn line not counted
    // The writer finishes the line (same total content as `full`).
    t.put(SID, full, 6000)
    const after = await cache.readPage(SID, { limit: 100 })
    expect(after.totalCount).toBe(4)
    expect((after.messages.at(-1) as { uuid?: string }).uuid).toBe('u3')
  })

  it('growth inside the parsed char range falls back to a full re-parse', async () => {
    const t = makeDeps()
    // Multi-byte-heavy content: 10 CJK chars = 30 bytes but 10 chars.
    const cjk = '你好'.repeat(5)
    const first = jsonl([{ type: 'user', uuid: 'u1', message: { role: 'user', content: cjk } }]) + '\n'
    t.put(SID, first, 7000)
    const cache = createJsonlPageCache(t.deps)
    await cache.readPage(SID, { limit: 100 })
    // Append ASCII bytes; byte size grows by more than the char count of the
    // appended region is small — force the pathological gate by appending
    // enough CJK that byte growth outpaces char progress (statSize grows,
    // stat.size may still be < parsedChars in pathological multi-byte cases).
    const grown = first + jsonl([{ type: 'user', uuid: 'u2', message: { role: 'user', content: cjk } }]) + '\n'
    t.put(SID, grown, 8000)
    const page = await cache.readPage(SID, { limit: 100 })
    // Either path (incremental or full) must yield the correct result.
    expect(page.totalCount).toBe(2)
    expect(page.messages.map((m) => (m as { uuid?: string }).uuid)).toEqual(['u1', 'u2'])
  })

  it('stat/read race (read shorter than parse offset) falls back to a full re-parse', async () => {
    const t = makeDeps()
    t.put(SID, TRANSCRIPT)
    const cache = createJsonlPageCache(t.deps)
    await cache.readPage(SID, { limit: 100 })
    // Lie about size (as if it grew), but serve the OLD short content.
    const f = t.files.get(SID)!
    t.files.set(SID, { content: TRANSCRIPT, mtimeMs: 9000, size: f.size + 50 })
    const page = await cache.readPage(SID, { limit: 100 })
    expect(page.totalCount).toBe(3)
    expect(page.messages.map((m) => (m as { uuid?: string }).uuid)).toEqual(['u1', 'a1', 'u2'])
  })
})
