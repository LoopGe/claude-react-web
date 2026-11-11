// Sidechain index — the Subagent / Workflow / Skill fold pipeline plus the
// TASKS_SNAPSHOT enrichment, DISMISS_SUBAGENT flip, and reapplyDismissed
// re-application after mirror rebuilds.
//
// The tests below cover the behaviors the brief names:
//   - Subagent / Workflow / Skill seed → result → child folds
//   - launch-ack skipping (async agent ack does NOT settle the record)
//   - TASKS_SNAPSHOT is the sole isAsync authority (writes for both live and
//     terminal records, both directions)
//   - child-result flips without a live-status guard (a settled parent's
//     child can still resolve to its real outcome)
//   - two dismissal regressions: replay/reset cannot revive a dismissed
//     record, and trim→page-back cannot turn dismissed back into running.

import { describe, it, expect } from 'vitest'
import {
  updateSidechainIndexMirror,
  applyTasksSnapshot,
  dismissSubagent,
  reapplyDismissed,
  hasTranscriptBackground,
} from './sidechain-index'
import { reduceSessionState, rebuildIndexesFromMessages } from './reducer'
import {
  createInitialServerMirror,
  createInitialSessionState,
  type ServerMirror,
  type SessionState,
} from './types'
import type { SdkMessage, TaskRecordUi } from '../types'

// ── Message builders ────────────────────────────────────────────────────────
// Mirror the shapes reducer.test.ts / skill-index.test.ts use. Each builder
// stamps `receivedAt` so the fold's wall-clock stamp path is exercised.

function assistant(
  blocks: unknown[],
  uuid: string,
  parentToolUseId: string | null = null,
  receivedAt = 1_000,
): SdkMessage {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: parentToolUseId,
    receivedAt,
    message: { role: 'assistant', content: blocks },
  } as unknown as SdkMessage
}

function user(
  blocks: unknown[],
  uuid: string,
  parentToolUseId: string | null = null,
  receivedAt = 2_000,
): SdkMessage {
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: parentToolUseId,
    receivedAt,
    message: { role: 'user', content: blocks },
  } as unknown as SdkMessage
}

function toolUse(name: string, id: string, input: Record<string, unknown> = {}): unknown {
  return { type: 'tool_use', id, name, input }
}

function toolResult(toolUseId: string, opts: { isError?: boolean; content?: unknown } = {}): unknown {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: opts.content ?? 'ok',
    ...(opts.isError ? { is_error: true } : {}),
  }
}

/** Apply a sequence of MESSAGE actions through the full reducer (integration
 *  path). Used by the dismissal regression tests that need the whole pipeline
 *  (trim / replay / page-back) to run. */
function apply(state: SessionState, ...messages: SdkMessage[]): SessionState {
  return messages.reduce(
    (acc, message) => reduceSessionState(acc, { type: 'MESSAGE', message }),
    state,
  )
}

const fresh = (): ServerMirror => createInitialServerMirror()
const freshState = (): SessionState => createInitialSessionState('s1')

// ---------------------------------------------------------------------------
// Subagent seed / result / child folds
// ---------------------------------------------------------------------------

