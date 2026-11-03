import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { SlashCommand, AgentInfo } from '../types'

// Cleanup is registered globally in src/test-setup.ts — do not re-add a
// per-file afterEach(cleanup) (CLAUDE.md).

// ── Mock useApi ─────────────────────────────────────────────────────

const mockGet = vi.fn()
vi.mock('./useApi', () => ({
  api: { get: (...args: unknown[]) => mockGet(...args) },
}))

// ── Mock useWsHub ───────────────────────────────────────────────────
// Captures session listeners per-session so tests can emit frames to a
// specific session and verify listener retirement on session switch.

type Frame = { kind: string; [key: string]: unknown }
const listeners = new Map<string, Set<(frame: Frame) => void>>()
const mockAddSessionListener = vi.fn((sid: string, fn: (frame: Frame) => void) => {
  let set = listeners.get(sid)
  if (!set) {
    set = new Set()
    listeners.set(sid, set)
  }
  set.add(fn)
  return () => {
    const s = listeners.get(sid)
    if (!s) return
    s.delete(fn)
    if (s.size === 0) listeners.delete(sid)
  }
})
vi.mock('./useWsHub', () => ({
  useWsHub: () => ({ addSessionListener: mockAddSessionListener }),
}))

// Import AFTER mock.
import { useSessionCatalog } from './useSessionCatalog'

// ── Helpers ─────────────────────────────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function mkCmd(name: string): SlashCommand {
  return { name, description: `desc-${name}`, argumentHint: '', aliases: [] }
}

function mkAgent(name: string): AgentInfo {
  return { name, description: `desc-${name}` }
}

function emitCommandsChanged(sid: string, commands: SlashCommand[]) {
  const set = listeners.get(sid)
  if (set) for (const fn of set) fn({ kind: 'commands-changed', sessionId: sid, commands })
}

/** Flush microtasks so pending .then callbacks run inside act. */
function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function cmdCalls(): number {
  return mockGet.mock.calls.filter((c) => String(c[0]).includes('/commands')).length
}
function agentCalls(): number {
  return mockGet.mock.calls.filter((c) => String(c[0]).includes('/agents')).length
}

// ── Setup ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  listeners.clear()
  mockGet.mockResolvedValue({ commands: [], agents: [] })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Tests ───────────────────────────────────────────────────────────

