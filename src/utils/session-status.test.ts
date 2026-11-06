import { describe, it, expect } from 'vitest'
import { isWaiting, sessionHoverModel, statusClass, statusLabel, tabDotStatus } from './session-status'
import type { SessionInfo } from '../types'

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'abc12345-xxxx',
    running: true,
    working: false,
    terminated: false,
    error: null,
    phase: 'idle',
    model: 'test-model',
    messageCount: 3,
    subscribers: 0,
    ...overrides,
  } as SessionInfo
}

describe('isWaiting', () => {
  it('is true when the parent turn is done but a background subagent is in flight', () => {
    expect(isWaiting(makeSession({ running: true, working: false, backgroundSubagentCount: 1 }))).toBe(true)
  })

  it('is false while the parent turn is active, even with subagents in flight', () => {
    expect(isWaiting(makeSession({ running: true, working: true, backgroundSubagentCount: 2 }))).toBe(false)
  })

  it('is false when there are no background subagents', () => {
    expect(isWaiting(makeSession({ running: true, working: false }))).toBe(false)
    expect(isWaiting(makeSession({ running: true, working: false, backgroundSubagentCount: 0 }))).toBe(false)
  })

  it('is false when the session is not running', () => {
    expect(isWaiting(makeSession({ running: false, working: false, backgroundSubagentCount: 1 }))).toBe(false)
  })
})

describe('statusClass', () => {
  it('returns "waiting" when the parent turn is done but a background subagent is in flight', () => {
    expect(statusClass(makeSession({ running: true, working: false, backgroundSubagentCount: 1 }))).toBe(
      'waiting',
    )
  })

  it('returns "live" when running, not working, and no background subagents', () => {
    expect(statusClass(makeSession({ running: true, working: false, backgroundSubagentCount: 0 }))).toBe(
      'live',
    )
    expect(statusClass(makeSession({ running: true, working: false }))).toBe('live')
  })

  it('still prefers "working" over "waiting" while the parent turn is active', () => {
    expect(statusClass(makeSession({ running: true, working: true, backgroundSubagentCount: 1 }))).toBe(
      'working',
    )
  })

  it('prefers "waiting" over "err" while a background subagent is in flight', () => {
    // Precedence must match the sidebar chip (SessionCard): working > waiting
    // > err. A running session with background work is "waiting" even if it
    // also carries an error — the error text still surfaces in the card body.
    expect(
      statusClass(makeSession({ running: true, working: false, error: 'boom', backgroundSubagentCount: 1 })),
    ).toBe('waiting')
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
    expect(
      statusLabel(makeSession({ running: true, working: false, error: 'boom', backgroundSubagentCount: 1 })),
    ).toBe('Waiting for a background subagent')
  })
})

describe('tabDotStatus', () => {
  it('returns the exceptional states under their CSS dot class names', () => {
    expect(tabDotStatus(makeSession({ running: false }))).toBe('dormant')
    expect(tabDotStatus(makeSession({ running: true, working: false, backgroundSubagentCount: 1 }))).toBe(
      'waiting',
    )
    expect(tabDotStatus(makeSession({ running: true, error: 'boom' }))).toBe('err')
  })

  it("maps statusClass's 'terminated' to the CSS vocabulary's 'ended'", () => {
    // The sidebar's dot CSS is .status-ended, not .status-terminated — the
    // tabs reuse that palette, so the name must cross over here.
    expect(tabDotStatus(makeSession({ terminated: true, terminatedReason: 'process_killed' }))).toBe('ended')
  })

  it("returns 'working' for an active turn AND a crash recovery", () => {
    // The fold must be total: a recovering session has working=false, so a
    // fold that dropped 'working' would render the tab unmarked while the
    // sidebar card pulses (statusClass folds recovering into 'working').
    expect(tabDotStatus(makeSession({ working: true }))).toBe('working')
    expect(tabDotStatus(makeSession({ recovering: true }))).toBe('working')
  })

  it('returns null only for a plain live session', () => {
    expect(tabDotStatus(makeSession({}))).toBeNull()
  })
})

describe('sessionHoverModel', () => {
  it('separates status, error, path and counters', () => {
    expect(
      sessionHoverModel(makeSession({ cwd: '/home/user/project', subscribers: 1 })),
    ).toEqual({
      status: 'Live',
      error: null,
      cwd: '/home/user/project',
      meta: 'test-model · 3 msgs · 1 viewer',
    })
  })

  it('keeps an error that a higher-precedence status outranks', () => {
    expect(
      sessionHoverModel(makeSession({ backgroundSubagentCount: 1, error: 'boom' })),
    ).toEqual({
      status: 'Waiting for a background subagent',
      error: 'boom',
      cwd: null,
      meta: 'test-model · 3 msgs',
    })
  })

  it('returns a null cwd when the session has none', () => {
    expect(sessionHoverModel(makeSession()).cwd).toBeNull()
  })

  it('uses the caller status text when supplied', () => {
    expect(sessionHoverModel(makeSession({ running: false }), 'Resuming…').status).toBe('Resuming…')
  })
})
