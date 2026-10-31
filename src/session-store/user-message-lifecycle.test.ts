// user-message-lifecycle — optimistic delivery intent and consumed/steered
// coordination.
//
// These tests prove the brief's contract:
//   - optimistic/ack own the intent.pendingPlaceholders map (intent-only);
//   - consumed: the intent placeholder path stays in user-message-lifecycle,
//     while the mirror items/messages/activeWorktree stamp is delegated to
//     transcript-log.stampMessageConsumed (mirror-only);
//   - steered: the mirror-only stamp is delegated to
//     transcript-log.stampMessageSteered (no intent changes);
//   - clearSendingPlaceholders is a pure intent helper.
//
// The split is observable: calling applyMessageConsumed with a placeholder
// present mutates ONLY intent (mirror.items unchanged); calling it without a
// placeholder mutates ONLY mirror (intent unchanged). The steered action
// never touches intent.

import { describe, it, expect } from 'vitest'
import {
  applyOptimisticUserMessage,
  ackUserMessage,
  applyMessageConsumed,
  applyMessageSteered,
  clearSendingPlaceholders,
} from './user-message-lifecycle'
import { stampMessageConsumed, stampMessageSteered } from './transcript-log'
import {
  createInitialSessionState,
  createInitialClientIntent,
  type SessionState,
  type TranscriptItem,
  type ClientIntent,
} from './types'
import type { SdkMessage } from '../types'

// ── Message builders ────────────────────────────────────────────────────────

function userMsg(uuid: string, text: string, receivedAt = 2_000): SdkMessage {
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    receivedAt,
    message: { role: 'user', content: text },
  } as unknown as SdkMessage
}

function steeredBroadcastMsg(uuid: string, text: string): SdkMessage {
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    receivedAt: 100,
    steeredAt: 100,
    message: { role: 'user', content: text },
  } as unknown as SdkMessage
}

const freshState = (): SessionState => createInitialSessionState('s')

/** Compose a state with one placeholder in intent.pendingPlaceholders. */
function withPlaceholder(state: SessionState, placeholder: TranscriptItem): SessionState {
  const map = new Map<string, TranscriptItem>()
  map.set(placeholder.id, placeholder)
  return {
    sessionId: state.sessionId,
    mirror: state.mirror,
    intent: { ...state.intent, pendingPlaceholders: map },
  }
}

function placeholderItem(pendingId: string, text: string, opts: { sending?: boolean; consumedAt?: number } = {}): TranscriptItem {
  const msg: SdkMessage = {
    type: 'user',
    uuid: pendingId,
    parent_tool_use_id: null,
    message: { role: 'user', content: text },
    ...(typeof opts.consumedAt === 'number' ? { consumedAt: opts.consumedAt } : {}),
  } as unknown as SdkMessage
  return {
    id: pendingId,
    msg,
    plainText: null,
    isCompactSummary: false,
    hiddenByDefault: false,
    sending: opts.sending ?? true,
    receivedAt: 5_000,
  }
}

// ── Surface ─────────────────────────────────────────────────────────────────

describe('user-message-lifecycle surface', () => {
  it('exports applyOptimisticUserMessage / ackUserMessage / applyMessageConsumed / applyMessageSteered / clearSendingPlaceholders', () => {
    expect(typeof applyOptimisticUserMessage).toBe('function')
    expect(typeof ackUserMessage).toBe('function')
    expect(typeof applyMessageConsumed).toBe('function')
    expect(typeof applyMessageSteered).toBe('function')
    expect(typeof clearSendingPlaceholders).toBe('function')
  })

  it('transcript-log exports stampMessageConsumed / stampMessageSteered (mirror-only stamps)', () => {
    expect(typeof stampMessageConsumed).toBe('function')
    expect(typeof stampMessageSteered).toBe('function')
  })
})

// ── applyOptimisticUserMessage (intent-only) ────────────────────────────────

