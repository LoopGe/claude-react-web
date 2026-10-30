// Task 1 (session-synchronizer): unit tests for the extracted command
// factory. `createSessionCommands(store)` closes over a real SessionStore
// and dispatches the SAME actions the hook previously dispatched inline —
// so these tests assert the optimistic-delivery contract (insert / ack /
// rollback), the error clear, and the subagent dismiss, against the actual
// reducer rather than a mock.
import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'
import { createSessionCommands } from './commands'
import type { SdkMessage } from '../types'

/** An assistant frame carrying a single Agent tool_use block — seeds a
 *  `running` subagent record via getSubagentStarts. */
function agentToolUse(uuid: string, toolUseId: string): SdkMessage {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: null,
    receivedAt: 1,
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: toolUseId, name: 'Agent', input: { prompt: 'do work', description: `Agent ${toolUseId}` } },
      ],
    },
  } as unknown as SdkMessage
}

/** A turn-level `result` frame — triggers sweepAtTurnEnd, which flips a
 *  `background` subagent to `pending` (the post-turn-end waiting state). */
function resultFrame(uuid: string): SdkMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    uuid,
    parent_tool_use_id: null,
    is_error: true,
  } as unknown as SdkMessage
}

describe('createSessionCommands', () => {
  it('insert/ack/rollback keep optimistic delivery semantics', () => {
    const store = new SessionStore('s-cmds-optimistic')
    // Seed a prompt suggestion so we can assert insert clears it.
    store.dispatch({ type: 'PROMPT_SUGGESTION', suggestion: 'next question?' })
    expect(store.getSnapshot().promptSuggestion).toBe('next question?')
    const cmds = createSessionCommands(store)

    // ── insert ──────────────────────────────────────────────────────────
    // Returns an `optimistic:` id, clears promptSuggestion, and stages a
    // `sending` placeholder that the snapshot merges into items.
    const pid = cmds.insertUserMessage('hello')
    expect(pid.startsWith('optimistic:')).toBe(true)
    let snap = store.getSnapshot()
    expect(snap.promptSuggestion).toBeNull()
    expect(snap.items.some((it) => it.id === pid && it.sending === true)).toBe(true)
    expect(snap.messages.at(-1)?.uuid).toBe(pid)

    // ── ack ─────────────────────────────────────────────────────────────
    // Swaps in the server uuid + receivedAt, re-keys the placeholder, and
    // clears the local `sending` spinner.
    cmds.ackUserMessage(pid, 'server-uuid-1', 12345)
    snap = store.getSnapshot()
    expect(snap.items.some((it) => it.id === 'server-uuid-1')).toBe(true)
    expect(snap.items.some((it) => it.id === pid)).toBe(false)
    const acked = store.getState().intent.pendingPlaceholders.get('server-uuid-1')
    expect(acked).toBeDefined()
    expect(acked?.msg.uuid).toBe('server-uuid-1')
    expect(acked?.msg.receivedAt).toBe(12345)
    // `sending` is cleared implicitly by the rebuilt TranscriptItem.
    expect(acked?.sending).toBeUndefined()
    // The old optimistic id is no longer a placeholder key.
    expect(store.getState().intent.pendingPlaceholders.has(pid)).toBe(false)

    // ── rollback ────────────────────────────────────────────────────────
    // Removes ONLY the matching placeholder — a second pending placeholder
    // and the acked entry above must survive.
    const pid2 = cmds.insertUserMessage('world')
    expect(store.getState().intent.pendingPlaceholders.has(pid2)).toBe(true)
    cmds.rollbackUserMessage(pid2)
    snap = store.getSnapshot()
    expect(snap.items.some((it) => it.id === pid2)).toBe(false)
    expect(store.getState().intent.pendingPlaceholders.has(pid2)).toBe(false)
    // The acked placeholder survives the unrelated rollback.
    expect(snap.items.some((it) => it.id === 'server-uuid-1')).toBe(true)
    expect(store.getState().intent.pendingPlaceholders.has('server-uuid-1')).toBe(true)
  })

  it('clearError and dismissSubagent dispatch their existing actions', () => {
    const store = new SessionStore('s-cmds-actions')
    const cmds = createSessionCommands(store)

    // ── clearError ──────────────────────────────────────────────────────
    // Nulls intent.error (the ERROR action with a null message).
    store.dispatch({ type: 'ERROR', message: 'boom' })
    expect(store.getSnapshot().error).toBe('boom')
    cmds.clearError()
    expect(store.getSnapshot().error).toBeNull()

    // ── dismissSubagent ─────────────────────────────────────────────────
    // Flips a `pending` (in-flight, post-turn-end) subagent to `dismissed`
    // and leaves an unrelated record untouched — "changes only the matching
    // record". Seed a pending record via the documented path: Agent tool_use
    // (running) → TASKS_SNAPSHOT with isBackgrounded (background) → result
    // frame (sweep flips background → pending).
    store.dispatch({ type: 'MESSAGE', message: agentToolUse('a-pend', 'tu-pend') })
    expect(store.getState().mirror.activeSubagents.get('tu-pend')?.status).toBe('running')
    store.dispatch({
      type: 'TASKS_SNAPSHOT',
      tasks: [{ taskId: 't-pend', toolUseId: 'tu-pend', description: 'pending seed', status: 'running', isBackgrounded: true, updatedAt: 1 }],
    })
    expect(store.getState().mirror.activeSubagents.get('tu-pend')?.status).toBe('background')
    store.dispatch({ type: 'MESSAGE', message: resultFrame('r-pend') })
    expect(store.getState().mirror.activeSubagents.get('tu-pend')?.status).toBe('pending')

    // Seed a SECOND, unrelated running subagent AFTER the result frame so the
    // turn-end sweep never touched it — it must stay `running` when we dismiss
    // the pending one.
    store.dispatch({ type: 'MESSAGE', message: agentToolUse('a-other', 'tu-other') })
    expect(store.getState().mirror.activeSubagents.get('tu-other')?.status).toBe('running')

    cmds.dismissSubagent('tu-pend')
    const mirror = store.getState().mirror
    expect(mirror.activeSubagents.get('tu-pend')?.status).toBe('dismissed')
    // Only the matching record changed.
    expect(mirror.activeSubagents.get('tu-other')?.status).toBe('running')
    // The dismiss is recorded on intent so it survives a mirror rebuild.
    expect(store.getState().intent.dismissedSubagents.has('tu-pend')).toBe(true)
    expect(store.getState().intent.dismissedSubagents.has('tu-other')).toBe(false)
  })
})
