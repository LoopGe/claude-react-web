// message-pipeline — the full applyMessage orchestration.
//
// These tests pin the exact applyMessage order from the design spec
// (§7 of 2026-10-31-reducer-state-owners-design.md):
//   1. FIFO consume oldest optimistic placeholder
//   2. compute effectiveConsumedAt
//   3. route apiRetry / thinkingTokens transient slots
//   4. update live-turn
//   5. update transcript items/messages + activeWorktree
//   6. update tool/sidechain indexes
//   7. drain pendingResults (index-pipeline only)
//   8. prune finalized live-turn text
//   9. supersede draft
//   10. cleanup pendingConsumedMessages
//   11. result branch: freeze draft, sweep turn, clear liveTurn, clear sending placeholders
//   12. trimFront
//   13. refusal-fallback / supersedes eviction
//
// The tests cover each step's observable outcome AND specific orderings where
// order matters (e.g. FIFO placeholder → effectiveConsumedAt propagation,
// indexes → drain, result branch → trim). They do NOT re-test the leaf
// modules' own invariants — those live in their dedicated test files.

import { describe, it, expect } from 'vitest'
import { applyMessage } from './message-pipeline'
import { applyMessageConsumed } from './user-message-lifecycle'
import {
  createInitialSessionState,
  type SessionState,
  type TranscriptItem,
} from './types'
import { MEMORY_ITEM_CAP } from './transcript-log'
import { flushLiveTurn } from './live-turn'
import { getActiveWorktree } from './normalize'
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

function asstMsg(uuid: string, text: string, receivedAt = 1_000): SdkMessage {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: null,
    receivedAt,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as unknown as SdkMessage
}

function toolUseMsg(uuid: string, toolUseId: string, name = 'Bash'): SdkMessage {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: null,
    receivedAt: 0,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name, input: {} }],
    },
  } as unknown as SdkMessage
}

function toolResultUserMsg(uuid: string, toolUseId: string, content = 'ok'): SdkMessage {
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: toolUseId,
    receivedAt: 0,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    },
  } as unknown as SdkMessage
}

function resultMsg(uuid: string): SdkMessage {
  return { type: 'result', subtype: 'success', uuid } as unknown as SdkMessage
}

function apiRetryMsg(uuid: string): SdkMessage {
  return {
    type: 'system',
    subtype: 'api_retry',
    uuid,
    attempt: 1,
    max_retries: 3,
    retry_delay_ms: 1000,
    error_status: 429,
    error: 'rate_limit_error',
  } as unknown as SdkMessage
}

function thinkingTokensMsg(uuid: string, estimatedTokens: number): SdkMessage {
  return {
    type: 'system',
    subtype: 'thinking_tokens',
    uuid,
    estimated_tokens: estimatedTokens,
  } as unknown as SdkMessage
}

function streamEventMsg(uuid: string, text = 'delta'): SdkMessage {
  return {
    type: 'stream_event',
    uuid,
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  } as unknown as SdkMessage
}

function enterWorktreeMsg(uuid: string, name: string): SdkMessage {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: null,
    receivedAt: 1_000,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: `tu-${uuid}`, name: 'EnterWorktree', input: { name } }],
    },
  } as unknown as SdkMessage
}

const freshState = (): SessionState => createInitialSessionState('s')

const ids = (state: SessionState) => state.mirror.items.map((i) => i.id)

/** Build a placeholder TranscriptItem directly (bypasses applyOptimisticUserMessage
 *  so message-pipeline tests don't depend on lifecycle for state setup). */
function placeholderItem(pendingId: string, text: string, consumedAt?: number): TranscriptItem {
  const msg: SdkMessage = {
    type: 'user',
    uuid: pendingId,
    parent_tool_use_id: null,
    message: { role: 'user', content: text },
    ...(typeof consumedAt === 'number' ? { consumedAt } : {}),
  } as unknown as SdkMessage
  return {
    id: pendingId,
    msg,
    plainText: null,
    isCompactSummary: false,
    hiddenByDefault: false,
    sending: true,
    receivedAt: 5_000,
  }
}