describe('updateSidechainIndexMirror: Subagent seed/result/child folds', () => {
  const agentStart = (id: string, opts: { description?: string; prompt?: string } = {}) =>
    assistant([toolUse('Agent', id, {
      description: opts.description ?? 'do work',
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
    })], 'a-sub')

  it('seeds a running record from the Agent tool_use with startedAt from receivedAt', () => {
    const m = updateSidechainIndexMirror(fresh(), agentStart('tu_a'))
    const rec = m.activeSubagents.get('tu_a')
    expect(rec).toMatchObject({
      toolUseId: 'tu_a',
      label: 'do work',
      status: 'running',
      toolCount: 0,
      startedAt: 1_000,
    })
    expect(rec?.childToolCalls).toEqual([])
  })

  it('flips to done when the Agent tool_result lands on the main thread', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m = updateSidechainIndexMirror(m, user([toolResult('tu_a', { content: 'worker output' })], 'u-res'))
    const rec = m.activeSubagents.get('tu_a')
    expect(rec?.status).toBe('done')
    expect(rec?.endedAt).toBe(2_000)
    expect(rec?.result).toEqual({ content: 'worker output', isError: false })
  })

  it('flips to interrupted on an errored result', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m = updateSidechainIndexMirror(m, user([toolResult('tu_a', { isError: true, content: 'boom' })], 'u-res'))
    expect(m.activeSubagents.get('tu_a')?.status).toBe('interrupted')
  })

  it('preserves a canonical mixed main-thread result alongside matching streamed text', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m = updateSidechainIndexMirror(m, assistant([{ type: 'text', text: 'captured image' }], 'c-image', 'tu_a', 4_000))
    const content = [
      { type: 'text', text: 'captured image' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
    ]
    m = updateSidechainIndexMirror(m, user([toolResult('tu_a', { content })], 'u-main', null, 9_000))
    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      result: { content, isError: false },
      resultOrigin: 'tool_result',
    })
  })

  it('does not let an older main-thread result overwrite a newer completion', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a', label: 'do work', status: 'done', isAsync: true, toolCount: 0, childToolCalls: [],
      endedAt: 9_000, result: { content: 'final answer', isError: false }, resultOrigin: 'notification',
    })
    const after = updateSidechainIndexMirror(m, user([toolResult('tu_a', { content: 'older output' })], 'u-old', null, 5_000))
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      status: 'done',
      endedAt: 9_000,
      result: { content: 'final answer', isError: false },
      resultOrigin: 'notification',
    })
  })

  it('ignores an older main-thread result after a resultless completion', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a', label: 'do work', status: 'done', isAsync: true, toolCount: 0, childToolCalls: [],
      endedAt: 9_000, resultOrigin: 'async_metadata',
    })
    const after = updateSidechainIndexMirror(m, user([toolResult('tu_a', { content: 'older output' })], 'u-old', null, 5_000))
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      status: 'done',
      endedAt: 9_000,
      resultOrigin: 'async_metadata',
    })
    expect(after.activeSubagents.get('tu_a')?.result).toBeUndefined()
  })

  it('preserves startedAt and isAsync across a replay re-encounter (no clobber)', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    // Simulate a settled record from a prior pass (e.g. replay re-delivery).
    const settled = new Map(m.activeSubagents)
    settled.set('tu_a', {
      ...settled.get('tu_a')!,
      status: 'done',
      startedAt: 999,
      endedAt: 1_999,
      isAsync: true,
      result: { content: [{ type: 'text', text: 'streamed output' }], isError: false },
      resultOrigin: 'streamed',
      childToolCalls: [{ toolUseId: 'child-1', toolName: 'Read', argSummary: 'a.ts', status: 'success' }],
      taskId: 't-1',
      progressSummary: 'Checking output',
      lastToolName: 'Read',
    })
    m = { ...m, activeSubagents: settled }
    // Re-encounter the same tool_use: identity fields refresh but lifecycle
    // fields (startedAt / endedAt / status / isAsync) are preserved.
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    const rec = m.activeSubagents.get('tu_a')
    expect(rec?.status).toBe('done')
    expect(rec?.startedAt).toBe(999)
    expect(rec?.endedAt).toBe(1_999)
    expect(rec?.isAsync).toBe(true)
    expect(rec?.result).toEqual({ content: [{ type: 'text', text: 'streamed output' }], isError: false })
    expect(rec?.resultOrigin).toBe('streamed')
    expect(rec?.childToolCalls).toEqual([{ toolUseId: 'child-1', toolName: 'Read', argSummary: 'a.ts', status: 'success' }])
    expect(rec?.taskId).toBe('t-1')
    expect(rec?.progressSummary).toBe('Checking output')
    expect(rec?.lastToolName).toBe('Read')
  })

  it('indexes child tool calls from sidechain assistant frames and flips them on their result', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    // Child tool_use inside the subagent's sidechain.
    m = updateSidechainIndexMirror(m, assistant([toolUse('Bash', 'tu_child', { command: 'ls' })], 'a-child', 'tu_a'))
    const rec = m.activeSubagents.get('tu_a')
    expect(rec?.childToolCalls).toHaveLength(1)
    expect(rec?.childToolCalls?.[0]).toMatchObject({ toolUseId: 'tu_child', toolName: 'Bash', status: 'running' })
    expect(rec?.toolCount).toBe(1)
    // Child result flips the row to success and captures the payload.
    m = updateSidechainIndexMirror(m, user([toolResult('tu_child', { content: 'file.txt' })], 'u-child', 'tu_a'))
    const after = m.activeSubagents.get('tu_a')!
    expect(after.childToolCalls?.[0]?.status).toBe('success')
    expect(after.childToolCalls?.[0]?.result).toEqual({ content: 'file.txt', isError: false })

    const replayed = updateSidechainIndexMirror(m, assistant([toolUse('Bash', 'tu_child', { command: 'ls' })], 'a-child', 'tu_a'))
    expect(replayed.activeSubagents.get('tu_a')?.toolCount).toBe(1)
    expect(replayed.activeSubagents.get('tu_a')?.childToolCalls).toHaveLength(1)
  })

  it('tracks streamed result provenance and clears it for a main-thread result', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m = updateSidechainIndexMirror(m, assistant([{ type: 'text', text: 'streamed reply' }], 'a-reply', 'tu_a'))
    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      result: { content: [{ type: 'text', text: 'streamed reply' }], isError: false },
      resultOrigin: 'streamed',
    })

    m = updateSidechainIndexMirror(m, user([toolResult('tu_a', { content: 'main result' })], 'u-main'))
    expect(m.activeSubagents.get('tu_a')?.resultOrigin).toBe('tool_result')
  })

  it('preserves streamed output and provenance when a summary-only notification follows a terminal snapshot', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a',
      label: 'do work',
      status: 'done',
      isAsync: true,
      toolCount: 0,
      childToolCalls: [],
      result: { content: [{ type: 'text', text: 'real output' }], isError: false },
      resultOrigin: 'streamed',
    })
    const after = updateSidechainIndexMirror(m, {
      type: 'system',
      subtype: 'task_notification',
      uuid: 'n-1',
      task_id: 't-1',
      tool_use_id: 'tu_a',
      status: 'completed',
      summary: 'all done',
      receivedAt: 9_000,
    } as unknown as SdkMessage)

    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      status: 'done',
      resultOrigin: 'streamed',
      result: { content: [{ type: 'text', text: 'real output' }], isError: false },
    })
  })

  it('lets a matching late streamed source supersede a notification result instead of duplicating it', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a',
      label: 'do work',
      status: 'done',
      isAsync: true,
      toolCount: 0,
      childToolCalls: [],
      result: { content: 'notification output', isError: false },
      resultOrigin: 'notification',
    })
    const after = updateSidechainIndexMirror(m, assistant([{ type: 'text', text: 'notification output' }], 'c-late', 'tu_a'))

    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      result: { content: [{ type: 'text', text: 'notification output' }], isError: false },
      resultOrigin: 'streamed',
    })
  })

  it('lets streamed output supersede a detach-ack result before notification', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a',
      label: 'do work',
      status: 'done',
      isAsync: true,
      toolCount: 0,
      childToolCalls: [],
      result: { content: 'detached', isError: false },
      resultOrigin: 'async_metadata',
    })
    const after = updateSidechainIndexMirror(m, assistant([{ type: 'text', text: 'streamed output' }], 'c-late', 'tu_a'))
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      result: { content: [{ type: 'text', text: 'streamed output' }], isError: false },
      resultOrigin: 'streamed',
    })
  })

  it('does not replace a full notification result with a later summary-only notification', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a',
      label: 'do work',
      status: 'done',
      isAsync: true,
      toolCount: 0,
      childToolCalls: [],
      result: { content: 'the full final report', isError: false },
      resultOrigin: 'notification',
    })
    const after = updateSidechainIndexMirror(m, {
      type: 'system', subtype: 'task_notification', uuid: 'n-summary', task_id: 't-1', tool_use_id: 'tu_a',
      status: 'completed', summary: 'all done', receivedAt: 9_000,
    } as unknown as SdkMessage)
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      result: { content: 'the full final report', isError: false },
      resultOrigin: 'notification',
    })
  })

  it('does not erase a notification result for an empty late text block', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a',
      label: 'do work',
      status: 'done',
      isAsync: true,
      toolCount: 0,
      childToolCalls: [],
      result: { content: 'notification output', isError: false },
      resultOrigin: 'notification',
    })
    const after = updateSidechainIndexMirror(m, assistant([{ type: 'text', text: '' }], 'c-empty', 'tu_a'))
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      result: { content: 'notification output', isError: false },
      resultOrigin: 'notification',
    })
  })

  it('does not let older sidechain text supersede a newer notification result', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a',
      label: 'do work',
      status: 'done',
      isAsync: true,
      toolCount: 0,
      childToolCalls: [],
      endedAt: 9_000,
      result: { content: 'notification output', isError: false },
      resultOrigin: 'notification',
    })
    const after = updateSidechainIndexMirror(m, assistant([{ type: 'text', text: 'older progress' }], 'c-old', 'tu_a', 5_000))
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      result: { content: 'notification output', isError: false },
      resultOrigin: 'notification',
    })
  })

  it('accepts an identical streamed source even when replay delivers it after the notification', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a',
      label: 'do work',
      status: 'done',
      isAsync: true,
      toolCount: 0,
      childToolCalls: [],
      endedAt: 9_000,
      result: { content: 'same output', isError: false },
      resultOrigin: 'summary',
    })
    const after = updateSidechainIndexMirror(m, assistant([{ type: 'text', text: 'same output' }], 'c-same', 'tu_a', 5_000))
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      result: { content: [{ type: 'text', text: 'same output' }], isError: false },
      resultOrigin: 'streamed',
    })
  })

  it('lets a full notification replace earlier streamed progress', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m.activeSubagents.set('tu_a', {
      ...m.activeSubagents.get('tu_a')!,
      status: 'background',
      isAsync: true,
    })
    m = updateSidechainIndexMirror(m, assistant([{ type: 'text', text: 'Working on it' }], 'c-progress', 'tu_a', 4_000))
    m = updateSidechainIndexMirror(m, {
      type: 'user', uuid: 'n-final', parent_tool_use_id: null, receivedAt: 9_000,
      message: { role: 'user', content: '<task-notification><task-id>t-1</task-id><tool-use-id>tu_a</tool-use-id><status>completed</status><result>final answer</result></task-notification>' },
    } as unknown as SdkMessage)
    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      status: 'done',
      result: { content: 'final answer', isError: false },
      resultOrigin: 'notification',
    })
  })

  it('does not replace a synchronous main-thread result with a summary-only notification', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a',
      label: 'do work',
      status: 'done',
      isAsync: false,
      toolCount: 0,
      childToolCalls: [],
      result: { content: 'full synchronous result', isError: false },
      resultOrigin: 'tool_result',
    })
    const after = updateSidechainIndexMirror(m, {
      type: 'system', subtype: 'task_notification', uuid: 'n-summary', task_id: 't-1', tool_use_id: 'tu_a',
      status: 'completed', summary: 'all done', receivedAt: 9_000,
    } as unknown as SdkMessage)
    expect(after.activeSubagents.get('tu_a')?.result).toEqual({ content: 'full synchronous result', isError: false })
  })

  it('settles an early summary but still lets the canonical main tool_result win', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m.activeSubagents.set('tu_a', { ...m.activeSubagents.get('tu_a')!, isAsync: false })
    m = updateSidechainIndexMirror(m, {
      type: 'system', subtype: 'task_notification', uuid: 'n-early', task_id: 't-1', tool_use_id: 'tu_a',
      status: 'completed', summary: 'early done', receivedAt: 5_000,
    } as unknown as SdkMessage)
    expect(m.activeSubagents.get('tu_a')?.status).toBe('done')

    m = updateSidechainIndexMirror(m, user([toolResult('tu_a', { content: 'main output' })], 'u-main', null, 10_000))
    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      status: 'done',
      result: { content: 'main output', isError: false },
    })
  })

  it('lets a full notification complete a synchronous record when its main result is lost', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a', label: 'do work', status: 'running', isAsync: false, toolCount: 0, childToolCalls: [],
    })
    const withSummary = updateSidechainIndexMirror(m, {
      type: 'system', subtype: 'task_notification', uuid: 'n-early', task_id: 't-1', tool_use_id: 'tu_a',
      status: 'completed', summary: 'early summary', receivedAt: 5_000,
    } as unknown as SdkMessage)
    expect(withSummary.activeSubagents.get('tu_a')?.status).toBe('done')
    const after = updateSidechainIndexMirror(withSummary, {
      type: 'user', uuid: 'n-full', parent_tool_use_id: null, receivedAt: 9_000,
      message: { role: 'user', content: '<task-notification><task-id>t-1</task-id><tool-use-id>tu_a</tool-use-id><status>completed</status><summary>done</summary><result>notification output</result></task-notification>' },
    } as unknown as SdkMessage)
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      status: 'done',
      result: { content: 'notification output', isError: false },
      resultOrigin: 'notification',
    })

    const canonical = updateSidechainIndexMirror(after, user([toolResult('tu_a', { content: 'canonical output' })], 'u-main', null, 10_000))
    expect(canonical.activeSubagents.get('tu_a')).toMatchObject({
      status: 'done',
      result: { content: 'canonical output', isError: false },
      resultOrigin: 'tool_result',
    })
  })

  it('maps a stopped notification with output to done and non-error', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a', label: 'do work', status: 'background', isAsync: true, toolCount: 0, childToolCalls: [],
    })
    const after = updateSidechainIndexMirror(m, {
      type: 'user', uuid: 'n-stop', parent_tool_use_id: null, receivedAt: 9_000,
      message: { role: 'user', content: '<task-notification><task-id>t-1</task-id><tool-use-id>tu_a</tool-use-id><status>stopped</status><summary>stopped</summary><result>partial output</result></task-notification>' },
    } as unknown as SdkMessage)
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      status: 'done',
      result: { content: 'partial output', isError: false },
      resultOrigin: 'notification',
    })
  })

  it('does not replace an existing failure with a stopped notification result', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a', label: 'do work', status: 'interrupted', isAsync: true, toolCount: 0, childToolCalls: [],
      result: { content: 'original failure', isError: true }, resultOrigin: 'tool_result',
    })
    const after = updateSidechainIndexMirror(m, {
      type: 'user', uuid: 'n-stop', parent_tool_use_id: null, receivedAt: 9_000,
      message: { role: 'user', content: '<task-notification><task-id>t-1</task-id><tool-use-id>tu_a</tool-use-id><status>stopped</status><summary>stopped</summary><result>partial output</result></task-notification>' },
    } as unknown as SdkMessage)
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      status: 'interrupted',
      result: { content: 'original failure', isError: true },
    })
  })

  it('keeps a summary-only stopped notification interrupted', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a', label: 'do work', status: 'background', isAsync: true, toolCount: 0, childToolCalls: [],
    })
    const after = updateSidechainIndexMirror(m, {
      type: 'system', subtype: 'task_notification', uuid: 'n-stop', task_id: 't-1', tool_use_id: 'tu_a',
      status: 'stopped', summary: 'Task stopped', receivedAt: 9_000,
    } as unknown as SdkMessage)
    expect(after.activeSubagents.get('tu_a')?.status).toBe('interrupted')
  })

  it('does not replace a successful main-thread result with stopped partial output', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a', label: 'do work', status: 'done', isAsync: false, toolCount: 0, childToolCalls: [],
      endedAt: 5_000, result: { content: 'full report', isError: false }, resultOrigin: 'tool_result',
    })
    const after = updateSidechainIndexMirror(m, {
      type: 'user', uuid: 'n-stopped', parent_tool_use_id: null, receivedAt: 9_000,
      message: { role: 'user', content: '<task-notification><task-id>t-1</task-id><tool-use-id>tu_a</tool-use-id><status>stopped</status><result>partial</result></task-notification>' },
    } as unknown as SdkMessage)
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      status: 'done',
      result: { content: 'full report', isError: false },
      resultOrigin: 'tool_result',
    })
  })

  it('does not replace a settled streamed answer with stopped partial output', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a', label: 'do work', status: 'done', isAsync: true, toolCount: 0, childToolCalls: [],
      endedAt: 5_000, result: { content: [{ type: 'text', text: 'final report' }], isError: false }, resultOrigin: 'streamed',
    })
    const after = updateSidechainIndexMirror(m, {
      type: 'user', uuid: 'n-stopped-streamed', parent_tool_use_id: null, receivedAt: 9_000,
      message: { role: 'user', content: '<task-notification><task-id>t-1</task-id><tool-use-id>tu_a</tool-use-id><status>stopped</status><result>partial</result></task-notification>' },
    } as unknown as SdkMessage)
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      result: { content: [{ type: 'text', text: 'final report' }], isError: false },
      resultOrigin: 'streamed',
    })
  })

  it('does not replace a richer main-thread result with identical notification text', () => {
    const content = [
      { type: 'text', text: 'report' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
    ]
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a', label: 'do work', status: 'done', isAsync: false, toolCount: 0, childToolCalls: [],
      endedAt: 5_000, result: { content, isError: false }, resultOrigin: 'tool_result',
    })
    const after = updateSidechainIndexMirror(m, {
      type: 'user', uuid: 'n-same', parent_tool_use_id: null, receivedAt: 9_000,
      message: { role: 'user', content: '<task-notification><task-id>t-1</task-id><tool-use-id>tu_a</tool-use-id><status>completed</status><result>report</result></task-notification>' },
    } as unknown as SdkMessage)
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      result: { content, isError: false },
      resultOrigin: 'tool_result',
    })
  })

  it('ignores an older failed notification after a newer completion', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a', label: 'do work', status: 'done', isAsync: true, toolCount: 0, childToolCalls: [],
      endedAt: 9_000, result: { content: 'final answer', isError: false }, resultOrigin: 'notification',
    })
    const after = updateSidechainIndexMirror(m, {
      type: 'system', subtype: 'task_notification', uuid: 'n-old', task_id: 't-1', tool_use_id: 'tu_a',
      status: 'failed', summary: 'older failure', receivedAt: 5_000,
    } as unknown as SdkMessage)
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      status: 'done',
      endedAt: 9_000,
      result: { content: 'final answer', isError: false },
      resultOrigin: 'notification',
    })
  })

  it('does not replace a genuine async main-thread result with later sidechain progress', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a', label: 'do work', status: 'done', isAsync: true, toolCount: 0, childToolCalls: [],
      endedAt: 5_000, result: { content: 'canonical report', isError: false }, resultOrigin: 'tool_result',
    })
    const after = updateSidechainIndexMirror(m, assistant([{ type: 'text', text: 'earlier progress' }], 'c-progress', 'tu_a', 9_000))
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      result: { content: 'canonical report', isError: false },
      resultOrigin: 'tool_result',
    })
  })

  it('accepts a historical completion after a timestampless child frame', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m = updateSidechainIndexMirror(m, {
      ...assistant([{ type: 'text', text: 'timeless output' }], 'c-timeless', 'tu_a'),
      receivedAt: undefined,
    })
    m = updateSidechainIndexMirror(m, {
      type: 'system', subtype: 'task_notification', uuid: 'n-historical', task_id: 't-1', tool_use_id: 'tu_a',
      status: 'completed', summary: 'done', receivedAt: 5_000,
    } as unknown as SdkMessage)
    expect(m.activeSubagents.get('tu_a')?.status).toBe('done')
  })

  it('does not let equal-timestamp streamed progress replace a terminal result', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a', label: 'do work', status: 'done', isAsync: true, toolCount: 0, childToolCalls: [],
      endedAt: 9_000, result: { content: 'final answer', isError: false }, resultOrigin: 'notification',
    })
    const after = updateSidechainIndexMirror(m, assistant([{ type: 'text', text: 'earlier progress' }], 'c-progress', 'tu_a', 9_000))
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      result: { content: 'final answer', isError: false },
      resultOrigin: 'notification',
    })
  })

  it('keeps a full notification when delayed text is only its progress prefix', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a', label: 'do work', status: 'done', isAsync: true, toolCount: 0, childToolCalls: [],
      endedAt: 9_000, result: { content: 'Working\n\nFinal', isError: false }, resultOrigin: 'notification',
    })
    const after = updateSidechainIndexMirror(m, assistant([{ type: 'text', text: 'Working' }], 'c-progress', 'tu_a', 10_000))
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      result: { content: 'Working\n\nFinal', isError: false },
      resultOrigin: 'notification',
    })
  })

  it('lets the original final response supersede an older summary', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a', label: 'do work', status: 'done', isAsync: true, toolCount: 0, childToolCalls: [],
      endedAt: 9_000, result: { content: 'all done', isError: false }, resultOrigin: 'summary',
    })
    const after = updateSidechainIndexMirror(m, assistant([{ type: 'text', text: 'actual final response' }], 'c-final', 'tu_a', 5_000))
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      result: { content: [{ type: 'text', text: 'actual final response' }], isError: false },
      resultOrigin: 'streamed',
    })
  })

  it('lets timestampless streamed output supersede a notification during replay', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a', label: 'do work', status: 'done', isAsync: true, toolCount: 0, childToolCalls: [],
      endedAt: 5_000, result: { content: 'short report', isError: false }, resultOrigin: 'notification',
    })
    const after = updateSidechainIndexMirror(m, {
      ...assistant([{ type: 'text', text: 'full final report' }], 'c-final', 'tu_a'),
      receivedAt: undefined,
    })
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      result: { content: [{ type: 'text', text: 'full final report' }], isError: false },
      resultOrigin: 'streamed',
    })
  })

  it('lets a newer full streamed result supersede a repackaged notification', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a', label: 'do work', status: 'done', isAsync: true, toolCount: 0, childToolCalls: [],
      endedAt: 5_000, result: { content: 'short report', isError: false }, resultOrigin: 'notification',
    })
    const after = updateSidechainIndexMirror(m, assistant([{ type: 'text', text: 'full final report' }], 'c-final', 'tu_a', 9_000))
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      result: { content: [{ type: 'text', text: 'full final report' }], isError: false },
      resultOrigin: 'streamed',
    })
  })

  it('replaces stale stopped output when a real completion arrives', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a', label: 'do work', status: 'interrupted', isAsync: true, toolCount: 0, childToolCalls: [],
      result: { content: 'Task stopped', isError: true }, resultOrigin: 'summary',
    })
    const after = updateSidechainIndexMirror(m, {
      type: 'user', uuid: 'n-real', parent_tool_use_id: null, receivedAt: 9_000,
      message: { role: 'user', content: '<task-notification><task-id>t-1</task-id><tool-use-id>tu_a</tool-use-id><status>completed</status><summary>done</summary><result>actual output</result></task-notification>' },
    } as unknown as SdkMessage)
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      status: 'done',
      result: { content: 'actual output', isError: false },
      resultOrigin: 'notification',
    })
  })

  it('lets late streamed output supersede an interrupted summary', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a', label: 'do work', status: 'interrupted', isAsync: true, toolCount: 0, childToolCalls: [],
      endedAt: 5_000, result: { content: 'Task stopped', isError: true }, resultOrigin: 'summary',
    })
    const after = updateSidechainIndexMirror(m, assistant([{ type: 'text', text: 'final answer' }], 'c-final', 'tu_a', 9_000))
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      result: { content: [{ type: 'text', text: 'final answer' }], isError: false },
      resultOrigin: 'streamed',
    })
  })

  it('lets a late completed summary recover a synchronous interrupted record', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a', label: 'do work', status: 'interrupted', isAsync: false, toolCount: 0, childToolCalls: [],
      result: { content: 'stopped', isError: true }, resultOrigin: 'summary',
    })
    const after = updateSidechainIndexMirror(m, {
      type: 'system', subtype: 'task_notification', uuid: 'n-recover', task_id: 't-1', tool_use_id: 'tu_a',
      status: 'completed', summary: 'actual output', receivedAt: 9_000,
    } as unknown as SdkMessage)
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      status: 'done',
      result: { content: 'actual output', isError: false },
      resultOrigin: 'summary',
    })
  })

  it('marks string-shaped sidechain assistant content as streamed output', () => {
    const m = fresh()
    m.activeSubagents.set('tu_a', {
      toolUseId: 'tu_a', label: 'do work', status: 'running', isAsync: true, toolCount: 0, childToolCalls: [],
    })
    const after = updateSidechainIndexMirror(m, {
      type: 'assistant', uuid: 'c-string', parent_tool_use_id: 'tu_a', receivedAt: 5_000,
      message: { role: 'assistant', content: 'string output' },
    } as unknown as SdkMessage)
    expect(after.activeSubagents.get('tu_a')).toMatchObject({
      result: { content: [{ type: 'text', text: 'string output' }], isError: false },
      resultOrigin: 'streamed',
    })
  })

  it('extends endedAt to the latest child frame for a live record', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m = updateSidechainIndexMirror(m, assistant([toolUse('Bash', 'tu_c1', { command: 'ls' })], 'a-c1', 'tu_a', 5_000))
    expect(m.activeSubagents.get('tu_a')?.endedAt).toBe(5_000)
    // A later child frame at t=9000 advances endedAt further.
    m = updateSidechainIndexMirror(m, assistant([toolUse('Read', 'tu_c2', { file_path: 'a' })], 'a-c2', 'tu_a', 9_000))
    expect(m.activeSubagents.get('tu_a')?.endedAt).toBe(9_000)
  })
})

