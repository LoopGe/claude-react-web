import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionStore } from './store'
import { toTranscriptItem } from './normalize'
import type { SdkMessage } from '../types'

// Mirrors the literal in store.ts. Kept in sync manually — if this
// breaks, update both. (The constant isn't exported because real code
// has no reason to read or write a foreign session's localStorage key.)
const STORAGE_PREFIX = 'claude-web-session:'

function assistantToolUse(name: string, id: string, uuid: string): SdkMessage {
  return {
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input: {} }],
    },
  } as unknown as SdkMessage
}

function userToolResult(toolUseId: string, uuid: string, isError = false): SdkMessage {
  return {
    type: 'user',
    uuid,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: isError ? 'failed' : 'ok',
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
  } as unknown as SdkMessage
}

/** Read a message's content blocks as a typed array (test-only convenience
 *  that also dodges noUncheckedIndexedAccess on the [0] lookup). */
function blocksOf<T>(msg: SdkMessage): T[] {
  return (msg.message?.content as unknown) as T[]
}
/** Read the i-th content block of a message as a typed object. */
function blockField<T>(msg: SdkMessage, i: number): T {
  const blocks = (msg.message?.content as unknown) as T[]
  return blocks[i] as T
}

describe('SessionStore hydration', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('rebuilds toolStatus from cached messages on hydration', () => {
    // Regression: older Read/Grep/Bash cards were stuck on the running
    // spinner after a page reload because the SessionStore constructor
    // restored items+messages from localStorage but didn't rebuild the
    // toolStatus map. useToolStatus then defaulted to 'running' for
    // every cached tool_use card forever.
    const sessionId = 'session-hydration-test'
    const messages = [
      assistantToolUse('Bash', 'tu_bash', 'a-1'),
      userToolResult('tu_bash', 'r-1'),
      assistantToolUse('Read', 'tu_read', 'a-2'),
      userToolResult('tu_read', 'r-2', true), // is_error → 'error'
      assistantToolUse('Grep', 'tu_grep', 'a-3'),
      // tu_grep has no result — still genuinely running.
    ]
    // v2 cache shape: only messages (capped projection) + lastMessageUuid.
    // TranscriptItems are re-derived on load via toTranscriptItem.
    localStorage.setItem(
      STORAGE_PREFIX + sessionId,
      JSON.stringify({
        v: 2,
        savedAt: Date.now(),
        messages,
        lastMessageUuid: 'a-3',
      }),
    )

    const store = new SessionStore(sessionId)
    const snap = store.getSnapshot()
    expect(snap.toolStatus.get('tu_bash')).toBe('success')
    expect(snap.toolStatus.get('tu_read')).toBe('error')
    expect(snap.toolStatus.get('tu_grep')).toBe('running')
    expect(snap.replayReady).toBe(true)
    expect(snap.items).toHaveLength(messages.length)
  })

  it('discards v1 cache shape (treats as no-cache)', () => {
    // v1 stored a duplicated items[] array; v2 drops it. Old v1 entries are
    // discarded on load — the cache is a non-essential render hint and the
    // WS replay repopulates within seconds.
    const sessionId = 'session-v1-discard'
    localStorage.setItem(
      STORAGE_PREFIX + sessionId,
      JSON.stringify({
        v: 1,
        savedAt: Date.now(),
        messages: [assistantToolUse('Bash', 'tu_bash', 'a-1')],
        items: [{ id: 'a-1', msg: assistantToolUse('Bash', 'tu_bash', 'a-1'), isCompactSummary: false, hiddenByDefault: false }],
        lastMessageUuid: 'a-1',
      }),
    )

    const store = new SessionStore(sessionId)
    const snap = store.getSnapshot()
    expect(snap.items).toEqual([])
    expect(snap.replayReady).toBe(false)
  })

  it('re-derives items from cached messages identically to a live build', () => {
    // Dropping the duplicated items[] array is only safe if re-deriving via
    // toTranscriptItem(msg, prev) reproduces the exact items the live store
    // would produce — including isCompactSummary (depends on prev system
    // compact_boundary) and api_retry handling.
    const sessionId = 'session-rederive'
    const store = new SessionStore(sessionId)
    const messages: SdkMessage[] = [
      // compact_boundary system frame → next user msg is a compact summary.
      { type: 'system', subtype: 'compact_boundary', uuid: 's-cb' } as unknown as SdkMessage,
      // The compacted summary lands as a user message.
      { type: 'user', uuid: 'u-summary', message: { role: 'user', content: 'summary of prior context' } } as unknown as SdkMessage,
      assistantToolUse('Bash', 'tu_bash', 'a-1'),
      userToolResult('tu_bash', 'r-1'),
    ]
    for (const msg of messages) {
      store.dispatch({ type: 'MESSAGE', message: msg })
    }
    const liveItems = store.getSnapshot().items

    // destroy() calls save() synchronously, flushing the v2 projection to disk.
    store.destroy()
    const raw = localStorage.getItem(STORAGE_PREFIX + sessionId)
    expect(raw).not.toBeNull()
    const data = JSON.parse(raw!)
    expect(data.v).toBe(2)
    expect(Array.isArray(data.messages)).toBe(true)

    // Re-derive from the persisted messages and compare field-by-field.
    const rederived: typeof liveItems = []
    let prev: (typeof liveItems)[number] | undefined
    for (const msg of data.messages as SdkMessage[]) {
      const item = toTranscriptItem(msg, prev)
      if (item) {
        rederived.push(item)
        prev = item
      }
    }
    expect(rederived).toHaveLength(liveItems.length)
    for (let i = 0; i < liveItems.length; i++) {
      expect(rederived[i].id).toBe(liveItems[i].id)
      expect(rederived[i].isCompactSummary).toBe(liveItems[i].isCompactSummary)
      expect(rederived[i].hiddenByDefault).toBe(liveItems[i].hiddenByDefault)
      expect(rederived[i].plainText).toBe(liveItems[i].plainText)
      expect(rederived[i].deliveryStatus).toBe(liveItems[i].deliveryStatus)
    }
  })

  it('starts with an empty toolStatus when no cache exists', () => {
    const store = new SessionStore('session-no-cache')
    expect(store.getSnapshot().toolStatus.size).toBe(0)
    expect(store.getSnapshot().replayReady).toBe(false)
  })
})