describe('applyOptimisticUserMessage: intent-only placeholder insert', () => {
  it('creates a placeholder in intent.pendingPlaceholders with sending=true', () => {
    let state = freshState()
    state = applyOptimisticUserMessage(state, userMsg('optimistic:1', 'hello'))
    expect(state.intent.pendingPlaceholders.size).toBe(1)
    const placeholder = state.intent.pendingPlaceholders.get('optimistic:1')
    expect(placeholder).toBeDefined()
    expect(placeholder?.sending).toBe(true)
    // Mirror is untouched — no item appended.
    expect(state.mirror.items.length).toBe(0)
  })

  it('does NOT insert a duplicate placeholder when the server echo already landed', () => {
    // If the WS echo arrived and was appended to mirror.items before the
    // optimistic insert ran, don't add a duplicate placeholder.
    let state = freshState()
    // Pre-seed mirror.items with the server echo (content === 'hello').
    state = {
      sessionId: state.sessionId,
      mirror: {
        ...state.mirror,
        items: [
          {
            id: 'server-1',
            msg: userMsg('server-1', 'hello'),
            plainText: null,
            isCompactSummary: false,
            hiddenByDefault: false,
          },
        ],
        messages: [userMsg('server-1', 'hello')],
      },
      intent: state.intent,
    }
    state = applyOptimisticUserMessage(state, userMsg('optimistic:1', 'hello'))
    // No placeholder added (server echo already on screen).
    expect(state.intent.pendingPlaceholders.size).toBe(0)
  })

  it('stamps receivedAt locally so the timestamp shows immediately', () => {
    let state = freshState()
    state = applyOptimisticUserMessage(state, userMsg('optimistic:1', 'hello'))
    const placeholder = state.intent.pendingPlaceholders.get('optimistic:1')
    expect(placeholder?.receivedAt).toEqual(expect.any(Number))
  })
})

// ── ackUserMessage (intent + minor mirror.pendingConsumedMessages cleanup) ──

describe('ackUserMessage: re-key placeholder, drop sending, stamp receivedAt/consumedAt', () => {
  it('re-keys the placeholder to the server uuid and clears sending', () => {
    let state = withPlaceholder(freshState(), placeholderItem('optimistic:1', 'hello'))
    state = ackUserMessage(state, 'optimistic:1', 'server-1', /* receivedAt */ 123)
    expect(state.intent.pendingPlaceholders.has('optimistic:1')).toBe(false)
    const acked = state.intent.pendingPlaceholders.get('server-1')
    expect(acked).toBeDefined()
    expect(acked?.sending).toBeUndefined()
    expect(acked?.msg.uuid).toBe('server-1')
    expect(acked?.msg.receivedAt).toBe(123)
  })

  it('is a no-op when the placeholder is already gone (echo arrived first)', () => {
    const state = freshState()
    const next = ackUserMessage(state, 'optimistic:missing', 'server-1')
    expect(next).toBe(state)
  })

  it('forwards pendingConsumedMessages[serverUuid] onto the placeholder and clears the parking entry', () => {
    let state = withPlaceholder(freshState(), placeholderItem('optimistic:1', 'hello'))
    // Park a consumed signal for the server uuid.
    state = {
      sessionId: state.sessionId,
      mirror: {
        ...state.mirror,
        pendingConsumedMessages: new Map([['server-1', 456]]),
      },
      intent: state.intent,
    }
    state = ackUserMessage(state, 'optimistic:1', 'server-1')
    const acked = state.intent.pendingPlaceholders.get('server-1')
    expect(acked?.msg.consumedAt).toBe(456)
    expect(acked?.deliveryStatus).toBe('consumed')
    // Parking entry cleared.
    expect(state.mirror.pendingConsumedMessages.has('server-1')).toBe(false)
  })

  it('preserves Map insertion order across ack/echo interleavings (FIFO contract)', () => {
    // Two placeholders queued in send order. ACK the FIRST — the re-key must
    // replace the entry AT ITS ORIGINAL SLOT, not move it to the end. This
    // preserves FIFO order so the echo-merge (in applyMessage) consumes the
    // correct placeholder next.
    let state = freshState()
    state = applyOptimisticUserMessage(state, userMsg('optimistic:1', 'first'))
    state = applyOptimisticUserMessage(state, userMsg('optimistic:2', 'second'))
    state = ackUserMessage(state, 'optimistic:1', 'server-1')
    expect(Array.from(state.intent.pendingPlaceholders.keys())).toEqual(['server-1', 'optimistic:2'])
  })
})