// ---------------------------------------------------------------------------
// Workflow seed / result / child folds
// ---------------------------------------------------------------------------

describe('updateSidechainIndexMirror: Workflow seed/result/child folds', () => {
  const wfStart = (id: string) =>
    assistant([toolUse('Workflow', id, {
      script: "export const meta = { name: 'wf', phases: [{ title: 'A' }] }\nphase('A')\nagent('hi')\n",
    })], 'a-wf')

  it('seeds a running Workflow record with parsed phases + label', () => {
    const m = updateSidechainIndexMirror(fresh(), wfStart('tu_wf'))
    const rec = m.activeWorkflows.get('tu_wf')
    expect(rec).toMatchObject({ toolUseId: 'tu_wf', label: 'wf', status: 'running' })
    expect(rec?.phases.map((p) => p.title)).toEqual(['A'])
    expect(rec?.childAgents).toEqual([])
  })

  it('indexes child agents from the Workflow sidechain with their phase tag', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, wfStart('tu_wf'))
    m = updateSidechainIndexMirror(m, assistant([
      toolUse('Agent', 'tu_ch1', { description: 'scan', phase: 'A' }),
    ], 'a-child', 'tu_wf'))
    const rec = m.activeWorkflows.get('tu_wf')
    expect(rec?.childAgents).toHaveLength(1)
    expect(rec?.childAgents[0]).toMatchObject({ toolUseId: 'tu_ch1', phase: 'A', status: 'running' })
  })

  it('flips a child to done when its result lands in the sidechain', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, wfStart('tu_wf'))
    m = updateSidechainIndexMirror(m, assistant([toolUse('Agent', 'tu_ch1', { phase: 'A' })], 'a-child', 'tu_wf'))
    m = updateSidechainIndexMirror(m, user([toolResult('tu_ch1', { content: 'ok' })], 'u-child', 'tu_wf'))
    const rec = m.activeWorkflows.get('tu_wf')
    expect(rec?.childAgents[0]?.status).toBe('done')
    expect(rec?.childAgents[0]?.result?.content).toBe('ok')
  })

  it('flips the Workflow itself to done when its own tool_result lands on the main thread', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, wfStart('tu_wf'))
    m = updateSidechainIndexMirror(m, user([toolResult('tu_wf', { content: 'workflow done' })], 'u-wf'))
    const rec = m.activeWorkflows.get('tu_wf')
    expect(rec?.status).toBe('done')
    expect(rec?.result?.content).toBe('workflow done')
  })
})

