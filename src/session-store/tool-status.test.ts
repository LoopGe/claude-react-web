import { describe, it, expect } from 'vitest'
import { rebuildIndexesFromMessages, reduceSessionState } from './reducer'
import { createInitialSessionState } from './types'
import {
  extractToolUseId,
  getToolResultEntries,
  getToolResultOutcomes,
  getToolUseStarts,
} from './normalize'
import type { Block, SdkMessage } from '../types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assistant(blocks: Block[], uuid = 'a-1'): SdkMessage {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: blocks },
  } as unknown as SdkMessage
}

function user(blocks: Block[], uuid = 'u-1'): SdkMessage {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: blocks },
  } as unknown as SdkMessage
}

function toolUse(name: string, id: string, input: Record<string, unknown> = {}): Block {
  // The reducer reads the id off either field — we model the "id" form
  // here (raw SDK shape).  See extractToolUseId in normalize.ts.
  return { type: 'tool_use', id, name, input } as unknown as Block
}

function toolResult(toolUseId: string, opts: { isError?: boolean; content?: unknown } = {}): Block {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: opts.content ?? 'ok',
    ...(opts.isError ? { is_error: true } : {}),
  } as unknown as Block
}

// ---------------------------------------------------------------------------
// extractToolUseId
// ---------------------------------------------------------------------------