/** Compose a state with the given placeholders in intent.pendingPlaceholders. */
function withPlaceholders(state: SessionState, placeholders: TranscriptItem[]): SessionState {
  const map = new Map<string, TranscriptItem>()
  for (const p of placeholders) map.set(p.id, p)
  return {
    sessionId: state.sessionId,
    mirror: state.mirror,
    intent: { ...state.intent, pendingPlaceholders: map },
  }
}

// ── Surface ─────────────────────────────────────────────────────────────────

describe('applyMessage surface', () => {
  it('is exported from message-pipeline', () => {
    expect(typeof applyMessage).toBe('function')
  })
})

// ── Step 1: FIFO placeholder consumption ─────────────────────────────────────

describe('applyMessage step 1: FIFO consume oldest optimistic placeholder', () => {
  it('consumes the OLDEST placeholder on a top-level user echo (insertion order)', () => {
    // Two placeholders queued in send order. The echo for the FIRST send must
    // consume the oldest placeholder, leaving the second one in place.
    let state = withPlaceholders(freshState(), [
      placeholderItem('optimistic:1', 'first'),
      placeholderItem('optimistic:2', 'second'),
    ])
    state = applyMessage(state, userMsg('server-1', 'first'))
    expect(state.intent.pendingPlaceholders.has('optimistic:1')).toBe(false)
    expect(state.intent.pendingPlaceholders.has('optimistic:2')).toBe(true)
  })

  it('does NOT match a subagent tool_result against a pending placeholder (parent guard)', () => {
    // tool_result frames are type:'user' but carry parent_tool_use_id — they
    // must not consume the optimistic placeholder.
    let state = withPlaceholders(freshState(), [
      placeholderItem('optimistic:1', 'real user input'),
    ])
    state = applyMessage(state, toolResultUserMsg('tool-result-uuid', 'tu_subagent'))
    // Placeholder survives.
    expect(state.intent.pendingPlaceholders.has('optimistic:1')).toBe(true)
  })
})

// ── Step 2: effectiveConsumedAt ──────────────────────────────────────────────

describe('applyMessage step 2: effectiveConsumedAt propagation', () => {
  it('forwards placeholder.msg.consumedAt onto the appended item (FIFO → effectiveConsumedAt → transcript)', () => {
    // Order pinning: the FIFO placeholder (step 1) reads the placeholder's
    // consumedAt, then effectiveConsumedAt (step 2) forwards it onto the
    // incoming message, then the transcript append (step 5) stamps the new
    // item with it. If any step ran out of order, consumedAt would be lost.
    let state = withPlaceholders(freshState(), [
      placeholderItem('optimistic:1', 'hello', /* consumedAt */ 999),
    ])
    state = applyMessage(state, userMsg('server-1', 'hello'))
    expect(state.mirror.items[state.mirror.items.length - 1].msg.consumedAt).toBe(999)
    expect(state.mirror.items[state.mirror.items.length - 1].deliveryStatus).toBe('consumed')
  })

  it('forwards mirror.pendingConsumedMessages[uuid] onto the appended item', () => {
    // A consumed signal that arrived BEFORE the message broadcast parks in
    // pendingConsumedMessages. applyMessage must forward it onto the appended
    // item and clean up the parking entry (step 10).
    let state = freshState()
    state = applyMessageConsumed(state, 'server-1', 4242)
    expect(state.mirror.pendingConsumedMessages.get('server-1')).toBe(4242)
    state = applyMessage(state, userMsg('server-1', 'hello'))
    expect(state.mirror.items[state.mirror.items.length - 1].msg.consumedAt).toBe(4242)
    expect(state.mirror.pendingConsumedMessages.has('server-1')).toBe(false)
  })

  it('prefers pendingConsumedMessages over the existing item consumedAt (priority order)', () => {
    // pendingConsumedAt > placeholderConsumedAt > existingConsumedAt — pin the
    // priority by setting up both pending and existing, and checking pending wins.
    let state = freshState()
    // Seed an existing assistant frame to anchor the cache.
    state = applyMessage(state, asstMsg('a-1', 'first'))
    // Apply consumed for a server uuid that is NOT yet on screen — parks.
    state = applyMessageConsumed(state, 'server-2', 111)
    // Now echo the message — pendingConsumedAt (111) wins over existing
    // (undefined) and over placeholder (none).
    state = applyMessage(state, userMsg('server-2', 'second'))
    expect(state.mirror.items[state.mirror.items.length - 1].msg.consumedAt).toBe(111)
  })
})