// ---------------------------------------------------------------------------
// Skill seed / result / child folds
// ---------------------------------------------------------------------------

describe('updateSidechainIndexMirror: Skill seed/result/child folds', () => {
  const skillCall = (id: string, args?: string) =>
    assistant([toolUse('Skill', id, { skill: 'code-review', ...(args ? { args } : {}) })], 'a-skill')

  it('seeds a running Skill record with split namespace', () => {
    const m = updateSidechainIndexMirror(fresh(), skillCall('tu_sk', 'high'))
    const rec = m.activeSkills.get('tu_sk')
    expect(rec).toMatchObject({
      toolUseId: 'tu_sk',
      rawName: 'code-review',
      name: 'code-review',
      namespace: '',
      args: 'high',
      status: 'running',
    })
    expect(rec?.childCalls).toEqual([])
  })

  it('settles to done on its own tool_result', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, skillCall('tu_sk'))
    m = updateSidechainIndexMirror(m, user([toolResult('tu_sk', { content: 'loaded' })], 'u-sk'))
    expect(m.activeSkills.get('tu_sk')?.status).toBe('done')
    expect(m.activeSkills.get('tu_sk')?.result).toEqual({ content: 'loaded', isError: false })
  })

  it('indexes fork child calls and flips them on their result', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, skillCall('tu_sk'))
    // Fork sidechain: child tool_use parented to the Skill id.
    m = updateSidechainIndexMirror(m, assistant([toolUse('Bash', 'tu_fc', { command: 'git diff' })], 'a-fc', 'tu_sk'))
    expect(m.activeSkills.get('tu_sk')?.childCalls).toHaveLength(1)
    expect(m.activeSkills.get('tu_sk')?.childCalls[0]?.status).toBe('running')
    // Child result flips the row.
    m = updateSidechainIndexMirror(m, user([toolResult('tu_fc', { content: 'diff…' })], 'u-fc', 'tu_sk'))
    expect(m.activeSkills.get('tu_sk')?.childCalls[0]?.status).toBe('success')
  })

  it('does not reopen a settled Skill when a late sidechain frame arrives', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, skillCall('tu_sk'))
    m = updateSidechainIndexMirror(m, user([toolResult('tu_sk')], 'u-sk'))
    expect(m.activeSkills.get('tu_sk')?.status).toBe('done')
    // Late sidechain frame: must not reopen the settled record.
    const before = m.activeSkills
    m = updateSidechainIndexMirror(m, assistant([toolUse('Bash', 'tu_late', { command: 'ls' })], 'a-late', 'tu_sk'))
    expect(m.activeSkills.get('tu_sk')?.status).toBe('done')
    expect(m.activeSkills.get('tu_sk')?.childCalls).toEqual([])
    // No Map churn when the record is settled and nothing was added.
    expect(m.activeSkills).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// Launch-ack skipping