// ── applyMessageConsumed: split — intent path vs mirror path ────────────────

describe('applyMessageConsumed: intent placeholder path stays in lifecycle (intent-only)', () => {
  it('stamps the placeholder msg.consumedAt and re-derives deliveryStatus (intent only)', () => {
    let state = withPlaceholder(freshState(), placeholderItem('optimistic:1', 'hello'))
    const mirrorBefore = state.mirror
    state = applyMessageConsumed(state, 'optimistic:1', 789)
    const placeholder = state.intent.pendingPlaceholders.get('optimistic:1')
    expect(placeholder?.msg.consumedAt).toBe(789)
    expect(placeholder?.deliveryStatus).toBe('consumed')
    // Mirror is unchanged — the intent placeholder path makes no mirror writes.
    expect(state.mirror).toBe(mirrorBefore)
    // The placeholder is still in intent (re-keyed on ack, but consumed-before-
    // ack keeps the original id).
    expect(state.intent.pendingPlaceholders.has('optimistic:1')).toBe(true)
  })

  it('is identity-stable for a duplicate consumed frame on an already-consumed placeholder', () => {
    // A duplicate MESSAGE_CONSUMED frame (e.g. WS replay after a reconnect)
    // for a placeholder whose deliveryStatus is already 'consumed' with the
    // same consumedAt must be a no-op — matches stampMessageConsumed's
    // mirror-path short-circuit.
    let state = withPlaceholder(freshState(), placeholderItem('optimistic:1', 'hello'))
    state = applyMessageConsumed(state, 'optimistic:1', 789)
    expect(state.intent.pendingPlaceholders.get('optimistic:1')?.deliveryStatus).toBe('consumed')
    const before = state
    state = applyMessageConsumed(state, 'optimistic:1', 789)
    expect(state).toBe(before)
  })
})

describe('applyMessageConsumed: mirror path delegates to transcript-log.stampMessageConsumed', () => {
  it('stamps the on-screen item with consumedAt + deliveryStatus=consumed (mirror only)', () => {
    let state = freshState()
    state = {
      sessionId: state.sessionId,
      mirror: {
        ...state.mirror,
        items: [
          {
            id: 'server-1',
            msg: userMsg('server-1', 'hello'),
            plainText: null,
            isCompactSummary: false,
            hiddenByDefault: false,
          },
        ],
        messages: [userMsg('server-1', 'hello')],
      },
      intent: state.intent,
    }
    const intentBefore = state.intent
    state = applyMessageConsumed(state, 'server-1', 321)
    expect(state.mirror.items[0].msg.consumedAt).toBe(321)
    expect(state.mirror.items[0].deliveryStatus).toBe('consumed')
    // Intent unchanged — the mirror stamp path makes no intent writes.
    expect(state.intent).toBe(intentBefore)
  })

  it('parks the consumed signal in pendingConsumedMessages when the item is not yet on screen', () => {
    let state = freshState()
    state = applyMessageConsumed(state, 'server-future', 654)
    expect(state.mirror.pendingConsumedMessages.get('server-future')).toBe(654)
  })

  it('is identity-stable when the item is already consumed', () => {
    let state = freshState()
    const item: TranscriptItem = {
      id: 'server-1',
      msg: { ...userMsg('server-1', 'hello'), consumedAt: 100 } as unknown as SdkMessage,
      plainText: null,
      isCompactSummary: false,
      hiddenByDefault: false,
      deliveryStatus: 'consumed',
    }
    state = {
      sessionId: state.sessionId,
      mirror: { ...state.mirror, items: [item], messages: [item.msg] },
      intent: state.intent,
    }
    const before = state
    state = applyMessageConsumed(state, 'server-1', 999)
    // Already consumed — no rewrite.
    expect(state).toBe(before)
  })
})