describe('SessionStore projection (persist-only capping)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('caps large content fields on persist and leaves live state untouched', () => {
    const id = 'proj-caps'
    const store = new SessionStore(id)
    const big = 'x'.repeat(20_000) // > 8000 (tool_result) and > 16000 (text)
    const writeInput = 'y'.repeat(70_000) // > 64KB tool_use input cap
    const imageB64 = 'i'.repeat(50_000)

    // Large tool_result content (> 8000).
    store.dispatch({
      type: 'MESSAGE',
      message: {
        type: 'user',
        uuid: 'u-tr',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: big }],
        },
      } as unknown as SdkMessage,
    })
    // Large assistant text block (> 16000).
    store.dispatch({
      type: 'MESSAGE',
      message: {
        type: 'assistant',
        uuid: 'a-text',
        message: { role: 'assistant', content: [{ type: 'text', text: big }] },
      } as unknown as SdkMessage,
    })
    // Write tool_use with large content (> 64KB).
    store.dispatch({
      type: 'MESSAGE',
      message: {
        type: 'assistant',
        uuid: 'a-write',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_write', name: 'Write', input: { file_path: '/x', content: writeInput } }],
        },
      } as unknown as SdkMessage,
    })
    // Image block (should be dropped on persist).
    store.dispatch({
      type: 'MESSAGE',
      message: {
        type: 'user',
        uuid: 'u-img',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'see this:' },
            { type: 'image', source: { type: 'base64', data: imageB64, media_type: 'image/png' } },
          ],
        },
      } as unknown as SdkMessage,
    })

    // Live state is UNCAPPED — projection is persist-only.
    const live = store.getSnapshot()
    const liveTr = blockField<{ content: string }>(live.messages[0], 0).content
    expect(liveTr.length).toBe(20_000)
    const liveText = blockField<{ text: string }>(live.messages[1], 0).text
    expect(liveText.length).toBe(20_000)
    const liveWriteInput = blockField<{ input: { content: string } }>(live.messages[2], 0).input.content
    expect(liveWriteInput.length).toBe(70_000)

    // Flush the debounced save.
    vi.runAllTimers()

    const raw = localStorage.getItem(STORAGE_PREFIX + id)
    expect(raw).not.toBeNull()
    const data = JSON.parse(raw!)
    expect(data.v).toBe(2)
    const msgs = data.messages as SdkMessage[]

    // tool_result content capped (<= 8000 + marker).
    const tr = blockField<{ content: string }>(msgs[0], 0).content
    expect(tr.length).toBeLessThanOrEqual(8000 + '\n…[truncated]'.length)
    expect(tr).toContain('…[truncated]')

    // assistant text capped (<= 16000 + marker).
    const text = blockField<{ text: string }>(msgs[1], 0).text
    expect(text.length).toBeLessThanOrEqual(16_000 + '\n…[truncated]'.length)
    expect(text).toContain('…[truncated]')

    // Write input content capped (<= 64KB + marker).
    const wInput = blockField<{ input: { content: string } }>(msgs[2], 0).input.content
    expect(wInput.length).toBeLessThanOrEqual(64 * 1024 + '\n…[truncated]'.length)
    expect(wInput).toContain('…[truncated]')

    // Image block dropped; the text block it shared the message with survives.
    const imgBlocks = blocksOf<{ type: string }>(msgs[3]).filter((b) => b.type === 'image')
    expect(imgBlocks).toHaveLength(0)
    const textBlocks = blocksOf<{ type: string }>(msgs[3]).filter((b) => b.type === 'text')
    expect(textBlocks.length).toBeGreaterThanOrEqual(1)
  })

  it('substitutes a marker when an image-only message would be left empty', () => {
    const id = 'proj-img-only'
    const store = new SessionStore(id)
    store.dispatch({
      type: 'MESSAGE',
      message: {
        type: 'user',
        uuid: 'u-img-only',
        message: {
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64', data: 'i'.repeat(1000), media_type: 'image/png' } }],
        },
      } as unknown as SdkMessage,
    })
    vi.runAllTimers()
    const data = JSON.parse(localStorage.getItem(STORAGE_PREFIX + id)!)
    const blocks = data.messages[0].message.content as Array<{ type: string; text?: string }>
    expect(blocks.filter((b) => b.type === 'image')).toHaveLength(0)
    expect(blocks.some((b) => b.type === 'text' && /image omitted/.test(b.text ?? ''))).toBe(true)
  })

  it('drops image blocks nested inside a tool_result.content array on persist', () => {
    // A tool that returns a screenshot (computer-use / MCP image result) puts
    // an image block inside tool_result.content. Projection must drop it on
    // persist just like top-level image blocks — otherwise the full base64
    // lands in localStorage (and, via the same projectMessage, in IDB, which
    // has no byte cap → unbounded growth).
    const id = 'proj-tool-result-image'
    const store = new SessionStore(id)
    const imageB64 = 'i'.repeat(50_000)
    store.dispatch({
      type: 'MESSAGE',
      message: {
        type: 'user',
        uuid: 'u-tr-img',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              content: [
                { type: 'text', text: 'screenshot:' },
                { type: 'image', source: { type: 'base64', data: imageB64, media_type: 'image/png' } },
              ],
            },
          ],
        },
      } as unknown as SdkMessage,
    })
    vi.runAllTimers()
    const data = JSON.parse(localStorage.getItem(STORAGE_PREFIX + id)!)
    const tr = data.messages[0].message.content[0] as {
      content: Array<{ type: string; text?: string; source?: { data: string } }>
    }
    // No image block survives into the persisted tool_result content.
    expect(tr.content.filter((b) => b.type === 'image')).toHaveLength(0)
    // The sibling text block survives (only the image is dropped).
    expect(tr.content.some((b) => b.type === 'text' && b.text === 'screenshot:')).toBe(true)
  })

  it('substitutes a marker when an image-only tool_result would be left empty', () => {
    // A tool that returns ONLY a screenshot (computer-use / MCP image result)
    // has tool_result.content = [image]. Dropping the image must not leave an
    // empty array (which renders as a blank "(empty)" card on cold load) —
    // substitute a text marker, mirroring the top-level image-only handling.
    const id = 'proj-tool-result-image-only'
    const store = new SessionStore(id)
    store.dispatch({
      type: 'MESSAGE',
      message: {
        type: 'user',
        uuid: 'u-tr-img-only',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              content: [
                { type: 'image', source: { type: 'base64', data: 'i'.repeat(50_000), media_type: 'image/png' } },
              ],
            },
          ],
        },
      } as unknown as SdkMessage,
    })
    vi.runAllTimers()
    const data = JSON.parse(localStorage.getItem(STORAGE_PREFIX + id)!)
    const tr = data.messages[0].message.content[0] as {
      content: Array<{ type: string; text?: string }>
    }
    // Not an empty array — a marker text block fills it.
    expect(tr.content).not.toEqual([])
    expect(tr.content.length).toBeGreaterThanOrEqual(1)
    expect(tr.content.some((b) => b.type === 'text' && /image omitted/.test(b.text ?? ''))).toBe(true)
  })

  it('byte-budget backstop drops oldest messages but keeps the floor (50)', () => {
    // Build a session whose projected payload exceeds 2MB: many messages
    // each carrying a tool_result just under the 8000 cap (~8KB each).
    // ~300 such messages ≈ 2.4MB projected > 2MB limit.
    const id = 'proj-budget'
    const store = new SessionStore(id)
    const tr = 'x'.repeat(7800)
    for (let i = 0; i < 300; i++) {
      store.dispatch({
        type: 'MESSAGE',
        message: {
          type: 'user',
          uuid: `u-${i}`,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: `tu-${i}`, content: tr }],
          },
        } as unknown as SdkMessage,
      })
    }
    vi.runAllTimers()
    const raw = localStorage.getItem(STORAGE_PREFIX + id)!
    expect(raw.length).toBeLessThanOrEqual(2 * 1024 * 1024 + 256) // within budget (+slack for the floor overshoot)
    const data = JSON.parse(raw)
    const kept = data.messages.length
    // Floor enforced — never trimmed below 50.
    expect(kept).toBeGreaterThanOrEqual(50)
    expect(kept).toBeLessThan(300)
    // lastMessageUuid preserved.
    expect(data.lastMessageUuid).toBe('u-299')
  })
})