// ---------------------------------------------------------------------------

describe('updateSidechainIndexMirror: launch-ack skipping', () => {
  const agentStart = (id: string) =>
    assistant([toolUse('Agent', id, { description: 'async work', run_in_background: true })], 'a-sub')

  const launchAck = (id: string) =>
    user([toolResult(id, { content: 'Async agent launched successfully (agentId=xyz)' })], 'u-ack')

  it('skips a launch-ack tool_result so the record stays running', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    expect(m.activeSubagents.get('tu_a')?.status).toBe('running')
    m = updateSidechainIndexMirror(m, launchAck('tu_a'))
    // The ack was skipped — record stays running, no result captured.
    expect(m.activeSubagents.get('tu_a')?.status).toBe('running')
    expect(m.activeSubagents.get('tu_a')?.result).toBeUndefined()
    expect(m.activeSubagents.get('tu_a')?.endedAt).toBeUndefined()
  })

  it('marks a skipped launch ack as async metadata without settling the record', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m = updateSidechainIndexMirror(m, launchAck('tu_a'))
    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      status: 'running',
      result: undefined,
      resultOrigin: 'async_metadata',
    })
  })

  it('marks a launch ack as metadata even after the subagent was dismissed', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m = dismissSubagent({ ...createInitialSessionState('s1'), mirror: m }, 'tu_a').mirror
    m = updateSidechainIndexMirror(m, launchAck('tu_a'))
    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      status: 'dismissed',
      resultOrigin: 'async_metadata',
    })
  })

  it('a non-ack tool_result still settles the record', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m = updateSidechainIndexMirror(m, user([toolResult('tu_a', { content: 'real output' })], 'u-real'))
    expect(m.activeSubagents.get('tu_a')?.status).toBe('done')
    expect(m.activeSubagents.get('tu_a')?.result?.content).toBe('real output')
  })

  it('an errored ack-shaped result still settles (is_error breaks the ack guard)', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m = updateSidechainIndexMirror(m, user([toolResult('tu_a', {
      isError: true,
      content: 'Async agent launched successfully',
    })], 'u-err'))
    expect(m.activeSubagents.get('tu_a')?.status).toBe('interrupted')
  })
})

// ---------------------------------------------------------------------------
// Child-result flips without a live-status guard
// ---------------------------------------------------------------------------