// ── applyMessageSteered: mirror-only via transcript-log.stampMessageSteered ─

describe('applyMessageSteered: mirror-only stamp via transcript-log.stampMessageSteered', () => {
  function stateWithSteeredItem(uuid: string, text: string): SessionState {
    const msg = steeredBroadcastMsg(uuid, text)
    // Run the broadcast through applyMessage by composing the mirror directly:
    // an item with deliveryStatus='injecting' (steeredAt set, no terminal stamp).
    const item: TranscriptItem = {
      id: uuid,
      msg,
      plainText: null,
      isCompactSummary: false,
      hiddenByDefault: false,
      deliveryStatus: 'injecting',
    }
    return {
      sessionId: 's',
      mirror: {
        ...createInitialSessionState('s').mirror,
        items: [item],
        messages: [msg],
      },
      intent: createInitialClientIntent(),
    }
  }

  it('injected: stamps injectedAt and flips deliveryStatus to injected (mirror only)', () => {
    let state = stateWithSteeredItem('steer-1', 'pivot')
    const intentBefore = state.intent
    state = applyMessageSteered(state, 'steer-1', 'injected')
    expect(state.mirror.items[0].deliveryStatus).toBe('injected')
    expect((state.mirror.items[0].msg as { injectedAt?: number }).injectedAt).toEqual(expect.any(Number))
    // Intent unchanged — steered is mirror-only.
    expect(state.intent).toBe(intentBefore)
  })

  it('requeued: stamps requeuedAt and falls back to deliveryStatus=queued', () => {
    let state = stateWithSteeredItem('steer-2', 'pivot')
    state = applyMessageSteered(state, 'steer-2', 'requeued')
    expect(state.mirror.items[0].deliveryStatus).toBe('queued')
    expect((state.mirror.items[0].msg as { requeuedAt?: number }).requeuedAt).toEqual(expect.any(Number))
  })

  it('is a no-op for an unknown uuid (replay stamps are the durable truth)', () => {
    const state = freshState()
    const next = applyMessageSteered(state, 'ghost', 'injected')
    expect(next).toBe(state)
  })

  it('is identity-stable when injecting arrives twice (idempotent)', () => {
    let state = stateWithSteeredItem('steer-3', 'pivot')
    state = applyMessageSteered(state, 'steer-3', 'injected')
    expect(state.mirror.items[0].deliveryStatus).toBe('injected')
    // Second injected frame: no-op (already injected).
    const before = state
    state = applyMessageSteered(state, 'steer-3', 'injected')
    expect(state).toBe(before)
  })

  it('requeued → consumed: the queued→consumed flow still works after requeue', () => {
    let state = stateWithSteeredItem('steer-4', 'pivot')
    state = applyMessageSteered(state, 'steer-4', 'requeued')
    expect(state.mirror.items[0].deliveryStatus).toBe('queued')
    state = applyMessageConsumed(state, 'steer-4', 200)
    expect(state.mirror.items[0].deliveryStatus).toBe('consumed')
    expect(state.mirror.items[0].msg.consumedAt).toBe(200)
  })
})

// ── clearSendingPlaceholders (pure intent helper) ───────────────────────────

describe('clearSendingPlaceholders: pure intent helper', () => {
  it('returns the intent unchanged when there are no placeholders', () => {
    const intent = createInitialClientIntent()
    expect(clearSendingPlaceholders(intent)).toBe(intent)
  })

  it('drops all placeholders (result frame means the SDK is done — no echo expected)', () => {
    const intent: ClientIntent = {
      ...createInitialClientIntent(),
      pendingPlaceholders: new Map([
        ['optimistic:1', placeholderItem('optimistic:1', 'a')],
        ['optimistic:2', placeholderItem('optimistic:2', 'b')],
      ]),
    }
    const cleared = clearSendingPlaceholders(intent)
    expect(cleared.pendingPlaceholders.size).toBe(0)
    // Other intent fields preserved.
    expect(cleared.dismissedSubagents).toBe(intent.dismissedSubagents)
    expect(cleared.error).toBe(intent.error)
  })
})
