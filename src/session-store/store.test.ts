import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionStore } from './store'
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
    const items = messages.map((msg, i) => ({
      id: typeof msg.uuid === 'string' ? msg.uuid : `i-${i}`,
      msg,
      isCompactSummary: false,
      hiddenByDefault: false,
    }))
    localStorage.setItem(
      STORAGE_PREFIX + sessionId,
      JSON.stringify({
        v: 1,
        savedAt: Date.now(),
        messages,
        items,
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

  it('starts with an empty toolStatus when no cache exists', () => {
    const store = new SessionStore('session-no-cache')
    expect(store.getSnapshot().toolStatus.size).toBe(0)
    expect(store.getSnapshot().replayReady).toBe(false)
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
    JSON.stringify({ v: 1, savedAt, messages: [], items: [], pad: padding }),
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