describe('updateSidechainIndexMirror: child-result flips without a live-status guard', () => {
  it('a child tool_result flips a settled parent child row (no live-status guard)', () => {
    // Set up a subagent, then settle it (done). A child tool_result that
    // lands AFTER the parent settled must still flip the child row — the
    // child-result branch deliberately has no live-status guard.
    let m = fresh()
    m = updateSidechainIndexMirror(m, assistant([toolUse('Agent', 'tu_p', { description: 'p' })], 'a-p'))
    // Seed a child tool_use.
    m = updateSidechainIndexMirror(m, assistant([toolUse('Bash', 'tu_c', { command: 'ls' })], 'a-c', 'tu_p'))
    // Settle the parent via its own tool_result.
    m = updateSidechainIndexMirror(m, user([toolResult('tu_p', { content: 'parent done' })], 'u-p'))
    expect(m.activeSubagents.get('tu_p')?.status).toBe('done')
    // The child is still running. Now its result lands — the branch must
    // flip it to success despite the parent being settled.
    m = updateSidechainIndexMirror(m, user([toolResult('tu_c', { content: 'child out' })], 'u-c', 'tu_p'))
    const rec = m.activeSubagents.get('tu_p')
    expect(rec?.childToolCalls?.[0]?.status).toBe('success')
    expect(rec?.childToolCalls?.[0]?.result?.content).toBe('child out')
  })

  it('a Skill child result does NOT flip after the skill settled (sweep runs first)', () => {
    // Unlike the subagent equivalent, a Skill's tool_result settle branch
    // calls sweepRunningChildCalls — any still-running child is flipped to
    // 'error' the moment the skill reports back. So a late child result
    // arriving after the skill settled finds the child already 'error' and
    // the child-result branch (which only flips 'running' rows) leaves it.
    // This is intentional: "the fork is over, so any child row still marked
    // running lost its result — settle it rather than leave a spinner inside
    // a finished card."
    let m = fresh()
    m = updateSidechainIndexMirror(m, assistant([toolUse('Skill', 'tu_sk', { skill: 'x' })], 'a-sk'))
    m = updateSidechainIndexMirror(m, assistant([toolUse('Bash', 'tu_fc', { command: 'ls' })], 'a-fc', 'tu_sk'))
    expect(m.activeSkills.get('tu_sk')?.childCalls[0]?.status).toBe('running')
    // Settle the skill → sweep flips the running child to 'error'.
    m = updateSidechainIndexMirror(m, user([toolResult('tu_sk')], 'u-sk'))
    expect(m.activeSkills.get('tu_sk')?.status).toBe('done')
    expect(m.activeSkills.get('tu_sk')?.childCalls[0]?.status).toBe('error')
    // Late child result: the child is already 'error' (not 'running'), so the
    // child-result branch leaves it. This is the correct behavior — the skill
    // sweep is a terminal state for its children.
    m = updateSidechainIndexMirror(m, user([toolResult('tu_fc', { content: 'late' })], 'u-fc', 'tu_sk'))
    expect(m.activeSkills.get('tu_sk')?.childCalls[0]?.status).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// applyTasksSnapshot: isAsync authority
// ---------------------------------------------------------------------------

describe('applyTasksSnapshot: isAsync authority', () => {
  const agentStart = (id: string) =>
    assistant([toolUse('Agent', id, { description: 'work' })], 'a-sub')

  /** Build a TaskRecordUi[] from partials, filling required defaults. */
  function tasksOf(tasks: Partial<TaskRecordUi>[]): TaskRecordUi[] {
    return tasks.map((t) => ({
      taskId: 't-' + String(t.toolUseId ?? 'x'),
      description: '',
      status: 'running',
      updatedAt: 0,
      ...t,
    }) as TaskRecordUi)
  }

  it('writes isAsync=true when isBackgrounded=true (live record)', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'running', isBackgrounded: true },
    ]))
    expect(m.activeSubagents.get('tu_a')?.isAsync).toBe(true)
    // Running + isBackgrounded → flip to 'background'.
    expect(m.activeSubagents.get('tu_a')?.status).toBe('background')
  })

  it('writes isAsync=false when isBackgrounded=false (explicit sync)', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'running', isBackgrounded: false },
    ]))
    expect(m.activeSubagents.get('tu_a')?.isAsync).toBe(false)
    // isBackgrounded=false and not terminal → no status flip.
    expect(m.activeSubagents.get('tu_a')?.status).toBe('running')
  })

  it('writes isAsync for a terminal task too (terminal → done)', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    // First snapshot: backgrounded.
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'running', isBackgrounded: true },
    ]))
    expect(m.activeSubagents.get('tu_a')?.isAsync).toBe(true)
    // Terminal snapshot: isBackgrounded still true, status completed.
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'completed', isBackgrounded: true },
    ]))
    // The terminal settle path flips background → done.
    expect(m.activeSubagents.get('tu_a')?.status).toBe('done')
    // isAsync stays true (the snapshot wrote it for the terminal record too).
    expect(m.activeSubagents.get('tu_a')?.isAsync).toBe(true)
  })

  it('captures a terminal task result when no child text or notification arrived', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'running', isBackgrounded: true },
    ]))
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'completed', isBackgrounded: true, result: 'snapshot output' },
    ]))

    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      status: 'done',
      result: { content: 'snapshot output', isError: false },
      resultOrigin: 'notification',
    })
  })

  it('keeps a stopped task with output done and its result non-error', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'running', isBackgrounded: true },
    ]))
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'stopped', isBackgrounded: true, result: 'partial output' },
    ]))

    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      status: 'done',
      result: { content: 'partial output', isError: false },
      resultOrigin: 'notification',
    })
  })

  it('does not mark an already-failed record done on a stopped snapshot', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m.activeSubagents.set('tu_a', {
      ...m.activeSubagents.get('tu_a')!,
      status: 'interrupted',
      isAsync: true,
      result: { content: 'boom', isError: true },
      resultOrigin: 'tool_result',
    })
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'stopped', isBackgrounded: true },
    ]))
    expect(m.activeSubagents.get('tu_a')?.status).toBe('interrupted')
  })

  it('does not replace an existing failure with partial stopped output', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m.activeSubagents.set('tu_a', {
      ...m.activeSubagents.get('tu_a')!,
      status: 'interrupted',
      isAsync: true,
      result: { content: 'original failure', isError: true },
      resultOrigin: 'tool_result',
    })
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'stopped', isBackgrounded: true, result: 'partial output' },
    ]))
    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      status: 'interrupted',
      result: { content: 'original failure', isError: true },
    })
  })

  it('lets a completed snapshot replace a stale error result', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m.activeSubagents.set('tu_a', {
      ...m.activeSubagents.get('tu_a')!,
      status: 'interrupted',
      isAsync: true,
      result: { content: 'stopped', isError: true },
      resultOrigin: 'summary',
    })
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'completed', isBackgrounded: true, result: 'real output' },
    ]))
    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      status: 'done',
      result: { content: 'real output', isError: false },
      resultOrigin: 'notification',
    })
  })

  it('lets a terminal snapshot replace a summary with the full result', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m.activeSubagents.set('tu_a', {
      ...m.activeSubagents.get('tu_a')!,
      status: 'done',
      isAsync: true,
      result: { content: 'done', isError: false },
      resultOrigin: 'summary',
    })
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'completed', isBackgrounded: true, result: 'full final report' },
    ]))
    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      status: 'done',
      result: { content: 'full final report', isError: false },
      resultOrigin: 'notification',
    })
  })

  it('aligns an already-settled record with a failed terminal snapshot', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m.activeSubagents.set('tu_a', {
      ...m.activeSubagents.get('tu_a')!,
      status: 'done',
      isAsync: true,
      result: { content: 'detached', isError: false },
    })
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'failed', isBackgrounded: true, result: 'boom' },
    ]))
    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      status: 'interrupted',
      result: { content: 'boom', isError: true },
      resultOrigin: 'notification',
    })
  })

  it('recovers a synchronous subagent from a terminal snapshot carrying its result', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m.activeSubagents.set('tu_a', { ...m.activeSubagents.get('tu_a')!, isAsync: false })
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'completed', isBackgrounded: false, result: 'snapshot output' },
    ]))
    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      status: 'done',
      result: { content: 'snapshot output', isError: false },
      resultOrigin: 'notification',
    })
  })

  it('lets a completed snapshot replace a successful main-thread result with the full output', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m.activeSubagents.set('tu_a', {
      ...m.activeSubagents.get('tu_a')!,
      status: 'done',
      isAsync: false,
      result: { content: 'short result', isError: false },
      resultOrigin: 'tool_result',
    })
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'completed', isBackgrounded: false, result: 'full final report' },
    ]))
    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      status: 'done',
      result: { content: 'full final report', isError: false },
      resultOrigin: 'notification',
    })
  })

  it('lets a completed snapshot recover identical errored text as successful output', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m.activeSubagents.set('tu_a', {
      ...m.activeSubagents.get('tu_a')!,
      status: 'interrupted',
      isAsync: false,
      result: { content: 'boom', isError: true },
      resultOrigin: 'tool_result',
    })
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'completed', isBackgrounded: false, result: 'boom' },
    ]))
    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      status: 'done',
      result: { content: 'boom', isError: false },
      resultOrigin: 'notification',
    })
  })

  it('uses terminal updatedAt to reject a stale snapshot without endedAt', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m.activeSubagents.set('tu_a', {
      ...m.activeSubagents.get('tu_a')!,
      status: 'done',
      isAsync: true,
      endedAt: 5_000,
      result: { content: 'short report', isError: false },
      resultOrigin: 'notification',
    })
    const snapshot = tasksOf([
      { toolUseId: 'tu_a', status: 'completed', isBackgrounded: true, result: 'short report', updatedAt: 5_000 },
    ])
    m = updateSidechainIndexMirror(m, assistant([{ type: 'text', text: 'full final report' }], 'c-final', 'tu_a', 9_000))
    m = applyTasksSnapshot(m, snapshot)
    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      endedAt: 9_000,
      result: { content: [{ type: 'text', text: 'full final report' }], isError: false },
      resultOrigin: 'streamed',
    })
  })

  it('preserves result identity when a terminal snapshot repeats identical output', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m.activeSubagents.set('tu_a', {
      ...m.activeSubagents.get('tu_a')!,
      status: 'done',
      isAsync: true,
      endedAt: 5_000,
      result: { content: 'final report', isError: false },
      resultOrigin: 'notification',
    })
    const before = m.activeSubagents.get('tu_a')?.result
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'completed', isBackgrounded: true, result: 'final report', endedAt: 5_000 },
    ]))
    expect(m.activeSubagents.get('tu_a')?.result).toBe(before)
  })

  it('does not let a repeated terminal snapshot undo newer streamed output', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m.activeSubagents.set('tu_a', { ...m.activeSubagents.get('tu_a')!, isAsync: true })
    const snapshot = tasksOf([
      { toolUseId: 'tu_a', status: 'completed', isBackgrounded: true, result: 'short report', endedAt: 5_000 },
    ])
    m = applyTasksSnapshot(m, snapshot)
    m = updateSidechainIndexMirror(m, assistant([{ type: 'text', text: 'full final report' }], 'c-final', 'tu_a', 9_000))
    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      endedAt: 9_000,
      resultOrigin: 'streamed',
    })

    m = applyTasksSnapshot(m, snapshot)

    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      endedAt: 9_000,
      result: { content: [{ type: 'text', text: 'full final report' }], isError: false },
      resultOrigin: 'streamed',
    })
  })

  it('does not let a stopped snapshot replace a settled streamed answer', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m.activeSubagents.set('tu_a', {
      ...m.activeSubagents.get('tu_a')!,
      status: 'done',
      isAsync: true,
      endedAt: 5_000,
      result: { content: [{ type: 'text', text: 'final report' }], isError: false },
      resultOrigin: 'streamed',
    })
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'stopped', isBackgrounded: true, result: 'partial', endedAt: 9_000 },
    ]))
    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      result: { content: [{ type: 'text', text: 'final report' }], isError: false },
      resultOrigin: 'streamed',
    })
  })

  it('lets a completed snapshot replace earlier streamed progress with the full output', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m.activeSubagents.set('tu_a', {
      ...m.activeSubagents.get('tu_a')!,
      status: 'done',
      isAsync: true,
      result: { content: [{ type: 'text', text: 'Working on it' }], isError: false },
      resultOrigin: 'streamed',
    })
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'completed', isBackgrounded: true, result: 'full final report' },
    ]))
    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      result: { content: 'full final report', isError: false },
      resultOrigin: 'notification',
    })
  })

  it('settles a synchronous failure without a result as interrupted', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m.activeSubagents.set('tu_a', { ...m.activeSubagents.get('tu_a')!, isAsync: false })
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'failed', isBackgrounded: false },
    ]))
    expect(m.activeSubagents.get('tu_a')?.status).toBe('interrupted')
  })

  it('recovers an interrupted synchronous subagent from a completed resultless snapshot', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m.activeSubagents.set('tu_a', {
      ...m.activeSubagents.get('tu_a')!,
      status: 'interrupted',
      isAsync: false,
      result: { content: 'stale failure', isError: true },
      resultOrigin: 'tool_result',
    })
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'completed', isBackgrounded: false },
    ]))
    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      status: 'done',
      result: { content: 'stale failure', isError: true },
      resultOrigin: 'tool_result',
    })
  })

  it('leaves a running synchronous subagent live on a completed resultless snapshot', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m.activeSubagents.set('tu_a', { ...m.activeSubagents.get('tu_a')!, isAsync: false })
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'completed', isBackgrounded: false },
    ]))
    expect(m.activeSubagents.get('tu_a')?.status).toBe('running')
  })

  it('does not treat a summary as captured output when settling a stopped task', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m.activeSubagents.set('tu_a', {
      ...m.activeSubagents.get('tu_a')!,
      status: 'interrupted',
      isAsync: true,
      result: { content: 'stopped', isError: true },
      resultOrigin: 'summary',
    })
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'stopped', isBackgrounded: true },
    ]))
    expect(m.activeSubagents.get('tu_a')?.status).toBe('interrupted')
  })

  it('does not capture a new terminal result after the user dismissed tracking', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'running', isBackgrounded: true },
    ]))
    m = dismissSubagent({ ...createInitialSessionState('s1'), mirror: m }, 'tu_a').mirror
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'completed', isBackgrounded: true, result: 'late output' },
    ]))

    expect(m.activeSubagents.get('tu_a')?.status).toBe('dismissed')
    expect(m.activeSubagents.get('tu_a')?.result).toBeUndefined()
  })

  it('preserves existing isAsync when the snapshot omits isBackgrounded', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    // First snapshot sets isAsync=true.
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'running', isBackgrounded: true },
    ]))
    // Later snapshot omits isBackgrounded — isAsync must stay true.
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'running' },
    ]))
    expect(m.activeSubagents.get('tu_a')?.isAsync).toBe(true)
  })

  it('keeps a background agent live when the detach ack follows its snapshot', () => {
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'running', isBackgrounded: true },
    ]))
    expect(m.activeSubagents.get('tu_a')?.status).toBe('background')

    m = updateSidechainIndexMirror(m, user([toolResult('tu_a', {
      content: 'Task tu_a is running in the background. Use TaskOutput to retrieve its final output.',
    })], 'u-det'))

    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      status: 'background',
      isAsync: true,
      resultOrigin: 'async_metadata',
    })
    expect(m.activeSubagents.get('tu_a')?.result).toBeUndefined()

    m = updateSidechainIndexMirror(m, {
      type: 'system', subtype: 'task_notification', uuid: 'n-final', task_id: 'tu_a', tool_use_id: 'tu_a',
      status: 'completed', summary: 'Agent finished', result: 'real final report', receivedAt: 9_000,
    } as unknown as SdkMessage)

    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      status: 'done',
      isAsync: true,
      result: { content: 'real final report', isError: false },
      resultOrigin: 'notification',
    })
  })

  it('rescues a detach ack to background, then replaces it with the system result without changing isAsync', () => {
    // Ctrl+B detach ack: the ack tool_result doesn't match the launch-ack
    // signature, so the record was mis-settled to 'done' with a fake result.
    // A live isBackgrounded=true snapshot must rescue it back to 'background'.
    let m = fresh()
    m = updateSidechainIndexMirror(m, agentStart('tu_a'))
    // Mis-settle: a non-ack result that shouldn't have completed the record.
    m = updateSidechainIndexMirror(m, user([toolResult('tu_a', {
      content: 'Task tu_a is running in the background. Use TaskOutput to retrieve its final output.',
    })], 'u-det'))
    expect(m.activeSubagents.get('tu_a')?.status).toBe('done')
    // Rescue snapshot: isBackgrounded=true, not terminal → flip back.
    m = applyTasksSnapshot(m, tasksOf([
      { toolUseId: 'tu_a', status: 'running', isBackgrounded: true },
    ]))
    expect(m.activeSubagents.get('tu_a')?.status).toBe('background')
    expect(m.activeSubagents.get('tu_a')?.result).toBeUndefined()
    expect(m.activeSubagents.get('tu_a')?.endedAt).toBeUndefined()
    expect(m.activeSubagents.get('tu_a')?.isAsync).toBe(true)

    m = updateSidechainIndexMirror(m, {
      type: 'system', subtype: 'task_notification', uuid: 'n-final', task_id: 'tu_a', tool_use_id: 'tu_a',
      status: 'completed', summary: 'Agent finished', result: 'real final report', receivedAt: 9_000,
    } as unknown as SdkMessage)

    expect(m.activeSubagents.get('tu_a')).toMatchObject({
      status: 'done',
      isAsync: true,
      result: { content: 'real final report', isError: false },
      resultOrigin: 'notification',
    })
  })
})