describe('extractToolUseId', () => {
  it('prefers tool_use_id over id (normalised shape wins)', () => {
    const block = { type: 'tool_use', tool_use_id: 'normalised', id: 'raw' } as unknown as Block
    expect(extractToolUseId(block)).toBe('normalised')
  })

  it('falls back to id when tool_use_id absent', () => {
    const block = { type: 'tool_use', id: 'raw-only' } as unknown as Block
    expect(extractToolUseId(block)).toBe('raw-only')
  })

  it('returns undefined when neither present', () => {
    const block = { type: 'tool_use' } as unknown as Block
    expect(extractToolUseId(block)).toBeUndefined()
  })

  it('returns undefined when the id field is non-string', () => {
    const block = { type: 'tool_use', id: 42 } as unknown as Block
    expect(extractToolUseId(block)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// getToolUseStarts — TOOL_STATUS_EXCLUDE filtering
// ---------------------------------------------------------------------------

describe('getToolUseStarts', () => {
  it('returns ids of generic tool_use blocks', () => {
    const msg = assistant([
      toolUse('Bash', 'tu_bash'),
      toolUse('Read', 'tu_read'),
    ])
    expect(getToolUseStarts(msg)).toEqual(['tu_bash', 'tu_read'])
  })

  it('excludes ExitPlanMode (PLAN_TOOL_NAMES) — PlanCard owns its status', () => {
    const msg = assistant([
      toolUse('ExitPlanMode', 'tu_plan'),
      toolUse('Bash', 'tu_bash'),
    ])
    // Only the non-excluded tool_use is reported.  If this fails because
    // a new bespoke-card tool was added but TOOL_STATUS_EXCLUDE wasn't
    // updated, the user will see BOTH a generic running badge AND the
    // bespoke status (e.g. plan "pending") on the same card.
    expect(getToolUseStarts(msg)).toEqual(['tu_bash'])
  })

  it('excludes EnterPlanMode (renders as inline marker, no status badge)', () => {
    const msg = assistant([
      toolUse('EnterPlanMode', 'tu_enter'),
      toolUse('Bash', 'tu_bash'),
    ])
    // EnterPlanMode is not in PLAN_TOOL_NAMES but is explicitly excluded so it
    // never gets a generic running badge next to its inline marker.
    expect(getToolUseStarts(msg)).toEqual(['tu_bash'])
  })

  it('excludes Agent / Task / Explore (SUBAGENT_TOOL_NAMES)', () => {
    const msg = assistant([
      toolUse('Agent', 'tu_agent'),
      toolUse('Task', 'tu_task'),
      toolUse('Explore', 'tu_explore'),
      toolUse('Grep', 'tu_grep'),
    ])
    expect(getToolUseStarts(msg)).toEqual(['tu_grep'])
  })

  it('excludes AskUserQuestion', () => {
    const msg = assistant([
      toolUse('AskUserQuestion', 'tu_q'),
      toolUse('WebSearch', 'tu_ws'),
    ])
    expect(getToolUseStarts(msg)).toEqual(['tu_ws'])
  })

  it('returns empty for non-assistant messages', () => {
    const msg = user([toolResult('tu_bash')])
    expect(getToolUseStarts(msg)).toEqual([])
  })

  it('skips tool_use blocks missing both id fields', () => {
    const block = { type: 'tool_use', name: 'Bash' } as unknown as Block
    const msg = assistant([block, toolUse('Read', 'tu_read')])
    expect(getToolUseStarts(msg)).toEqual(['tu_read'])
  })
})

// ---------------------------------------------------------------------------
// getToolResultOutcomes — is_error → 'error', otherwise 'success'
// ---------------------------------------------------------------------------

describe('getToolResultOutcomes', () => {
  it('reports success when is_error is absent', () => {
    const msg = user([toolResult('tu_bash')])
    expect(getToolResultOutcomes(msg)).toEqual([
      { toolUseId: 'tu_bash', outcome: 'success' },
    ])
  })

  it('reports error when is_error is true', () => {
    const msg = user([toolResult('tu_bash', { isError: true, content: 'permission denied' })])
    expect(getToolResultOutcomes(msg)).toEqual([
      { toolUseId: 'tu_bash', outcome: 'error' },
    ])
  })

  it('reports each tool_result independently', () => {
    const msg = user([
      toolResult('tu_a'),
      toolResult('tu_b', { isError: true }),
      toolResult('tu_c'),
    ])
    expect(getToolResultOutcomes(msg)).toEqual([
      { toolUseId: 'tu_a', outcome: 'success' },
      { toolUseId: 'tu_b', outcome: 'error' },
      { toolUseId: 'tu_c', outcome: 'success' },
    ])
  })

  it('ignores non-string tool_use_id (defensive — bad SDK shape)', () => {
    const block = { type: 'tool_result', tool_use_id: 123, content: 'ok' } as unknown as Block
    const msg = user([block])
    expect(getToolResultOutcomes(msg)).toEqual([])
  })

  it('returns empty for non-user messages', () => {
    const msg = assistant([toolUse('Bash', 'tu_bash')])
    expect(getToolResultOutcomes(msg)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// getToolResultEntries — carries content + is_error through
// ---------------------------------------------------------------------------

describe('getToolResultEntries', () => {
  it('carries content and isError for each tool_result', () => {
    const msg = user([
      toolResult('tu_a', { content: 'hello' }),
      toolResult('tu_b', { isError: true, content: 'boom' }),
    ])
    expect(getToolResultEntries(msg)).toEqual([
      { toolUseId: 'tu_a', content: 'hello', isError: false },
      { toolUseId: 'tu_b', content: 'boom', isError: true },
    ])
  })

  it('preserves array (block) content shape', () => {
    const content = [{ type: 'text', text: 'line' }]
    const msg = user([toolResult('tu_a', { content })])
    expect(getToolResultEntries(msg)).toEqual([
      { toolUseId: 'tu_a', content, isError: false },
    ])
  })

  it('ignores non-string tool_use_id and non-user messages', () => {
    const bad = { type: 'tool_result', tool_use_id: 123, content: 'ok' } as unknown as Block
    expect(getToolResultEntries(user([bad]))).toEqual([])
    expect(getToolResultEntries(assistant([toolUse('Bash', 'tu_bash')]))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Reducer integration — toolResults map lifecycle
// ---------------------------------------------------------------------------

describe('reducer: toolResults lifecycle', () => {
  it('captures the result payload for a seeded generic tool', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: assistant([toolUse('Bash', 'tu_bash')]),
    })
    // No result yet.
    expect(state.toolResults.has('tu_bash')).toBe(false)

    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: user([toolResult('tu_bash', { content: 'stdout here' })], 'r-1'),
    })
    expect(state.toolResults.get('tu_bash')).toEqual({ content: 'stdout here', isError: false })
  })

  it('marks isError true when the result fails', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: assistant([toolUse('Read', 'tu_read')]),
    })
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: user([toolResult('tu_read', { isError: true, content: 'ENOENT' })], 'r-2'),
    })
    expect(state.toolResults.get('tu_read')).toEqual({ content: 'ENOENT', isError: true })
  })

  it('does NOT capture results for excluded tools (Plan/Subagent/Question)', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: assistant([
        toolUse('ExitPlanMode', 'tu_plan'),
        toolUse('Agent', 'tu_agent'),
        toolUse('AskUserQuestion', 'tu_q'),
        toolUse('Bash', 'tu_bash'),
      ]),
    })
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: user([
        toolResult('tu_plan', { content: 'plan body' }),
        toolResult('tu_agent', { content: 'agent output' }),
        toolResult('tu_q', { content: 'answers' }),
        toolResult('tu_bash', { content: 'ok' }),
      ], 'r-1'),
    })
    // Only the generic Bash tool's result is captured — the bespoke-card
    // tools own their own result rendering.
    expect(state.toolResults.has('tu_plan')).toBe(false)
    expect(state.toolResults.has('tu_agent')).toBe(false)
    expect(state.toolResults.has('tu_q')).toBe(false)
    expect(state.toolResults.get('tu_bash')).toEqual({ content: 'ok', isError: false })
  })

  it('ignores an orphan result whose tool_use was never seeded', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: assistant([toolUse('Bash', 'tu_bash')]),
    })
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: user([toolResult('tu_unknown', { content: 'orphan' })], 'r-x'),
    })
    // Not stored — the UI renders it as a standalone orphan bubble instead.
    expect(state.toolResults.has('tu_unknown')).toBe(false)
  })

  it('rebuilds toolResults from cached messages on hydration', () => {
    const cachedMessages = [
      assistant([toolUse('Bash', 'tu_bash'), toolUse('Read', 'tu_read')], 'a-1'),
      user([toolResult('tu_bash', { content: 'done' })], 'r-1'),
      user([toolResult('tu_read', { isError: true, content: 'ENOENT' })], 'r-2'),
      assistant([toolUse('Grep', 'tu_grep')], 'a-2'),
      // No tool_result for tu_grep yet.
    ]
    const seeded = createInitialSessionState('s1')
    const state = rebuildIndexesFromMessages(seeded, cachedMessages)
    expect(state.toolResults.get('tu_bash')).toEqual({ content: 'done', isError: false })
    expect(state.toolResults.get('tu_read')).toEqual({ content: 'ENOENT', isError: true })
    expect(state.toolResults.has('tu_grep')).toBe(false)
  })

  it('keeps toolResults identity-stable when nothing matches', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: assistant([toolUse('Bash', 'tu_bash')]),
    })
    const before = state.toolResults
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: user([toolResult('tu_unknown', { content: 'orphan' })], 'r-x'),
    })
    expect(state.toolResults).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// Reducer integration — toolStatus map lifecycle