describe('useSessionCatalog', () => {
  // 1. running mount fetches both; non-running fetches neither
  it('fetches commands and agents on running mount', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/commands')) return Promise.resolve({ commands: [mkCmd('help')] })
      if (url.includes('/agents')) return Promise.resolve({ agents: [mkAgent('coder')] })
      return Promise.resolve({})
    })
    const { result } = renderHook(() => useSessionCatalog('s1', true))
    await waitFor(() => expect(result.current.commands).toHaveLength(1))
    expect(result.current.agents).toHaveLength(1)
    expect(mockGet).toHaveBeenCalledWith('/sessions/s1/commands')
    expect(mockGet).toHaveBeenCalledWith('/sessions/s1/agents')
  })

  it('does not fetch on non-running mount', async () => {
    renderHook(() => useSessionCatalog('s1', false))
    await flush()
    expect(mockGet).not.toHaveBeenCalled()
  })

  // 2. empty array response writes cache; running false→true hits cache, no duplicate GET
  it('caches empty array; running false→true hits cache without refetch', async () => {
    const { result, rerender } = renderHook(
      ({ sid, run }) => useSessionCatalog(sid, run),
      { initialProps: { sid: 's1', run: true } },
    )
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2))
    expect(result.current.commands).toEqual([])
    rerender({ sid: 's1', run: false })
    await flush()
    rerender({ sid: 's1', run: true })
    await flush()
    expect(mockGet).toHaveBeenCalledTimes(2) // no additional fetch
  })

  // 3. session A→B shows B cache/[] immediately; A's late initial doesn't write B
  it('session switch shows B cache/[] immediately; A late initial is no-op', async () => {
    const aDeferred = deferred<{ commands: SlashCommand[] }>()
    const bDeferred = deferred<{ commands: SlashCommand[] }>()
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/s1/commands')) return aDeferred.promise
      if (url.includes('/s2/commands')) return bDeferred.promise
      if (url.includes('/agents')) return Promise.resolve({ agents: [] })
      return Promise.resolve({})
    })
    const { result, rerender } = renderHook(
      ({ sid }) => useSessionCatalog(sid, true),
      { initialProps: { sid: 's1' } },
    )
    await waitFor(() => expect(cmdCalls()).toBe(1))
    // Switch to s2 — B shows [] immediately
    rerender({ sid: 's2' })
    expect(result.current.commands).toEqual([])
    // A's late initial resolves — must NOT write to s2
    await act(async () => {
      aDeferred.resolve({ commands: [mkCmd('s1cmd')] })
      await Promise.resolve()
    })
    expect(result.current.commands).toEqual([])
    // B's fetch resolves — commits
    await act(async () => {
      bDeferred.resolve({ commands: [mkCmd('s2cmd')] })
      await Promise.resolve()
    })
    expect(result.current.commands).toEqual([mkCmd('s2cmd')])
  })

  // 4. A's old commands-changed listener after switch must not modify B
  it('old commands-changed listener retired after session switch', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/commands')) return Promise.resolve({ commands: [] })
      if (url.includes('/agents')) return Promise.resolve({ agents: [] })
      return Promise.resolve({})
    })
    const { result, rerender } = renderHook(
      ({ sid }) => useSessionCatalog(sid, true),
      { initialProps: { sid: 's1' } },
    )
    await waitFor(() => expect(cmdCalls()).toBe(1))
    expect(listeners.has('s1')).toBe(true)
    rerender({ sid: 's2' })
    // s1 listener retired
    expect(listeners.has('s1')).toBe(false)
    expect(listeners.has('s2')).toBe(true)
    // Frame to s2 updates commands
    act(() => emitCommandsChanged('s2', [mkCmd('ws-s2')]))
    expect(result.current.commands).toEqual([mkCmd('ws-s2')])
    // Frame to s1 has no listener — no-op
    act(() => emitCommandsChanged('s1', [mkCmd('ws-s1')]))
    expect(result.current.commands).toEqual([mkCmd('ws-s2')])
  })

  // 5. running true→false keeps items, late REST no-op; false→true cache miss re-GETs
  it('running true→false keeps items; late REST no-op; false→true cache miss refetches', async () => {
    const initialDeferred = deferred<{ commands: SlashCommand[] }>()
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/commands')) return initialDeferred.promise
      if (url.includes('/agents')) return Promise.resolve({ agents: [] })
      return Promise.resolve({})
    })
    const { result, rerender } = renderHook(
      ({ sid, run }) => useSessionCatalog(sid, run),
      { initialProps: { sid: 's1', run: true } },
    )
    await waitFor(() => expect(cmdCalls()).toBe(1))
    expect(result.current.commands).toEqual([]) // initial in-flight
    // true → false: items preserved
    rerender({ sid: 's1', run: false })
    await flush()
    expect(result.current.commands).toEqual([])
    // Late initial response — no-op (cancelled + token mismatch)
    const refetchDeferred = deferred<{ commands: SlashCommand[] }>()
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/commands')) return refetchDeferred.promise
      if (url.includes('/agents')) return Promise.resolve({ agents: [] })
      return Promise.resolve({})
    })
    await act(async () => {
      initialDeferred.resolve({ commands: [mkCmd('late')] })
      await Promise.resolve()
    })
    expect(result.current.commands).toEqual([]) // no-op
    // false → true: cache miss (initial never wrote cache), refetch
    rerender({ sid: 's1', run: true })
    await waitFor(() => expect(cmdCalls()).toBe(2))
    await act(async () => {
      refetchDeferred.resolve({ commands: [mkCmd('fresh')] })
      await Promise.resolve()
    })
    expect(result.current.commands).toEqual([mkCmd('fresh')])
  })

  // 6. non-running refresh clears cache, keeps items, zero GET; running re-GETs
  it('non-running refresh clears cache, keeps items, zero GET; running re-GETs', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/commands')) return Promise.resolve({ commands: [mkCmd('help')] })
      if (url.includes('/agents')) return Promise.resolve({ agents: [] })
      return Promise.resolve({})
    })
    const { result, rerender } = renderHook(
      ({ sid, run }) => useSessionCatalog(sid, run),
      { initialProps: { sid: 's1', run: true } },
    )
    await waitFor(() => expect(result.current.commands).toEqual([mkCmd('help')]))
    expect(cmdCalls()).toBe(1)
    // running → false
    rerender({ sid: 's1', run: false })
    await flush()
    expect(result.current.commands).toEqual([mkCmd('help')]) // preserved
    // refresh while non-running: clears cache, keeps items, no GET
    act(() => result.current.refreshCommands())
    await flush()
    expect(result.current.commands).toEqual([mkCmd('help')]) // still preserved
    expect(cmdCalls()).toBe(1) // no new GET
    // running → true: cache miss (cleared by refresh), refetch
    const refetchDeferred = deferred<{ commands: SlashCommand[] }>()
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/commands')) return refetchDeferred.promise
      if (url.includes('/agents')) return Promise.resolve({ agents: [] })
      return Promise.resolve({})
    })
    rerender({ sid: 's1', run: true })
    await waitFor(() => expect(cmdCalls()).toBe(2))
    await act(async () => {
      refetchDeferred.resolve({ commands: [mkCmd('fresh')] })
      await Promise.resolve()
    })
    expect(result.current.commands).toEqual([mkCmd('fresh')])
  })

  // 7. initial in-flight when refresh fires; old initial doesn't overwrite refresh
  it('initial in-flight when refresh fires; old initial does not overwrite refresh', async () => {
    const initialDeferred = deferred<{ commands: SlashCommand[] }>()
    const refreshDeferred = deferred<{ commands: SlashCommand[] }>()
    let cmdCallIdx = 0
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/commands')) {
        cmdCallIdx++
        return cmdCallIdx === 1 ? initialDeferred.promise : refreshDeferred.promise
      }
      if (url.includes('/agents')) return Promise.resolve({ agents: [] })
      return Promise.resolve({})
    })
    const { result } = renderHook(() => useSessionCatalog('s1', true))
    await waitFor(() => expect(cmdCallIdx).toBe(1))
    // refresh while initial in-flight
    act(() => result.current.refreshCommands())
    await waitFor(() => expect(cmdCallIdx).toBe(2))
    // resolve initial (late) — no-op
    await act(async () => {
      initialDeferred.resolve({ commands: [mkCmd('initial')] })
      await Promise.resolve()
    })
    expect(result.current.commands).toEqual([])
    // resolve refresh — commits
    await act(async () => {
      refreshDeferred.resolve({ commands: [mkCmd('refresh')] })
      await Promise.resolve()
    })
    expect(result.current.commands).toEqual([mkCmd('refresh')])
  })

  // 8. same-tick double refresh: only last response commits
  it('same-tick double refresh: only last response commits', async () => {
    const deferreds: Deferred<{ commands: SlashCommand[] }>[] = []
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/commands')) {
        const d = deferred<{ commands: SlashCommand[] }>()
        deferreds.push(d)
        return d.promise
      }
      if (url.includes('/agents')) return Promise.resolve({ agents: [] })
      return Promise.resolve({})
    })
    const { result } = renderHook(() => useSessionCatalog('s1', true))
    await waitFor(() => expect(deferreds).toHaveLength(1))
    await act(async () => {
      deferreds[0].resolve({ commands: [mkCmd('initial')] })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.commands).toEqual([mkCmd('initial')]))
    // double refresh in same tick
    act(() => {
      result.current.refreshCommands()
      result.current.refreshCommands()
    })
    await waitFor(() => expect(deferreds).toHaveLength(3))
    // resolve both refreshes — only last commits
    await act(async () => {
      deferreds[1].resolve({ commands: [mkCmd('r1')] })
      deferreds[2].resolve({ commands: [mkCmd('r2')] })
      await Promise.resolve()
    })
    expect(result.current.commands).toEqual([mkCmd('r2')])
  })

  // 9. commands-changed during in-flight REST: old REST does not overwrite WS list
  it('commands-changed during in-flight REST: old REST does not overwrite WS list', async () => {
    const initialDeferred = deferred<{ commands: SlashCommand[] }>()
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/commands')) return initialDeferred.promise
      if (url.includes('/agents')) return Promise.resolve({ agents: [] })
      return Promise.resolve({})
    })
    const { result } = renderHook(() => useSessionCatalog('s1', true))
    await waitFor(() => expect(cmdCalls()).toBe(1))
    // WS frame arrives while initial in-flight
    act(() => emitCommandsChanged('s1', [mkCmd('ws-cmd')]))
    expect(result.current.commands).toEqual([mkCmd('ws-cmd')])
    // resolve initial — no-op
    await act(async () => {
      initialDeferred.resolve({ commands: [mkCmd('initial')] })
      await Promise.resolve()
    })
    expect(result.current.commands).toEqual([mkCmd('ws-cmd')])
  })

  // 10. non-running commands-changed still updates cache/items
  it('commands-changed while non-running updates cache and items', async () => {
    const { result, rerender } = renderHook(
      ({ sid, run }) => useSessionCatalog(sid, run),
      { initialProps: { sid: 's1', run: false } },
    )
    await flush()
    expect(mockGet).not.toHaveBeenCalled()
    // WS frame arrives while non-running
    act(() => emitCommandsChanged('s1', [mkCmd('ws-cmd')]))
    expect(result.current.commands).toEqual([mkCmd('ws-cmd')])
    // cache was written: flip running → true, commands should NOT refetch
    rerender({ sid: 's1', run: true })
    await flush()
    expect(cmdCalls()).toBe(0) // cache hit
    expect(agentCalls()).toBe(1) // agents cache miss → fetch
  })

  // 11. commands and agents resources are independent
  it('commands and agents resources are independent', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/commands')) return Promise.resolve({ commands: [mkCmd('cmd1')] })
      if (url.includes('/agents')) return Promise.resolve({ agents: [mkAgent('a1')] })
      return Promise.resolve({})
    })
    const { result } = renderHook(() => useSessionCatalog('s1', true))
    await waitFor(() => expect(result.current.commands).toEqual([mkCmd('cmd1')]))
    await waitFor(() => expect(result.current.agents).toEqual([mkAgent('a1')]))
    // refresh commands — only commands changes
    const cmdRefresh = deferred<{ commands: SlashCommand[] }>()
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/commands')) return cmdRefresh.promise
      if (url.includes('/agents')) return Promise.resolve({ agents: [mkAgent('a1')] })
      return Promise.resolve({})
    })
    act(() => result.current.refreshCommands())
    await act(async () => {
      cmdRefresh.resolve({ commands: [mkCmd('cmd2')] })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.commands).toEqual([mkCmd('cmd2')]))
    expect(result.current.agents).toEqual([mkAgent('a1')]) // unchanged
    // refresh agents — only agents changes
    const agentRefresh = deferred<{ agents: AgentInfo[] }>()
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/commands')) return Promise.resolve({ commands: [mkCmd('cmd2')] })
      if (url.includes('/agents')) return agentRefresh.promise
      return Promise.resolve({})
    })
    act(() => result.current.refreshAgents())
    await act(async () => {
      agentRefresh.resolve({ agents: [mkAgent('a2')] })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.agents).toEqual([mkAgent('a2')]))
    expect(result.current.commands).toEqual([mkCmd('cmd2')]) // unchanged
    // WS commands-changed — only commands updated
    act(() => emitCommandsChanged('s1', [mkCmd('ws-cmd')]))
    expect(result.current.commands).toEqual([mkCmd('ws-cmd')])
    expect(result.current.agents).toEqual([mkAgent('a2')]) // unchanged
  })

  // 12. request failure keeps items, doesn't fill cache; subsequent refresh retries
  it('request failure keeps items; subsequent refresh retries successfully', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/commands')) return Promise.resolve({ commands: [mkCmd('cmd1')] })
      if (url.includes('/agents')) return Promise.resolve({ agents: [] })
      return Promise.resolve({})
    })
    const { result } = renderHook(() => useSessionCatalog('s1', true))
    await waitFor(() => expect(result.current.commands).toEqual([mkCmd('cmd1')]))
    // refresh — fails
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/commands')) return Promise.reject(new Error('network'))
      if (url.includes('/agents')) return Promise.resolve({ agents: [] })
      return Promise.resolve({})
    })
    act(() => result.current.refreshCommands())
    await flush()
    expect(result.current.commands).toEqual([mkCmd('cmd1')]) // preserved
    // refresh again — succeeds
    const retryDeferred = deferred<{ commands: SlashCommand[] }>()
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/commands')) return retryDeferred.promise
      if (url.includes('/agents')) return Promise.resolve({ agents: [] })
      return Promise.resolve({})
    })
    act(() => result.current.refreshCommands())
    await act(async () => {
      retryDeferred.resolve({ commands: [mkCmd('cmd2')] })
      await Promise.resolve()
    })
    expect(result.current.commands).toEqual([mkCmd('cmd2')])
  })

  // 13. unmount: deferred response produces no act warning or unhandled rejection
  it('unmount: deferred response produces no act warning or unhandled rejection', async () => {
    const cmdDeferred = deferred<{ commands: SlashCommand[] }>()
    const agentDeferred = deferred<{ agents: AgentInfo[] }>()
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/commands')) return cmdDeferred.promise
      if (url.includes('/agents')) return agentDeferred.promise
      return Promise.resolve({})
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = renderHook(() => useSessionCatalog('s1', true))
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2))
    unmount()
    await act(async () => {
      cmdDeferred.resolve({ commands: [mkCmd('late')] })
      agentDeferred.resolve({ agents: [mkAgent('late')] })
      await Promise.resolve()
    })
    const relevant = errorSpy.mock.calls
      .map((c) => c.map(String).join(' '))
      .filter((s) => /act|unmount|unhandled/i.test(s))
    expect(relevant).toEqual([])
    errorSpy.mockRestore()
  })

  // 14. refresh identity stable across items/cache/token updates; changes on session/running
  it('refresh identity stable across state updates; changes on session/running', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/commands')) return Promise.resolve({ commands: [mkCmd('cmd1')] })
      if (url.includes('/agents')) return Promise.resolve({ agents: [] })
      return Promise.resolve({})
    })
    const { result, rerender } = renderHook(
      ({ sid, run }) => useSessionCatalog(sid, run),
      { initialProps: { sid: 's1', run: true } },
    )
    const firstCmd = result.current.refreshCommands
    const firstAgent = result.current.refreshAgents
    // initial fetch completes (items/cache/token change)
    await waitFor(() => expect(result.current.commands).toEqual([mkCmd('cmd1')]))
    expect(result.current.refreshCommands).toBe(firstCmd)
    expect(result.current.refreshAgents).toBe(firstAgent)
    // refresh (token/cache change)
    await act(async () => {
      result.current.refreshCommands()
      await Promise.resolve()
    })
    expect(result.current.refreshCommands).toBe(firstCmd)
    // change running → new identity
    rerender({ sid: 's1', run: false })
    expect(result.current.refreshCommands).not.toBe(firstCmd)
    expect(result.current.refreshAgents).not.toBe(firstAgent)
    // change session → new identity
    const afterRun = result.current.refreshCommands
    rerender({ sid: 's2', run: false })
    expect(result.current.refreshCommands).not.toBe(afterRun)
  })

  // 15. hook remount does not inherit previous instance cache
  it('hook remount does not inherit previous instance cache', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/commands')) return Promise.resolve({ commands: [mkCmd('cmd1')] })
      if (url.includes('/agents')) return Promise.resolve({ agents: [] })
      return Promise.resolve({})
    })
    const { unmount: unmount1 } = renderHook(() => useSessionCatalog('s1', true))
    await waitFor(() => expect(cmdCalls()).toBe(1))
    await flush()
    unmount1()
    // New instance — should NOT inherit cache
    const { result: result2 } = renderHook(() => useSessionCatalog('s1', true))
    await waitFor(() => expect(result2.current.commands).toEqual([mkCmd('cmd1')]))
    expect(cmdCalls()).toBe(2) // new instance fetched
  })
})