// ---------------------------------------------------------------------------
// dismissSubagent
// ---------------------------------------------------------------------------

describe('dismissSubagent', () => {
  const agentStart = (id: string) =>
    assistant([toolUse('Agent', id, { description: 'work' })], 'a-sub')

  it('flips a running record to dismissed and records the id on intent', () => {
    let s = freshState()
    s = { ...s, mirror: updateSidechainIndexMirror(s.mirror, agentStart('tu_d')) }
    s = dismissSubagent(s, 'tu_d')
    expect(s.mirror.activeSubagents.get('tu_d')?.status).toBe('dismissed')
    expect(s.intent.dismissedSubagents.has('tu_d')).toBe(true)
  })

  it('flips a background record to dismissed (async dismiss is permanent)', () => {
    let s = freshState()
    s = { ...s, mirror: updateSidechainIndexMirror(s.mirror, agentStart('tu_d')) }
    s = { ...s, mirror: applyTasksSnapshot(s.mirror, [{
      taskId: 't-d', toolUseId: 'tu_d', description: '', status: 'running',
      isBackgrounded: true, updatedAt: 0,
    } as TaskRecordUi]) }
    expect(s.mirror.activeSubagents.get('tu_d')?.status).toBe('background')
    s = dismissSubagent(s, 'tu_d')
    expect(s.mirror.activeSubagents.get('tu_d')?.status).toBe('dismissed')
  })

  it('is a no-op for an already-settled (done) record', () => {
    let s = freshState()
    s = { ...s, mirror: updateSidechainIndexMirror(s.mirror, agentStart('tu_d')) }
    // Settle the record first.
    s = { ...s, mirror: updateSidechainIndexMirror(s.mirror, user([toolResult('tu_d', { content: 'done' })], 'u-d')) }
    expect(s.mirror.activeSubagents.get('tu_d')?.status).toBe('done')
    const before = s
    s = dismissSubagent(s, 'tu_d')
    expect(s).toBe(before)
  })

  it('is a no-op for an unknown id', () => {
    const s = freshState()
    expect(dismissSubagent(s, 'nope')).toBe(s)
  })
})

// ---------------------------------------------------------------------------
// reapplyDismissed: replay/reset cannot revive dismissed
// ---------------------------------------------------------------------------

