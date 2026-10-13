import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mutatingToolUseId,
  scheduleGitBroadcast,
  cancelGitBroadcast,
} from './git-broadcast.js'
import type { SessionBroadcaster } from './session-types.js'
import { GIT_BROADCAST_MAX_WAIT_MS } from './constants.js'

// ── Pure detection helper ────────────────────────────────────────────

describe('mutatingToolUseId', () => {
  it('returns the id for Edit tool_use blocks', () => {
    expect(mutatingToolUseId({ type: 'tool_use', name: 'Edit', id: 'tu_1' })).toBe('tu_1')
  })

  it('returns the id for Write / NotebookEdit / Bash blocks', () => {
    expect(mutatingToolUseId({ type: 'tool_use', name: 'Write', id: 'tu_2' })).toBe('tu_2')
    expect(mutatingToolUseId({ type: 'tool_use', name: 'NotebookEdit', id: 'tu_3' })).toBe('tu_3')
    expect(mutatingToolUseId({ type: 'tool_use', name: 'Bash', id: 'tu_4' })).toBe('tu_4')
  })

  it('detects first-party mutating tools by FQN (git-broadcast seam)', () => {
    // In-process MCP tool names arrive with the mcp__{server}__ prefix; the
    // registry's mutating FQNs are unioned into the detection set.
    expect(mutatingToolUseId({ type: 'tool_use', name: 'mcp__git-tools__git_stage', id: 'tu_g1' })).toBe('tu_g1')
    expect(mutatingToolUseId({ type: 'tool_use', name: 'mcp__git-tools__git_commit', id: 'tu_g2' })).toBe('tu_g2')
    expect(mutatingToolUseId({ type: 'tool_use', name: 'mcp__git-tools__git_discard', id: 'tu_g3' })).toBe('tu_g3')
  })

  it('does NOT treat read-only first-party tools as mutating', () => {
    expect(mutatingToolUseId({ type: 'tool_use', name: 'mcp__git-tools__git_status', id: 'tu_gr' })).toBeNull()
  })

  it('returns the id for EnterWorktree / ExitWorktree blocks (worktree-change seam)', () => {
    expect(mutatingToolUseId({ type: 'tool_use', name: 'EnterWorktree', id: 'tu_w1' })).toBe('tu_w1')
    expect(mutatingToolUseId({ type: 'tool_use', name: 'ExitWorktree', id: 'tu_w2' })).toBe('tu_w2')
  })

  it('returns null for non-mutating tools', () => {
    expect(mutatingToolUseId({ type: 'tool_use', name: 'Read', id: 'tu_5' })).toBeNull()
    expect(mutatingToolUseId({ type: 'tool_use', name: 'Glob', id: 'tu_6' })).toBeNull()
    expect(mutatingToolUseId({ type: 'tool_use', name: 'Agent', id: 'tu_7' })).toBeNull()
  })

  it('returns null for provably read-only Bash / PowerShell commands', () => {
    for (const name of ['Bash', 'PowerShell']) {
      expect(mutatingToolUseId({ type: 'tool_use', name, id: 'tu_r1', input: { command: 'git status' } })).toBeNull()
      expect(mutatingToolUseId({ type: 'tool_use', name, id: 'tu_r2', input: { command: 'ls' } })).toBeNull()
    }
  })

  it('still returns the id for mutating or unprovable shell commands', () => {
    expect(mutatingToolUseId({ type: 'tool_use', name: 'Bash', id: 'tu_m1', input: { command: 'rm x' } })).toBe('tu_m1')
    expect(mutatingToolUseId({ type: 'tool_use', name: 'Bash', id: 'tu_m2', input: { command: 'npm install' } })).toBe('tu_m2')
    expect(mutatingToolUseId({ type: 'tool_use', name: 'PowerShell', id: 'tu_m3', input: { command: 'Remove-Item x' } })).toBe('tu_m3')
    // Read-only verb but shell features → fail-closed, still broadcasts.
    expect(mutatingToolUseId({ type: 'tool_use', name: 'Bash', id: 'tu_m4', input: { command: 'ls > out.txt' } })).toBe('tu_m4')
    // No / malformed input → fail-closed.
    expect(mutatingToolUseId({ type: 'tool_use', name: 'Bash', id: 'tu_m5' })).toBe('tu_m5')
    expect(mutatingToolUseId({ type: 'tool_use', name: 'Bash', id: 'tu_m6', input: null })).toBe('tu_m6')
  })

  it('the read-only filter does not apply to non-shell tools', () => {
    expect(mutatingToolUseId({ type: 'tool_use', name: 'Edit', id: 'tu_e1', input: { command: 'ls' } })).toBe('tu_e1')
  })

  it('returns null for non-tool_use blocks', () => {
    expect(mutatingToolUseId({ type: 'text', text: 'hello' })).toBeNull()
    expect(mutatingToolUseId({ type: 'tool_result', content: 'ok' })).toBeNull()
  })

  it('returns null for malformed input', () => {
    expect(mutatingToolUseId(null)).toBeNull()
    expect(mutatingToolUseId(undefined)).toBeNull()
    expect(mutatingToolUseId('not an object')).toBeNull()
    expect(mutatingToolUseId({})).toBeNull()
    // Missing id — safer to skip than make one up.
    expect(mutatingToolUseId({ type: 'tool_use', name: 'Edit' })).toBeNull()
  })
})

