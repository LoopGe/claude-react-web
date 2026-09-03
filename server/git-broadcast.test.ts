import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mutatingToolUseId,
  scheduleGitBroadcast,
  cancelGitBroadcast,
  _resetGitBroadcastForTests,
} from './git-broadcast.js'
import type { SessionBroadcaster } from './session-types.js'

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
    expect(mutatingToolUseId({ type: 'tool_use', name: 'mcp__apptools__git_stage', id: 'tu_g1' })).toBe('tu_g1')
    expect(mutatingToolUseId({ type: 'tool_use', name: 'mcp__apptools__git_commit', id: 'tu_g2' })).toBe('tu_g2')
    expect(mutatingToolUseId({ type: 'tool_use', name: 'mcp__apptools__git_discard', id: 'tu_g3' })).toBe('tu_g3')
  })

  it('does NOT treat read-only first-party tools as mutating', () => {
    expect(mutatingToolUseId({ type: 'tool_use', name: 'mcp__apptools__git_status', id: 'tu_gr' })).toBeNull()
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

function makeStubBroadcaster(): SessionBroadcaster & { calls: string[] } {
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
  } as unknown as SessionBroadcaster & { calls: string[] }
}

describe('scheduleGitBroadcast', () => {
  beforeEach(() => {
    _resetGitBroadcastForTests()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    _resetGitBroadcastForTests()
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
    cancelGitBroadcast('sess-1')
    vi.advanceTimersByTime(1000)
    expect(sm.calls).toEqual([])
  })
})