// ── Step 3: transient slots ─────────────────────────────────────────────────

describe('applyMessage step 3: transient slot routing', () => {
  it('routes api_retry to mirror.apiRetry (never items/messages)', () => {
    let state = freshState()
    state = applyMessage(state, apiRetryMsg('r-1'))
    expect(state.mirror.apiRetry).not.toBeNull()
    expect(state.mirror.apiRetry?.uuid).toBe('r-1')
    expect(state.mirror.items.some((it) => it.id === 'r-1')).toBe(false)
  })

  it('routes thinking_tokens to mirror.thinkingTokens (never items/messages)', () => {
    let state = freshState()
    state = applyMessage(state, thinkingTokensMsg('tt-1', 4242))
    expect(state.mirror.thinkingTokens).toBe(4242)
    expect(state.mirror.items.some((it) => it.id === 'tt-1')).toBe(false)
  })

  it('clears thinkingTokens on a finalized main-thread assistant message', () => {
    let state = freshState()
    state = applyMessage(state, thinkingTokensMsg('tt-1', 500))
    expect(state.mirror.thinkingTokens).toBe(500)
    state = applyMessage(state, asstMsg('a-1', 'final'))
    expect(state.mirror.thinkingTokens).toBeNull()
  })

  it('clears both apiRetry and thinkingTokens on a result frame (turn end)', () => {
    let state = freshState()
    state = applyMessage(state, apiRetryMsg('r-1'))
    state = applyMessage(state, thinkingTokensMsg('tt-1', 500))
    state = applyMessage(state, resultMsg('r-end'))
    expect(state.mirror.apiRetry).toBeNull()
    expect(state.mirror.thinkingTokens).toBeNull()
  })
})

// ── Step 4: live-turn update ────────────────────────────────────────────────

describe('applyMessage step 4: live-turn update (stream_event routes to liveTurn)', () => {
  it('routes a stream_event delta to mirror.liveTurn (never items/messages)', () => {
    let state = freshState()
    state = applyMessage(state, streamEventMsg('se-1', 'hello '))
    expect(state.mirror.items.some((it) => it.id === 'se-1')).toBe(false)
    // liveTurn accumulator holds the delta as an unflushed textChunk segment.
    expect(state.mirror.liveTurn).not.toBeNull()
    expect(state.mirror.liveTurn?.textChunks.some((s) => s.text.includes('hello'))).toBe(true)
  })

  it('does NOT route a sidechain stream_event to the main-thread liveTurn', () => {
    let state = freshState()
    state = applyMessage(state, {
      type: 'stream_event',
      uuid: 'se-sub',
      parent_tool_use_id: 'tu_sub',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub' } },
    } as unknown as SdkMessage)
    // Sidechain deltas land in the liveTurn but tagged sidechain:true — the
    // main-thread segment filter excludes them.
    expect(state.mirror.liveTurn?.textChunks.some((s) => !s.sidechain && s.text.includes('sub'))).toBe(false)
  })
})

// ── Step 5: transcript append + activeWorktree fold ─────────────────────────