describe('reapplyDismissed: replay/reset cannot revive dismissed', () => {
  const agentStart = (id: string) =>
    assistant([toolUse('Agent', id, { description: 'work' })], 'a-sub')

  it('rebuildIndexesFromMessages re-applies dismissals (no manual reapply needed)', () => {
    // Dismiss a subagent, then simulate a refresh: fresh mirror seeded with
    // the cached messages + dismissed ids, rebuild indexes. The rebuilt
    // record must be 'dismissed' — reapplyDismissed is called inside
    // rebuildIndexesFromMessages.
    let s = freshState()
    s = apply(s, agentStart('tu_d'))
    s = dismissSubagent(s, 'tu_d')
    expect(s.intent.dismissedSubagents.has('tu_d')).toBe(true)

    const fresh = freshState()
    const seeded: SessionState = {
      sessionId: 's1',
      mirror: { ...fresh.mirror, messages: s.mirror.messages, items: s.mirror.items, replayReady: true },
      intent: { ...fresh.intent, dismissedSubagents: s.intent.dismissedSubagents },
    }
    const rebuilt = rebuildIndexesFromMessages(seeded, seeded.mirror.messages)
    expect(rebuilt.mirror.activeSubagents.get('tu_d')?.status).toBe('dismissed')
    expect(rebuilt.intent.dismissedSubagents.has('tu_d')).toBe(true)
  })

  it('REPLAY_REPLACE on a dismissed record keeps it dismissed', () => {
    // Dismiss a subagent, then a REPLAY_REPLACE rebuilds the mirror from the
    // replay payload (which re-seeds the record as 'running'). reapplyDismissed
    // must flip it back to 'dismissed'.
    let s = freshState()
    s = apply(s, agentStart('tu_d'))
    s = dismissSubagent(s, 'tu_d')

    // REPLAY_REPLACE with the same payload (simulating a reconnect replay).
    s = reduceSessionState(s, {
      type: 'REPLAY_REPLACE',
      permissions: [],
      messages: s.mirror.messages,
    })
    expect(s.mirror.activeSubagents.get('tu_d')?.status).toBe('dismissed')
    expect(s.intent.dismissedSubagents.has('tu_d')).toBe(true)
  })

  it('reapplyDismissed prunes ids whose record settled naturally', () => {
    // A dismissed record that later settles to 'done' via a real completion
    // signal must have its id pruned from intent.dismissedSubagents (the
    // natural terminal state wins).
    let s = freshState()
    s = apply(s, agentStart('tu_d'))
    s = dismissSubagent(s, 'tu_d')
    expect(s.intent.dismissedSubagents.has('tu_d')).toBe(true)
    // Now the record is dismissed. reapplyDismissed on a dismissed record
    // keeps the id (still dismissed, still dismissable). But if the record
    // were to settle to 'done' via some other path, the id would be pruned.
    // Simulate: rebuild with no tool_use (record absent) → id pruned.
    const fresh = freshState()
    const seeded: SessionState = {
      sessionId: 's1',
      mirror: { ...fresh.mirror, messages: [], items: [], replayReady: true },
      intent: { ...fresh.intent, dismissedSubagents: s.intent.dismissedSubagents },
    }
    const rebuilt = rebuildIndexesFromMessages(seeded, [])
    expect(rebuilt.intent.dismissedSubagents.size).toBe(0)
  })

  it('reapplyDismissed is idempotent', () => {
    let s = freshState()
    s = apply(s, agentStart('tu_d'))
    s = dismissSubagent(s, 'tu_d')
    const once = reapplyDismissed(s)
    expect(once.mirror.activeSubagents.get('tu_d')?.status).toBe('dismissed')
    const twice = reapplyDismissed(once)
    expect(twice).toBe(once)
  })
})

// ---------------------------------------------------------------------------
// reapplyDismissed: trim→page-back cannot turn dismissed back into running
// ---------------------------------------------------------------------------

describe('reapplyDismissed: trim→page-back cannot turn dismissed back into running', () => {
  // The regression: trimFront prunes a dismissed record (not in-flight) when
  // its tool_use is trimmed away. WINDOW_PAGE at:'head' then prepends the
  // tool_use back, and rebuildIndexesFromMessages re-seeds it as 'running'.
  // Without reapplyDismissed after the rebuild, the record stays 'running'.

  it('a dismissed record stays dismissed after trim drops it and a head page re-seeds it', () => {
    // Build the scenario directly: dismiss a record, then simulate the
    // trim→page-back cycle by dropping the record (as trimFront would) and
    // re-applying the tool_use through rebuildIndexesFromMessages (as
    // prependMessages does). The record must come back as 'dismissed'.
    const agentToolUse: SdkMessage = assistant(
      [toolUse('Agent', 'tu_d', { description: 'work' })], 'a-sub',
    )

    let s = freshState()
    s = apply(s, agentToolUse)
    s = dismissSubagent(s, 'tu_d')
    expect(s.mirror.activeSubagents.get('tu_d')?.status).toBe('dismissed')
    expect(s.intent.dismissedSubagents.has('tu_d')).toBe(true)

    // Simulate trimFront dropping the dismissed record (not in-flight →
    // pruned). We don't need the full trim cycle here — the prune is the
    // only part that matters for the regression.
    const pruned = new Map(s.mirror.activeSubagents)
    pruned.delete('tu_d')
    s = {
      ...s,
      mirror: { ...s.mirror, activeSubagents: pruned },
    }

    // Simulate WINDOW_PAGE at:'head' re-prepending the tool_use:
    // prependMessages calls rebuildIndexesFromMessages on the prepended batch.
    // The tool_use re-seeds a fresh 'running' record (no existing record to
    // preserve), then reapplyDismissed flips it back to 'dismissed'.
    const rebuilt = rebuildIndexesFromMessages(s, [agentToolUse])
    const rec = rebuilt.mirror.activeSubagents.get('tu_d')
    expect(rec?.status).toBe('dismissed')
    expect(rebuilt.intent.dismissedSubagents.has('tu_d')).toBe(true)
  })

  it('full reducer trim→page-back cycle: dismissed survives', () => {
    // End-to-end through the reducer: seed enough turns to trigger trimFront
    // past the subagent's tool_use, then WINDOW_PAGE at:'head' to prepend it
    // back. The dismissed record must not come back as 'running'.
    const agentToolUse: SdkMessage = assistant(
      [toolUse('Agent', 'tu_d', { description: 'work' })], 'a-sub',
    )
    function userMsg(uuid: string, content: string): SdkMessage {
      return { type: 'user', uuid, message: { role: 'user', content }, parent_tool_use_id: null } as unknown as SdkMessage
    }
    function assistantMsg(uuid: string, text: string): SdkMessage {
      return {
        type: 'assistant',
        uuid,
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
      } as unknown as SdkMessage
    }

    let s = freshState()
    // Seed the subagent, settle it, then dismiss it. A settled record's id
    // stays in intent.dismissedSubagents after the dismiss (the dismiss is
    // a no-op on a done record, but we need a dismissable record for the
    // regression). Use a running subagent instead — dismiss works on running.
    s = apply(s, agentToolUse)
    s = dismissSubagent(s, 'tu_d')
    expect(s.mirror.activeSubagents.get('tu_d')?.status).toBe('dismissed')

    // Bury it under enough turns to force a trim past the subagent's tool_use.
    // 700 turns = 1400 items; the append that crosses 1256 triggers a trim
    // that brings items down to ~CAP. The subagent's tool_use (item 0) is
    // well below the cut line.
    for (let i = 0; i < 700; i++) {
      s = reduceSessionState(s, { type: 'MESSAGE', message: userMsg(`u-${i}`, `q${i}`) })
      s = reduceSessionState(s, { type: 'MESSAGE', message: assistantMsg(`a-${i}`, `r${i}`) })
    }
    // The subagent's tool_use has been trimmed away. The dismissed record
    // was pruned by pruneSettledToLive (dismissed is not in-flight).
    expect(s.mirror.activeSubagents.has('tu_d')).toBe(false)
    // The id survives on intent.
    expect(s.intent.dismissedSubagents.has('tu_d')).toBe(true)

    // Now page back: WINDOW_PAGE at:'head' prepends the trimmed tool_use.
    // Use a seq below the current oldestSeq.
    const oldestSeq = s.mirror.window.oldestSeq ?? 1
    const headSeq = Math.max(0, oldestSeq - 1)
    s = reduceSessionState(s, {
      type: 'WINDOW_PAGE',
      at: 'head',
      generation: s.mirror.window.generation,
      headSeq,
      messages: [{ seq: headSeq, msg: agentToolUse }],
      hasMore: false,
      tombstones: [],
    })
    // The record is re-seeded by rebuildIndexesFromMessages, then
    // reapplyDismissed flips it back to 'dismissed'.
    const rec = s.mirror.activeSubagents.get('tu_d')
    expect(rec?.status).toBe('dismissed')
    expect(s.intent.dismissedSubagents.has('tu_d')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// hasTranscriptBackground
// ---------------------------------------------------------------------------

describe('hasTranscriptBackground', () => {
  it('returns true when at least one record is pending', () => {
    expect(hasTranscriptBackground([
      { toolUseId: 'a', label: 'l', status: 'pending', toolCount: 0 },
    ])).toBe(true)
  })

  it('returns true when at least one record is background', () => {
    expect(hasTranscriptBackground([
      { toolUseId: 'a', label: 'l', status: 'background', toolCount: 0 },
    ])).toBe(true)
  })

  it('returns false when all records are running/done/dismissed/interrupted', () => {
    for (const status of ['running', 'done', 'dismissed', 'interrupted'] as const) {
      expect(hasTranscriptBackground([
        { toolUseId: 'a', label: 'l', status, toolCount: 0 },
      ])).toBe(false)
    }
  })

  it('returns false for undefined input', () => {
    expect(hasTranscriptBackground(undefined)).toBe(false)
  })

  it('returns false for an empty array', () => {
    expect(hasTranscriptBackground([])).toBe(false)
  })
})