describe('SessionStore.clearPersisted', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  function pushUser(store: SessionStore, uuid: string) {
    store.dispatch({
      type: 'MESSAGE',
      message: { type: 'user', uuid, message: { role: 'user', content: 'hi' } } as unknown as SdkMessage,
    })
  }

  it('wipes in-memory state and removes the localStorage key', () => {
    const id = 'clear-test-1'
    const store = new SessionStore(id)
    pushUser(store, 'u1')
    // Flush the debounced save so a key exists on disk.
    vi.runAllTimers()
    expect(localStorage.getItem(STORAGE_PREFIX + id)).not.toBeNull()

    store.clearPersisted()
    expect(store.getSnapshot().items).toEqual([])
    // /clear leaves the session live + empty (no pending replay), so the
    // transcript is ready — the empty-state shows, not the replay skeleton.
    expect(store.getSnapshot().replayReady).toBe(true)
    expect(localStorage.getItem(STORAGE_PREFIX + id)).toBeNull()
  })

  it('does NOT let a pending debounced save resurrect the key', () => {
    // Regression: reset() schedules a debounced save; if clearPersisted
    // only removed the key without cancelling that timer, the timer would
    // later rewrite the key with the empty state. clearPersisted must
    // cancel it so the cache stays gone past the debounce window.
    const id = 'clear-test-2'
    const store = new SessionStore(id)
    pushUser(store, 'u1')
    vi.runAllTimers()
    expect(localStorage.getItem(STORAGE_PREFIX + id)).not.toBeNull()

    store.clearPersisted()
    expect(localStorage.getItem(STORAGE_PREFIX + id)).toBeNull()

    // Advance well past SAVE_DEBOUNCE_MS (2s) / SAVE_MAX_DEFER_MS (10s).
    vi.advanceTimersByTime(15_000)
    vi.runAllTimers()
    expect(localStorage.getItem(STORAGE_PREFIX + id)).toBeNull()
  })
})

