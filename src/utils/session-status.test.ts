import { describe, it, expect } from 'vitest'
import { statusClass, statusLabel } from './session-status'
import type { SessionInfo } from '../types'

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'abc12345-xxxx',
    running: true,
    working: false,
    terminated: false,
    error: null,
    phase: 'idle',
    ...overrides,
  } as SessionInfo
}

describe('statusClass', () => {
  it('returns "waiting" when the parent turn is done but a background subagent is in flight', () => {
    expect(statusClass(makeSession({ running: true, working: false, backgroundSubagentCount: 1 }))).toBe('waiting')
  })

  it('returns "live" when running, not working, and no background subagents', () => {
    expect(statusClass(makeSession({ running: true, working: false, backgroundSubagentCount: 0 }))).toBe('live')
    expect(statusClass(makeSession({ running: true, working: false }))).toBe('live')
  })

  it('still prefers "working" over "waiting" while the parent turn is active', () => {
    expect(statusClass(makeSession({ running: true, working: true, backgroundSubagentCount: 1 }))).toBe('working')
  })

  it('prefers "waiting" over "err" while a background subagent is in flight', () => {
    // Precedence must match the sidebar chip (SessionCard): working > waiting
    // > err. A running session with background work is "waiting" even if it
    // also carries an error — the error text still surfaces in the card body.
    expect(statusClass(makeSession({ running: true, working: false, error: 'boom', backgroundSubagentCount: 1 }))).toBe('waiting')
  })

  it('returns "dormant" for a session that is not running', () => {
    expect(statusClass(makeSession({ running: false, backgroundSubagentCount: 1 }))).toBe('dormant')
  })
})

describe('statusLabel', () => {
  it('labels a single background subagent in the singular', () => {
    expect(statusLabel(makeSession({ running: true, working: false, backgroundSubagentCount: 1 }))).toBe(
      'Waiting for a background subagent',
    )
  })

  it('labels multiple background subagents with a count', () => {
    expect(statusLabel(makeSession({ running: true, working: false, backgroundSubagentCount: 3 }))).toBe(
      'Waiting for 3 background subagents',
    )
  })

  it('still reports "Live" when running with no background subagents', () => {
    expect(statusLabel(makeSession({ running: true, working: false }))).toBe('Live')
  })

  it('still reports "Working on a turn" while the parent turn is active', () => {
    expect(statusLabel(makeSession({ running: true, working: true, backgroundSubagentCount: 2 }))).toBe(
      'Working on a turn',
    )
  })

  it('labels the waiting state over the error text while a background subagent is in flight', () => {
    // Mirrors statusClass precedence: waiting beats err. The error detail is
    // still visible via the card body / the badge title.
    expect(statusLabel(makeSession({ running: true, working: false, error: 'boom', backgroundSubagentCount: 1 }))).toBe(
      'Waiting for a background subagent',
    )
  })
})