// ---------------------------------------------------------------------------

describe('reducer: toolStatus lifecycle', () => {
  it('seeds running on tool_use, flips to success on tool_result', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: assistant([toolUse('Bash', 'tu_bash')]),
    })
    expect(state.toolStatus.get('tu_bash')).toBe('running')

    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: user([toolResult('tu_bash')], 'r-1'),
    })
    expect(state.toolStatus.get('tu_bash')).toBe('success')
  })

  it('flips to error when the result carries is_error: true', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: assistant([toolUse('Read', 'tu_read')]),
    })
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: user([toolResult('tu_read', { isError: true, content: 'ENOENT' })], 'r-2'),
    })
    expect(state.toolStatus.get('tu_read')).toBe('error')
  })

  it('does NOT seed status for excluded tool names (Plan/Subagent/Question)', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: assistant([
        toolUse('ExitPlanMode', 'tu_plan'),
        toolUse('Agent', 'tu_agent'),
        toolUse('AskUserQuestion', 'tu_q'),
        toolUse('Bash', 'tu_bash'),
      ]),
    })
    expect(state.toolStatus.has('tu_plan')).toBe(false)
    expect(state.toolStatus.has('tu_agent')).toBe(false)
    expect(state.toolStatus.has('tu_q')).toBe(false)
    expect(state.toolStatus.get('tu_bash')).toBe('running')
  })

  it('preserves the existing status when a duplicate tool_use lands during replay', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: assistant([toolUse('Bash', 'tu_bash')]),
    })
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: user([toolResult('tu_bash')], 'r-1'),
    })
    expect(state.toolStatus.get('tu_bash')).toBe('success')

    // A duplicate tool_use (same id) lands — could happen during replay
    // or if upstream re-broadcasts. The terminal status must NOT regress
    // back to 'running'.
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: assistant([toolUse('Bash', 'tu_bash')], 'a-2'),
    })
    expect(state.toolStatus.get('tu_bash')).toBe('success')
  })

  it('rebuilds toolStatus from cached messages on hydration', () => {
    // Regression: when the SessionStore restored items+messages from
    // localStorage, only those two fields were re-populated — toolStatus
    // (and the other index maps) started empty. useToolStatus then
    // returned the default 'running' for every cached tool_use card,
    // so older Read/Grep/Bash cards spun forever after a page reload
    // even though the conversation had moved on.
    //
    // The fix is the rebuildIndexesFromMessages() helper, called from
    // SessionStore's constructor after loadFromStorage. This test
    // exercises the helper directly.
    const cachedMessages = [
      assistant([toolUse('Bash', 'tu_bash'), toolUse('Read', 'tu_read')], 'a-1'),
      user([toolResult('tu_bash')], 'r-1'),
      user([toolResult('tu_read', { isError: true, content: 'ENOENT' })], 'r-2'),
      assistant([toolUse('Grep', 'tu_grep')], 'a-2'),
      // No tool_result for tu_grep yet — it really is still running.
    ]
    const seeded = createInitialSessionState('s1')
    const state = rebuildIndexesFromMessages(seeded, cachedMessages)
    expect(state.toolStatus.get('tu_bash')).toBe('success')
    expect(state.toolStatus.get('tu_read')).toBe('error')
    expect(state.toolStatus.get('tu_grep')).toBe('running')
  })

  it('reconciles a lingering running tool to error when the turn ends', () => {
    // The bug: a tool_use seeds 'running', but its tool_result never
    // arrives (user interrupted, or the SDK aborted the turn). The
    // `result` frame means the turn is over, so the result will never
    // come — without a sweep the badge spins on 'running' forever.
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: assistant([toolUse('Bash', 'tu_bash')]),
    })
    expect(state.toolStatus.get('tu_bash')).toBe('running')

    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: { type: 'result', uuid: 'res-1' } as unknown as SdkMessage,
    })
    expect(state.toolStatus.get('tu_bash')).toBe('error')
  })

  it('leaves terminal tool statuses untouched at turn end', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: assistant([toolUse('Bash', 'tu_bash'), toolUse('Read', 'tu_read')]),
    })
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: user([toolResult('tu_bash')], 'r-1'),
    })
    // tu_read still running; tu_bash already success.
    const before = state.toolStatus
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: { type: 'result', uuid: 'res-1' } as unknown as SdkMessage,
    })
    expect(state.toolStatus.get('tu_bash')).toBe('success')
    expect(state.toolStatus.get('tu_read')).toBe('error')
    // A fresh Map was allocated (a running entry was swept).
    expect(state.toolStatus).not.toBe(before)
  })

  it('keeps toolStatus identity-stable on result when nothing is running', () => {
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: assistant([toolUse('Bash', 'tu_bash')]),
    })
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: user([toolResult('tu_bash')], 'r-1'),
    })
    const before = state.toolStatus
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: { type: 'result', uuid: 'res-1' } as unknown as SdkMessage,
    })
    // No running entry to sweep → Map reference preserved (no spurious
    // re-render cascade off snapshot identity).
    expect(state.toolStatus).toBe(before)
  })

  it('returns the same state when the result toolUseId is unknown', () => {
    // Defensive: a tool_result for an id we never seeded should not
    // create a stale entry — that would fool the UI into showing a
    // status badge for a tool the user never saw start.
    let state = createInitialSessionState('s1')
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: assistant([toolUse('Bash', 'tu_bash')]),
    })
    const before = state
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: user([toolResult('tu_unknown')], 'r-x'),
    })
    expect(state.toolStatus.has('tu_unknown')).toBe(false)
    expect(state.toolStatus.get('tu_bash')).toBe('running')
    // Object identity preserved — no spurious clone.  This matters
    // because re-renders cascade off snapshot identity.
    expect(state.toolStatus).toBe(before.toolStatus)
  })
})