describe('applyMessage step 5: transcript append + activeWorktree fold', () => {
  it('appends a renderable assistant message to items/messages', () => {
    let state = freshState()
    state = applyMessage(state, asstMsg('a-1', 'hello'))
    expect(ids(state)).toEqual(['a-1'])
    expect(state.mirror.messages.map((m) => m.uuid)).toEqual(['a-1'])
  })

  it('folds activeWorktree for the appended message (EnterWorktree seeds the field)', () => {
    let state = freshState()
    state = applyMessage(state, enterWorktreeMsg('a-wt', 'feature-x'))
    expect(state.mirror.activeWorktree).toEqual({ name: 'feature-x', enterMsgId: 'a-wt' })
    // Invariant: activeWorktree === getActiveWorktree(messages).
    expect(getActiveWorktree(state.mirror.messages)).toEqual(state.mirror.activeWorktree)
  })
})

// ── Step 6: tool/sidechain indexes ──────────────────────────────────────────

describe('applyMessage step 6: tool/sidechain index update', () => {
  it('seeds toolStatus[toolUseId]=running on a tool_use (after transcript append)', () => {
    let state = freshState()
    state = applyMessage(state, toolUseMsg('a-1', 'tu_bash'))
    // Index seeded AFTER the transcript append: the item is on screen AND
    // its tool is recorded as running.
    expect(ids(state)).toContain('a-1')
    expect(state.mirror.toolStatus.get('tu_bash')).toBe('running')
  })

  it('settles toolStatus[toolUseId]=success when the matching tool_result lands', () => {
    let state = freshState()
    state = applyMessage(state, toolUseMsg('a-1', 'tu_bash'))
    state = applyMessage(state, toolResultUserMsg('u-1', 'tu_bash', 'ok'))
    expect(state.mirror.toolStatus.get('tu_bash')).toBe('success')
    expect(state.mirror.toolResults.get('tu_bash')).toBeDefined()
  })
})

// ── Step 7: drain pendingResults (after indexes) ────────────────────────────

describe('applyMessage step 7: drain pendingResults (indexes → drain ordering)', () => {
  it('drains a parked result when its tool_use lands (drain runs AFTER the index seed)', () => {
    // Order pinning: a tool_result that arrives BEFORE its tool_use parks in
    // pendingResults. When the tool_use lands, step 6 seeds toolStatus=running,
    // then step 7 drains the parked result and flips toolStatus=success. If
    // drain ran BEFORE the index seed, the result would have no owner record
    // to settle into.
    let state = freshState()
    state = applyMessage(state, toolResultUserMsg('u-result', 'tu_bash', 'ok'))
    expect(state.mirror.pendingResults.size).toBe(1)
    state = applyMessage(state, toolUseMsg('a-tool', 'tu_bash'))
    expect(state.mirror.toolStatus.get('tu_bash')).toBe('success')
    expect(state.mirror.pendingResults.size).toBe(0)
  })
})

// ── Step 8: prune finalized live-turn text ──────────────────────────────────

describe('applyMessage step 8: prune finalized live-turn text', () => {
  it('prunes the finalized assistant text from liveTurn (no duplicate in WorkingBubble)', () => {
    // Stream a chunk, flush it, then finalize — the finalized assistant text
    // is now in the transcript (step 5), so step 8 prunes it from liveTurn to
    // avoid a duplicate render in the WorkingBubble.
    let state = freshState()
    state = applyMessage(state, streamEventMsg('se-1', 'partial'))
    // Flush to move textChunks → flushedText (the in-place draft also folds).
    state = { ...state, mirror: flushLiveTurn(state.mirror) }
    expect(state.mirror.liveTurn?.flushedText.some((s) => s.text.includes('partial'))).toBe(true)
    state = applyMessage(state, asstMsg('a-final', 'partial'))
    // The finalized text is in items; main-thread flushedText is pruned.
    expect(ids(state)).toContain('a-final')
    expect(state.mirror.liveTurn?.flushedText.some((s) => !s.sidechain)).toBe(false)
  })
})

// ── Step 9: supersede draft ─────────────────────────────────────────────────