// ── Storage quota management (pruneStorageCache / persistToStorage) ──────────
//
// These mirror the constants in store.ts (not exported — real code never
// reads a foreign session's key, and the budget is an internal policy):
const STORAGE_TOTAL_BUDGET = 4 * 1024 * 1024
const MAX_CACHED_SESSIONS = 20

/** Seed a `claude-web-session:*` entry of approximately `bytes` size with an
 *  explicit savedAt so eviction order is deterministic. */
function seedCacheEntry(id: string, savedAt: number, bytes: number): void {
  // The wrapper JSON adds a little overhead; pad `messages` to hit `bytes`.
  const padding = 'x'.repeat(Math.max(0, bytes - 80))
  localStorage.setItem(
    STORAGE_PREFIX + id,
    JSON.stringify({ v: 2, savedAt, messages: [], pad: padding }),
  )
}

function countCacheKeys(): number {
  let n = 0
  for (let i = 0; i < localStorage.length; i++) {
    if (localStorage.key(i)?.startsWith(STORAGE_PREFIX)) n++
  }
  return n
}

function totalCacheBytes(): number {
  let total = 0
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (!k?.startsWith(STORAGE_PREFIX)) continue
    total += (localStorage.getItem(k)?.length ?? 0) + k.length
  }
  return total
}

