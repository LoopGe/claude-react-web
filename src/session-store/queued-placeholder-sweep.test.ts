// Regression (mid-turn-disappear): a server-confirmed queued-not-published
// placeholder MUST survive the result-frame sweep. The pump broadcasts `result`
// BEFORE the turn-terminal materialization publishes the real user frame
// (session-pump.ts fan-out precedes onTurnSettling; materializeQueued is
// fire-and-forget), so the queued bubble — which lives ONLY in
// intent.pendingPlaceholders until materialization — would otherwise vanish at
// turn end and reappear next round. The result branch keeps `deliveryStatus ===
// 'queued'` placeholders; the materialization echo consumes them by exact uuid,
// and an interrupt withdrawal evicts them via EVICT_MESSAGES.
import { describe, it, expect } from 'vitest'
import { reduceSessionState } from './reducer'
import { createInitialSessionState, type SessionState, type TranscriptItem } from './types'
import {
  applyOptimisticUserMessage,
  ackUserMessage,
  applyQueuedMessage,
} from './user-message-lifecycle'
import type { SdkMessage } from '../types'

/** Pre-ack optimistic msg: NO receivedAt (deliveryStatus undefined, sending). */
function optimisticMsg(uuid: string, text: string): SdkMessage {
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    message: { role: 'user', content: text },
  } as unknown as SdkMessage
}

/** Server-confirmed msg: receivedAt stamped (derives 'queued' until consumed). */
function serverMsg(uuid: string, text: string, receivedAt = 2_000): SdkMessage {
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    receivedAt,
    message: { role: 'user', content: text },
  } as unknown as SdkMessage
}

const resultFrame: SdkMessage = {
  type: 'result',
  subtype: 'success',
  uuid: 'r-1',
} as unknown as SdkMessage

const rendered = (state: SessionState): TranscriptItem[] =>
  [...state.mirror.items, ...state.intent.pendingPlaceholders.values()]

/** Sending-tab lifecycle up to a server-confirmed queued placeholder. */
function queuedSendingTab(): SessionState {
  let state = createInitialSessionState('s')
  state = applyOptimisticUserMessage(state, optimisticMsg('op:1', 'image message'))
  state = ackUserMessage(state, 'op:1', 'srv-1', 3_000)
  // message-queued frame: own placeholder recognized via clientOperationId.
  state = applyQueuedMessage(state, 'srv-1', serverMsg('srv-1', 'image message'), 'op:1')
  return state
}

describe('queued-not-published placeholder survives the result sweep', () => {
  it('keeps a server-acked queued placeholder through result (no materialization yet)', () => {
    let state = queuedSendingTab()
    expect(state.intent.pendingPlaceholders.has('srv-1')).toBe(true)
    expect(state.intent.pendingPlaceholders.get('srv-1')?.deliveryStatus).toBe('queued')

    state = reduceSessionState(state, { type: 'MESSAGE', message: resultFrame })

    // Survivor: still queued, still only in intent (not published to mirror).
    expect(state.intent.pendingPlaceholders.has('srv-1')).toBe(true)
    expect(state.intent.pendingPlaceholders.get('srv-1')?.deliveryStatus).toBe('queued')
    expect(state.mirror.items.some((it) => it.id === 'srv-1')).toBe(false)
    expect(rendered(state).some((it) => it.id === 'srv-1')).toBe(true)
  })

  it('materialization echo consumes the survivor by exact uuid', () => {
    let state = queuedSendingTab()
    state = reduceSessionState(state, { type: 'MESSAGE', message: resultFrame })
    state = reduceSessionState(state, { type: 'MESSAGE', message: serverMsg('srv-1', 'image message', 4_000) })

    expect(state.intent.pendingPlaceholders.size).toBe(0)
    const items = state.mirror.items.filter((it) => it.id === 'srv-1')
    expect(items.length).toBe(1)
    expect(items[0].optimisticSourceId).toBe('op:1')
  })

  it('other-tab route: a message-queued-only placeholder survives and is consumed', () => {
    let state = createInitialSessionState('s')
    state = applyQueuedMessage(state, 'srv-2', serverMsg('srv-2', 'foreign send'))
    expect(state.intent.pendingPlaceholders.get('srv-2')?.deliveryStatus).toBe('queued')

    state = reduceSessionState(state, { type: 'MESSAGE', message: resultFrame })
    expect(state.intent.pendingPlaceholders.has('srv-2')).toBe(true)

    state = reduceSessionState(state, { type: 'MESSAGE', message: serverMsg('srv-2', 'foreign send', 4_000) })
    expect(state.intent.pendingPlaceholders.size).toBe(0)
    expect(state.mirror.items.some((it) => it.id === 'srv-2')).toBe(true)
  })

  it('mixed map: result drops only the raw optimistic, keeps the queued survivor in slot', () => {
    let state = createInitialSessionState('s')
    // Raw optimistic (never acked) inserted FIRST, then a server-confirmed queued.
    state = applyOptimisticUserMessage(state, optimisticMsg('op:raw', 'unacked'))
    state = applyOptimisticUserMessage(state, optimisticMsg('op:1', 'image message'))
    state = ackUserMessage(state, 'op:1', 'srv-1', 3_000)
    expect([...state.intent.pendingPlaceholders.keys()]).toEqual(['op:raw', 'srv-1'])

    state = reduceSessionState(state, { type: 'MESSAGE', message: resultFrame })

    expect(state.intent.pendingPlaceholders.has('op:raw')).toBe(false)
    expect([...state.intent.pendingPlaceholders.keys()]).toEqual(['srv-1'])
  })

  it('withdrawal after result evicts the survivor (post-result interrupt path)', () => {
    let state = queuedSendingTab()
    state = reduceSessionState(state, { type: 'MESSAGE', message: resultFrame })
    expect(state.intent.pendingPlaceholders.has('srv-1')).toBe(true)

    state = reduceSessionState(state, { type: 'EVICT_MESSAGES', uuids: ['srv-1'] })
    expect(state.intent.pendingPlaceholders.has('srv-1')).toBe(false)
    expect(rendered(state).some((it) => it.id === 'srv-1')).toBe(false)
  })

  it('contrast: a steered broadcast (real mirror item) survives the same result frame', () => {
    let state = createInitialSessionState('s')
    state = applyOptimisticUserMessage(state, optimisticMsg('op:2', 'steered text'))
    const steered = { ...serverMsg('srv-3', 'steered text', 1_000), steeredAt: 1_000 } as SdkMessage
    state = reduceSessionState(state, { type: 'MESSAGE', message: steered })
    expect(state.mirror.items.some((it) => it.id === 'srv-3')).toBe(true)

    state = reduceSessionState(state, { type: 'MESSAGE', message: resultFrame })
    expect(state.mirror.items.some((it) => it.id === 'srv-3')).toBe(true)
  })
})