describe('applyMessage step 9: supersede draft on finalized assistant', () => {
  it('supersedes the in-place draft: alias the assistant uuid to the draft key, draft cleared', () => {
    let state = freshState()
    // Seed a draft via a stream_event + flush.
    state = applyMessage(state, streamEventMsg('se-1', 'partial'))
    state = { ...state, mirror: flushLiveTurn(state.mirror) }
    expect(state.mirror.draft).not.toBeNull()
    state = applyMessage(state, asstMsg('a-final', 'partial'))
    expect(state.mirror.draft).toBeNull()
    expect(state.mirror.draftRowKeys['a-final']).toBeDefined()
  })

  it('does NOT supersede for a sidechain assistant (parent_tool_use_id set)', () => {
    let state = freshState()
    state = applyMessage(state, streamEventMsg('se-1', 'partial'))
    state = { ...state, mirror: flushLiveTurn(state.mirror) }
    const before = state.mirror.draft
    state = applyMessage(state, {
      type: 'assistant',
      uuid: 'a-sub',
      parent_tool_use_id: 'tu_sub',
      message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] },
    } as unknown as SdkMessage)
    // Draft untouched — sidechain finalize doesn't supersede the main draft.
    expect(state.mirror.draft).toBe(before)
  })
})

// ── Step 10: cleanup pendingConsumedMessages ────────────────────────────────

describe('applyMessage step 10: cleanup pendingConsumedMessages after echo', () => {
  it('drops the pendingConsumedMessages entry for the echoed uuid', () => {
    // A consumed signal parked for uuid 'server-1'. The echo arrives, the
    // effectiveConsumedAt forwards it onto the appended item (step 2), and
    // step 10 cleans up the parking entry.
    let state = freshState()
    state = applyMessageConsumed(state, 'server-1', 333)
    expect(state.mirror.pendingConsumedMessages.has('server-1')).toBe(true)
    state = applyMessage(state, userMsg('server-1', 'hello'))
    expect(state.mirror.pendingConsumedMessages.has('server-1')).toBe(false)
  })
})

// ── Step 11: result branch ──────────────────────────────────────────────────

describe('applyMessage step 11: result branch (freeze draft, sweep, clear liveTurn, clear sending placeholders)', () => {
  it('clears liveTurn and clears sending placeholders on a result frame', () => {
    let state = withPlaceholders(freshState(), [
      placeholderItem('optimistic:1', 'unanswered'),
    ])
    state = applyMessage(state, resultMsg('r-end'))
    expect(state.mirror.liveTurn).toBeNull()
    // clearSendingPlaceholders ran in the result branch.
    expect(state.intent.pendingPlaceholders.size).toBe(0)
  })

  it('freezes a still-live draft as an interrupted partial (no supersede)', () => {
    let state = freshState()
    state = applyMessage(state, streamEventMsg('se-1', 'half'))
    state = { ...state, mirror: flushLiveTurn(state.mirror) }
    expect(state.mirror.draft).not.toBeNull()
    state = applyMessage(state, resultMsg('r-end'))
    expect(state.mirror.draft).toBeNull()
    expect(state.mirror.frozenDrafts).toHaveLength(1)
  })

  it('sweeps a stranded running subagent to interrupted at the result frame', () => {
    let state = freshState()
    state = applyMessage(state, toolUseMsg('a-agent', 'tu_agent', 'Agent'))
    expect(state.mirror.activeSubagents.get('tu_agent')?.status).toBe('running')
    state = applyMessage(state, resultMsg('r-end'))
    expect(state.mirror.activeSubagents.get('tu_agent')?.status).toBe('interrupted')
  })
})

// ── Step 12: trimFront ──────────────────────────────────────────────────────