describe('SessionStore storage quota', () => {
  // Date.now drives both the 60s prune throttle (module-scope _lastPruneAt)
  // and the savedAt of freshly-written entries. Mock it to a large, strictly
  // increasing value per test so (a) the throttle never blocks a prune across
  // tests, and (b) the session we write is always the newest → survives.
  let clock = 10_000_000_000_000
  beforeEach(() => {
    localStorage.clear()
    clock += 120_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('evicts oldest entries by byte budget (count under the cap)', () => {
    // 5 large entries (~1MB each = ~5MB total) but only 5 keys — the old
    // count-only policy (cap 20) would evict NOTHING. The byte budget
    // (4MB) must kick in.
    const big = 1_000_000
    seedCacheEntry('old-1', 1000, big)
    seedCacheEntry('old-2', 2000, big)
    seedCacheEntry('old-3', 3000, big)
    seedCacheEntry('old-4', 4000, big)
    seedCacheEntry('old-5', 5000, big)
    expect(countCacheKeys()).toBe(5)
    expect(totalCacheBytes()).toBeGreaterThan(STORAGE_TOTAL_BUDGET)

    // Writing a new session triggers persistToStorage → setItem + prune.
    const store = new SessionStore('new-session')
    store.destroy() // forces an immediate save()

    // Total is back under budget, and the newest (new-session) survived
    // while the oldest seeded entries were evicted first.
    expect(totalCacheBytes()).toBeLessThanOrEqual(STORAGE_TOTAL_BUDGET)
    expect(localStorage.getItem(STORAGE_PREFIX + 'new-session')).not.toBeNull()
    expect(localStorage.getItem(STORAGE_PREFIX + 'old-1')).toBeNull()
  })

  it('still enforces the count cap when total bytes are small', () => {
    // 25 tiny entries — well under the byte budget but over the count cap.
    for (let i = 0; i < 25; i++) {
      seedCacheEntry(`tiny-${String(i).padStart(2, '0')}`, 1000 + i, 200)
    }
    expect(countCacheKeys()).toBe(25)

    const store = new SessionStore('new-session')
    store.destroy()

    // Down to the cap (the new session counts toward it).
    expect(countCacheKeys()).toBeLessThanOrEqual(MAX_CACHED_SESSIONS)
    expect(localStorage.getItem(STORAGE_PREFIX + 'new-session')).not.toBeNull()
  })

  it('recovers from QuotaExceededError by force-pruning then retrying', () => {
    // Seed entries over budget so the recovery prune has something to evict.
    const big = 1_000_000
    seedCacheEntry('old-1', 1000, big)
    seedCacheEntry('old-2', 2000, big)
    seedCacheEntry('old-3', 3000, big)
    seedCacheEntry('old-4', 4000, big)
    seedCacheEntry('old-5', 5000, big)

    const realSetItem = Storage.prototype.setItem
    let calls = 0
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (this: Storage, k: string, v: string) {
        // Only the NEW session's write should fail-then-succeed; seeding
        // already happened with the real impl before the spy was installed.
        if (k === STORAGE_PREFIX + 'new-session') {
          calls++
          if (calls === 1) {
            throw new DOMException('quota', 'QuotaExceededError')
          }
        }
        return realSetItem.call(this, k, v)
      })

    const store = new SessionStore('new-session')
    store.destroy()

    // First attempt threw, recovery pruned + retried → second attempt wrote.
    expect(calls).toBe(2)
    expect(localStorage.getItem(STORAGE_PREFIX + 'new-session')).not.toBeNull()
    // The force-prune evicted oldest entries to make room.
    expect(localStorage.getItem(STORAGE_PREFIX + 'old-1')).toBeNull()
    setItemSpy.mockRestore()
  })
})

describe('SessionStore dismissed-subagent persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('a dismissed subagent stays hidden after a refresh-style rehydrate', () => {
    // Store A: build an async subagent transcript and dismiss it, then force
    // the cache write (persistNow bypasses the 2s debounce).
    const storeA = new SessionStore('sess-dismiss')
    const toolUse: SdkMessage = {
      type: 'assistant', uuid: 'a-1', receivedAt: 0,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_x', name: 'Agent', input: { description: 'w', run_in_background: true } }] },
    } as unknown as SdkMessage
    const ack: SdkMessage = {
      type: 'user', uuid: 'u-1', parent_tool_use_id: null, receivedAt: 1_000,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_x', content: 'Async agent launched successfully' }] },
    } as unknown as SdkMessage
    storeA.dispatch({ type: 'MESSAGE', message: toolUse })
    storeA.dispatch({ type: 'MESSAGE', message: ack })
    storeA.dispatch({ type: 'DISMISS_SUBAGENT', toolUseId: 'tu_x' })
    storeA.persistNow()

    // A refresh = a brand-new store hydrating from the same localStorage key.
    const storeB = new SessionStore('sess-dismiss')
    const snap = storeB.getSnapshot()
    expect(snap.activeSubagents.some((a) => a.toolUseId === 'tu_x')).toBe(false)
  })

  it('loads a v2 cache without dismissedSubagents as an empty set', () => {
    const key = STORAGE_PREFIX + 'sess-old'
    const msg: SdkMessage = {
      type: 'assistant', uuid: 'a-1', receivedAt: 0,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }] },
    } as unknown as SdkMessage
    // Old v2 shape: no dismissedSubagents field.
    localStorage.setItem(key, JSON.stringify({ v: 2, savedAt: Date.now(), messages: [msg], lastMessageUuid: null }))
    const store = new SessionStore('sess-old')
    expect(store.getState().intent.dismissedSubagents.size).toBe(0)
  })

  it('/clear wipes dismissedSubagents', () => {
    const store = new SessionStore('sess-clear')
    const toolUse: SdkMessage = {
      type: 'assistant', uuid: 'a-1', receivedAt: 0,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_c', name: 'Agent', input: { description: 'w' } }] },
    } as unknown as SdkMessage
    store.dispatch({ type: 'MESSAGE', message: toolUse })
    store.dispatch({ type: 'DISMISS_SUBAGENT', toolUseId: 'tu_c' })
    expect(store.getState().intent.dismissedSubagents.has('tu_c')).toBe(true)
    store.reset() // /clear
    expect(store.getState().intent.dismissedSubagents.size).toBe(0)
  })
})