// ── Debounce + broadcast wiring ──────────────────────────────────────

function makeStubBroadcaster(
  keys: Record<string, string> = {},
  peers: Record<string, string | null> = {},
): SessionBroadcaster & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    subscribeGlobal: () => { throw new Error('not used') },
    subscribe: () => { throw new Error('not used') },
    subscribePermissions: () => { throw new Error('not used') },
    subscribeContextUsage: () => null,
    subscribePromptSuggestion: () => null,
    subscribeGitStatus: () => null,
    subscribeMessageStatus: () => null,
    broadcastGitStatusChanged(id: string) {
      calls.push(id)
    },
    gitGroupKeyOf: (id: string) => keys[id] ?? id,
    gitGroupLivePeer: (id: string) => peers[id] ?? null,
  } as unknown as SessionBroadcaster & { calls: string[] }
}

describe('scheduleGitBroadcast', () => {
  // Debounce state is per manager, so each test's fresh stub starts clean —
  // no module-level reset hook needed.
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('caps the delay at GIT_BROADCAST_MAX_WAIT_MS under a continuous trigger stream', () => {
    const sm = makeStubBroadcaster()
    const firedAt: number[] = []
    const start = Date.now()
    const orig = sm.broadcastGitStatusChanged.bind(sm)
    sm.broadcastGitStatusChanged = (id: string) => {
      firedAt.push(Date.now() - start)
      orig(id)
    }
    // A schedule every 100 ms for 5 s — each one would reset a trailing-only
    // debounce, which would then never fire while the stream runs.
    for (let t = 0; t < 5000; t += 100) {
      scheduleGitBroadcast(sm, 'sess-1')
      vi.advanceTimersByTime(100)
    }
    expect(firedAt.length).toBeGreaterThanOrEqual(1)
    expect(firedAt[0]).toBeLessThanOrEqual(GIT_BROADCAST_MAX_WAIT_MS)
    // The stream (ending at 5000) is still running when the first fire lands.
    expect(firedAt[0]).toBeLessThan(5000)
    // After the stream stops, the trailing broadcast still lands.
    vi.advanceTimersByTime(1000)
    expect(firedAt.length).toBe(2)
  })

  it('debounce state is per manager: two managers never share a timer', () => {
    const a = makeStubBroadcaster({ 'sess-1': '/repo' })
    const b = makeStubBroadcaster({ 'sess-1': '/repo' })
    scheduleGitBroadcast(a, 'sess-1')
    vi.advanceTimersByTime(200)
    scheduleGitBroadcast(b, 'sess-1') // same key, other manager — must not reset a's timer
    vi.advanceTimersByTime(300)
    expect(a.calls).toEqual(['sess-1'])
    expect(b.calls).toEqual([])
    vi.advanceTimersByTime(200)
    expect(b.calls).toEqual(['sess-1'])
  })

  it('fires once after 500ms idle', () => {
    const sm = makeStubBroadcaster()
    scheduleGitBroadcast(sm, 'sess-1')
    expect(sm.calls).toEqual([])
    vi.advanceTimersByTime(499)
    expect(sm.calls).toEqual([])
    vi.advanceTimersByTime(1)
    expect(sm.calls).toEqual(['sess-1'])
  })

  it('coalesces a burst into a single broadcast', () => {
    const sm = makeStubBroadcaster()
    // 5 rapid schedules within the debounce window.
    scheduleGitBroadcast(sm, 'sess-1')
    vi.advanceTimersByTime(100)
    scheduleGitBroadcast(sm, 'sess-1')
    vi.advanceTimersByTime(100)
    scheduleGitBroadcast(sm, 'sess-1')
    vi.advanceTimersByTime(100)
    scheduleGitBroadcast(sm, 'sess-1')
    vi.advanceTimersByTime(100)
    scheduleGitBroadcast(sm, 'sess-1')
    expect(sm.calls).toEqual([])
    // The last reset was at t=400; the broadcast should now fire at t=900.
    vi.advanceTimersByTime(500)
    expect(sm.calls).toEqual(['sess-1'])
  })

  it('schedules independently per session', () => {
    const sm = makeStubBroadcaster()
    scheduleGitBroadcast(sm, 'sess-A')
    vi.advanceTimersByTime(200)
    scheduleGitBroadcast(sm, 'sess-B')
    vi.advanceTimersByTime(300)
    // sess-A's timer (started at t=0) should have fired by t=500.
    // sess-B's was started at t=200, so it fires at t=700.
    expect(sm.calls).toEqual(['sess-A'])
    vi.advanceTimersByTime(200)
    expect(sm.calls).toEqual(['sess-A', 'sess-B'])
  })

  it('cancelGitBroadcast prevents the pending fire', () => {
    const sm = makeStubBroadcaster()
    scheduleGitBroadcast(sm, 'sess-1')
    vi.advanceTimersByTime(200)
    cancelGitBroadcast(sm, 'sess-1')
    vi.advanceTimersByTime(1000)
    expect(sm.calls).toEqual([])
  })

  it('coalesces schedules from two sessions sharing a group key into one broadcast', () => {
    const sm = makeStubBroadcaster({ 'sess-A': '/repo', 'sess-B': '/repo' })
    scheduleGitBroadcast(sm, 'sess-A')
    vi.advanceTimersByTime(100)
    scheduleGitBroadcast(sm, 'sess-B') // same group: resets the same timer
    vi.advanceTimersByTime(500)
    // Only one fire; trigger origin is the last scheduler (sess-B)
    expect(sm.calls).toEqual(['sess-B'])
  })

  it('keeps separate timers for different group keys', () => {
    const sm = makeStubBroadcaster({ 'sess-A': '/repo-a', 'sess-B': '/repo-b' })
    scheduleGitBroadcast(sm, 'sess-A')
    vi.advanceTimersByTime(200)
    scheduleGitBroadcast(sm, 'sess-B')
    vi.advanceTimersByTime(300)
    expect(sm.calls).toEqual(['sess-A'])
    vi.advanceTimersByTime(200)
    expect(sm.calls).toEqual(['sess-A', 'sess-B'])
  })

  it('cancel with a live peer keeps the timer and re-points origin to the peer', () => {
    const sm = makeStubBroadcaster(
      { 'sess-A': '/repo', 'sess-B': '/repo' },
      { 'sess-A': 'sess-B' },
    )
    scheduleGitBroadcast(sm, 'sess-A')
    vi.advanceTimersByTime(200)
    cancelGitBroadcast(sm, 'sess-A') // A unloads; B still needs the refresh
    vi.advanceTimersByTime(500)
    expect(sm.calls).toEqual(['sess-B']) // timer alive, origin switched to B
  })

  it('cancel without peers clears the timer', () => {
    const sm = makeStubBroadcaster()
    scheduleGitBroadcast(sm, 'sess-1')
    vi.advanceTimersByTime(200)
    cancelGitBroadcast(sm, 'sess-1')
    vi.advanceTimersByTime(1000)
    expect(sm.calls).toEqual([])
  })

  it('cancel ignores timers whose origin is another session', () => {
    const sm = makeStubBroadcaster({ 'sess-A': '/repo', 'sess-B': '/repo' })
    scheduleGitBroadcast(sm, 'sess-A')
    vi.advanceTimersByTime(100)
    scheduleGitBroadcast(sm, 'sess-B') // origin is now B
    vi.advanceTimersByTime(100)
    cancelGitBroadcast(sm, 'sess-A') // A is not origin — must not kill B's timer
    vi.advanceTimersByTime(500)
    expect(sm.calls).toEqual(['sess-B'])
  })
})