describe('applyMessage step 12: trimFront (result branch → trim ordering)', () => {
  it('keeps the transcript bounded once it exceeds CAP + slack (trim fires inside applyMessage)', () => {
    // Order pinning: trim (step 12) runs AFTER the result/append branches,
    // INSIDE the same applyMessage call. So once the transcript crosses
    // CAP + SLACK, the very call that crosses it also trims back to ~CAP,
    // and every subsequent append stays bounded (one trim per overflow).
    let state = freshState()
    const padCount = MEMORY_ITEM_CAP + 300
    for (let i = 0; i < padCount; i++) {
      state = applyMessage(state, asstMsg(`pad-${i}`, `n${i}`, i + 1))
    }
    // The transcript never grows unboundedly: trim keeps it within CAP +
    // SLACK of the steady-state ~CAP. After 1300 appends it's well under
    // CAP + SLACK (the alternative — no trim — would leave 1300 items).
    expect(state.mirror.items.length).toBeLessThan(MEMORY_ITEM_CAP + 300)
    expect(state.mirror.items.length).toBeGreaterThanOrEqual(MEMORY_ITEM_CAP)
    // The OLDEST items are gone (front-trimmed); the tail retains the most
    // recent pad-${i} uuids.
    expect(state.mirror.items[0].id).not.toBe('pad-0')
    expect(state.mirror.items[state.mirror.items.length - 1].id).toBe(`pad-${padCount - 1}`)
  })
})

// ── Step 13: refusal-fallback / supersedes eviction ─────────────────────────

describe('applyMessage step 13: refusal-fallback / supersedes eviction (trim → eviction ordering)', () => {
  it('evicts retracted_message_uuids on a model_refusal_fallback frame', () => {
    let state = freshState()
    state = applyMessage(state, userMsg('u-1', 'hi'))
    state = applyMessage(state, asstMsg('a-1', 'refused partial'))
    state = applyMessage(state, asstMsg('a-2', 'more partial'))
    expect(ids(state)).toEqual(['u-1', 'a-1', 'a-2'])
    state = applyMessage(state, {
      type: 'system',
      subtype: 'model_refusal_fallback',
      uuid: 'mrf-1',
      retracted_message_uuids: ['a-1', 'a-2'],
      content: 'refused; retrying',
    } as unknown as SdkMessage)
    // The refused leg is gone; the fallback notice stays as the canonical record.
    expect(ids(state)).toEqual(['u-1', 'mrf-1'])
  })

  it('evicts supersedes uuids on a replacement assistant frame', () => {
    let state = freshState()
    state = applyMessage(state, userMsg('u-1', 'hi'))
    state = applyMessage(state, asstMsg('a-1', 'refused partial'))
    state = applyMessage(state, {
      type: 'assistant',
      uuid: 'a-2',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'replacement' }] },
      supersedes: ['a-1'],
    } as unknown as SdkMessage)
    expect(ids(state)).toEqual(['u-1', 'a-2'])
  })
})

// ── end-to-end ordering ─────────────────────────────────────────────────────

describe('applyMessage end-to-end ordering (FIFO → effectiveConsumedAt → append → indexes → cleanup)', () => {
  it('forwards a placeholder consumedAt through the full pipeline onto the appended item', () => {
    // One placeholder acked+consumed before its echo. The echo must:
    //   step 1 — FIFO consume the placeholder (carrying its consumedAt)
    //   step 2 — effectiveConsumedAt = placeholderConsumedAt
    //   step 5 — append the item with consumedAt stamped
    //   step 6 — index the new user tool_result/seed
    //   step 10 — no pendingConsumedMessages entry to clean (ack cleared it)
    let state = withPlaceholders(freshState(), [
      placeholderItem('optimistic:1', 'hello', /* consumedAt */ 777),
    ])
    state = applyMessage(state, userMsg('server-1', 'hello'))
    const appended = state.mirror.items[state.mirror.items.length - 1]
    expect(appended.id).toBe('server-1')
    expect(appended.msg.consumedAt).toBe(777)
    expect(appended.deliveryStatus).toBe('consumed')
    // Placeholder is gone from intent.
    expect(state.intent.pendingPlaceholders.size).toBe(0)
  })
})
