import { describe, it, expect } from 'vitest'
import { paginateJsonl, turnAnchorsFromJsonl } from './history-reader.js'

// Build a JSONL transcript string from line objects.
function jsonl(lines: Array<Record<string, unknown>>): string {
  return lines.map((l) => JSON.stringify(l)).join('\n')
}

const SID = 'sess-1'

describe('paginateJsonl — filtering', () => {
  it('keeps user/assistant and drops attachment/last-prompt/ai-title/queue-operation', () => {
    const raw = jsonl([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } },
      { type: 'attachment', uuid: 'a1', attachment: {} },
      { type: 'assistant', uuid: 'as1', message: { role: 'assistant', content: [] } },
      { type: 'last-prompt', lastPrompt: 'x' },
      { type: 'ai-title', aiTitle: 'T' },
      { type: 'queue-operation', operation: 'add' },
    ])
    const page = paginateJsonl(raw, SID, { limit: 100 })
    expect(page.totalCount).toBe(2)
    expect((page.messages as Array<{ uuid: string }>).map((m) => m.uuid)).toEqual(['u1', 'as1'])
  })

  it('drops isMeta and isSidechain lines', () => {
    const raw = jsonl([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'real' } },
      { type: 'user', uuid: 'm1', isMeta: true, message: { role: 'user', content: 'meta' } },
      { type: 'assistant', uuid: 's1', isSidechain: true, message: { role: 'assistant', content: [] } },
    ])
    const page = paginateJsonl(raw, SID, { limit: 100 })
    expect(page.totalCount).toBe(1)
    expect((page.messages[0] as { uuid: string }).uuid).toBe('u1')
  })

  it('drops the SDK interrupt placeholder (string and text-block forms)', () => {
    const raw = jsonl([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'real prompt' } },
      { type: 'user', uuid: 'i1', message: { role: 'user', content: '[Request interrupted by user]' } },
      { type: 'user', uuid: 'i2', message: { role: 'user', content: '[Request interrupted by user for tool use]' } },
      {
        type: 'user',
        uuid: 'i3',
        message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      },
      { type: 'assistant', uuid: 'as1', message: { role: 'assistant', content: [] } },
    ])
    const page = paginateJsonl(raw, SID, { limit: 100 })
    expect((page.messages as Array<{ uuid: string }>).map((m) => m.uuid)).toEqual(['u1', 'as1'])
  })

  it('keeps a real user message that merely mentions the interrupt text inline', () => {
    const raw = jsonl([
      {
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: 'why does [Request interrupted by user] show up?' },
      },
    ])
    const page = paginateJsonl(raw, SID, { limit: 100 })
    expect(page.totalCount).toBe(1)
    expect((page.messages[0] as { uuid: string }).uuid).toBe('u1')
  })

  it('keeps only error/compact_boundary/api_retry system subtypes', () => {
    const raw = jsonl([
      { type: 'system', subtype: 'error', uuid: 'e1' },
      { type: 'system', subtype: 'compact_boundary', uuid: 'c1' },
      { type: 'system', subtype: 'api_retry', uuid: 'r1' },
      { type: 'system', subtype: 'init', uuid: 'i1' },
      { type: 'system', subtype: 'status', uuid: 'st1' },
    ])
    const page = paginateJsonl(raw, SID, { limit: 100 })
    expect((page.messages as Array<{ uuid: string }>).map((m) => m.uuid)).toEqual(['e1', 'c1', 'r1'])
  })

  it('tolerates blank lines and corrupt rows', () => {
    const raw = [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'a' } }),
      '',
      '{ not valid json',
      JSON.stringify({ type: 'assistant', uuid: 'as1', message: { role: 'assistant', content: [] } }),
    ].join('\n')
    const page = paginateJsonl(raw, SID, { limit: 100 })
    expect(page.totalCount).toBe(2)
  })
})

describe('paginateJsonl — normalization', () => {
  it('sets parent_tool_use_id to the tool_use_id for tool_result user lines', () => {
    const raw = jsonl([
      {
        type: 'user',
        uuid: 'tr1',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-42', content: 'ok' }] },
      },
    ])
    const page = paginateJsonl(raw, SID, { limit: 100 })
    expect((page.messages[0] as { parent_tool_use_id: string }).parent_tool_use_id).toBe('tool-42')
  })

  it('sets parent_tool_use_id null for real prompts and assistants', () => {
    const raw = jsonl([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'plain prompt' } },
      { type: 'assistant', uuid: 'as1', message: { role: 'assistant', content: [] } },
    ])
    const page = paginateJsonl(raw, SID, { limit: 100 })
    const msgs = page.messages as Array<{ parent_tool_use_id: string | null }>
    expect(msgs[0].parent_tool_use_id).toBeNull()
    expect(msgs[1].parent_tool_use_id).toBeNull()
  })

  it('falls back to the sessionId arg when the line has no session id', () => {
    const raw = jsonl([{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'x' } }])
    const page = paginateJsonl(raw, SID, { limit: 100 })
    expect((page.messages[0] as { session_id: string }).session_id).toBe(SID)
  })

  it('carries receivedAt from the on-disk timestamp so history shows its time', () => {
    const raw = jsonl([
      { type: 'user', uuid: 'u1', timestamp: '2026-06-24T08:34:19.057Z', message: { role: 'user', content: 'x' } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-06-24T08:34:23.548Z', message: { role: 'assistant', content: [] } },
    ])
    const page = paginateJsonl(raw, SID, { limit: 100 })
    const [u, a] = page.messages as Array<{ receivedAt?: number; consumedAt?: number; restoredFromDisk?: boolean }>
    expect(u.restoredFromDisk).toBe(true)
    expect(a.restoredFromDisk).toBe(true)
    expect(u.receivedAt).toBe(Date.parse('2026-06-24T08:34:19.057Z'))
    // A top-level prompt on disk was already consumed by the SDK — stamp
    // consumedAt so it isn't mislabelled 'queued'.
    expect(u.consumedAt).toBe(u.receivedAt)
    expect(a.receivedAt).toBe(Date.parse('2026-06-24T08:34:23.548Z'))
    expect(a.consumedAt).toBeUndefined()
  })

  it('omits receivedAt when the disk line has no timestamp', () => {
    const raw = jsonl([{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'x' } }])
    const page = paginateJsonl(raw, SID, { limit: 100 })
    expect('receivedAt' in (page.messages[0] as object)).toBe(false)
  })

  it('passes top-level payloads through for permission_denied / informational / model_refusal_fallback lines', () => {
    const raw = jsonl([
      {
        type: 'system', subtype: 'permission_denied', uuid: 'pd1',
        tool_name: 'Bash', tool_use_id: 'tu1', decision_reason_type: 'rule',
        decision_reason: 'denied by settings', message: 'Bash is not allowed',
      },
      {
        type: 'system', subtype: 'informational', uuid: 'inf1',
        content: 'hook blocked the prompt', level: 'warning', prevent_continuation: true,
      },
      {
        type: 'system', subtype: 'model_refusal_fallback', uuid: 'mrf1',
        trigger: 'refusal', direction: 'retry',
        original_model: 'claude-opus-5', fallback_model: 'claude-sonnet-5',
        retracted_message_uuids: ['u1', 'u2'], content: 'refused; retrying',
      },
    ])
    const page = paginateJsonl(raw, SID, { limit: 100 })
    expect(page.messages).toHaveLength(3)
    expect(page.messages[0]).toMatchObject({
      type: 'system', subtype: 'permission_denied', tool_name: 'Bash',
      decision_reason_type: 'rule', decision_reason: 'denied by settings',
      message: 'Bash is not allowed',
    })
    expect(page.messages[1]).toMatchObject({
      type: 'system', subtype: 'informational',
      content: 'hook blocked the prompt', level: 'warning', prevent_continuation: true,
    })
    expect(page.messages[2]).toMatchObject({
      type: 'system', subtype: 'model_refusal_fallback',
      original_model: 'claude-opus-5', fallback_model: 'claude-sonnet-5',
      retracted_message_uuids: ['u1', 'u2'],
    })
  })

  it('drops malformed top-level payload values (wrong shape) instead of passing them through', () => {
    const raw = jsonl([
      {
        type: 'system', subtype: 'model_refusal_fallback', uuid: 'mrf1',
        original_model: { nested: true }, retracted_message_uuids: [1, 2], content: { x: 1 },
      },
    ])
    const page = paginateJsonl(raw, SID, { limit: 100 })
    // The frame itself survives (renderable) but the malformed fields don't.
    expect(page.messages).toHaveLength(1)
    const m = page.messages[0] as Record<string, unknown>
    expect('original_model' in m).toBe(false)
    expect('retracted_message_uuids' in m).toBe(false)
    expect('content' in m).toBe(false)
  })

  it('renders tool_use_summary lines and carries their summary; skips tool_progress', () => {
    const raw = jsonl([
      { type: 'tool_use_summary', uuid: 'tus1', summary: 'ran 3 searches', preceding_tool_use_ids: ['a', 'b'] },
      { type: 'tool_progress', uuid: 'tp1', tool_use_id: 'tu1', tool_name: 'Bash', elapsed_time_seconds: 3 },
    ])
    const page = paginateJsonl(raw, SID, { limit: 100 })
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0]).toMatchObject({
      type: 'tool_use_summary', summary: 'ran 3 searches', preceding_tool_use_ids: ['a', 'b'],
    })
  })

  it('carries assistant supersedes through so disk replay evicts the refused leg', () => {
    const raw = jsonl([
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [] }, supersedes: ['x1', 'x2'] },
    ])
    const page = paginateJsonl(raw, SID, { limit: 100 })
    expect(page.messages[0]).toMatchObject({ type: 'assistant', supersedes: ['x1', 'x2'] })
  })
})

describe('paginateJsonl — pagination', () => {
  // 5 renderable messages: indices 0..4
  const raw = jsonl([
    { type: 'user', uuid: 'u0', message: { role: 'user', content: '0' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [] } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: '2' } },
    { type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: [] } },
    { type: 'user', uuid: 'u4', message: { role: 'user', content: '4' } },
  ])

  it('returns the newest page by default and reports hasMore', () => {
    const page = paginateJsonl(raw, SID, { limit: 2 })
    expect(page.totalCount).toBe(5)
    expect(page.startIndex).toBe(3)
    expect(page.hasMore).toBe(true)
    expect((page.messages as Array<{ uuid: string }>).map((m) => m.uuid)).toEqual(['a3', 'u4'])
  })

  it('pages backwards via `before` (previous startIndex)', () => {
    const first = paginateJsonl(raw, SID, { limit: 2 }) // startIndex 3
    const second = paginateJsonl(raw, SID, { limit: 2, before: first.startIndex })
    expect(second.startIndex).toBe(1)
    expect(second.hasMore).toBe(true)
    expect((second.messages as Array<{ uuid: string }>).map((m) => m.uuid)).toEqual(['a1', 'u2'])
    const third = paginateJsonl(raw, SID, { limit: 2, before: second.startIndex })
    expect(third.startIndex).toBe(0)
    expect(third.hasMore).toBe(false)
    expect((third.messages as Array<{ uuid: string }>).map((m) => m.uuid)).toEqual(['u0'])
  })

  it('anchors on beforeUuid (page strictly before that message)', () => {
    const page = paginateJsonl(raw, SID, { limit: 10, beforeUuid: 'a3' })
    // a3 is index 3 → return [0,3): u0,a1,u2
    expect((page.messages as Array<{ uuid: string }>).map((m) => m.uuid)).toEqual(['u0', 'a1', 'u2'])
    expect(page.hasMore).toBe(false)
  })

  it('falls back to newest page when beforeUuid is not found', () => {
    const page = paginateJsonl(raw, SID, { limit: 2, beforeUuid: 'does-not-exist' })
    expect(page.startIndex).toBe(3)
    expect((page.messages as Array<{ uuid: string }>).map((m) => m.uuid)).toEqual(['a3', 'u4'])
  })

  it('drops rows before a raw afterUuid boundary', () => {
    const withClear = jsonl([
      { type: 'user', uuid: 'u0', message: { role: 'user', content: 'before' } },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [] } },
      { type: 'system', subtype: 'init', uuid: 'clear-init' },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: 'after' } },
      { type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: [] } },
    ])
    const page = paginateJsonl(withClear, SID, { limit: 10, afterUuid: 'clear-init' })
    expect(page.totalCount).toBe(2)
    expect(page.hasMore).toBe(false)
    expect((page.messages as Array<{ uuid: string }>).map((m) => m.uuid)).toEqual(['u2', 'a3'])
  })

  it('clamps limit and handles empty transcript', () => {
    expect(paginateJsonl('', SID, { limit: 100 })).toEqual({
      messages: [],
      totalCount: 0,
      startIndex: 0,
      hasMore: false,
    })
  })
})

describe('historyEntriesFromJsonl', () => {
  it('returns chronological renderable entries with indexes after clear boundary', async () => {
    const { historyEntriesFromJsonl } = await import('./history-reader.js')
    const raw = jsonl([
      { type: 'user', uuid: 'before', message: { role: 'user', content: 'before' } },
      { type: 'system', subtype: 'init', uuid: 'clear-init' },
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'find me' } },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
    ])

    const entries = historyEntriesFromJsonl(raw, SID, { afterUuid: 'clear-init' })
    expect(entries.map((entry) => entry.index)).toEqual([0, 1])
    expect(entries.map((entry) => (entry.message as { uuid: string }).uuid)).toEqual(['u1', 'a1'])
  })
})

describe('turnAnchorsFromJsonl — backfill from disk', () => {
  it('keeps success-turn last frames (stop_reason !== tool_use, no error)', () => {
    const raw = jsonl([
      // turn 1: user → assistant(end_turn) — a legal anchor.
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'reply' }] } },
      // turn 2: user → assistant(tool_use) → assistant(tool_use) → assistant(end_turn)
      // Only the LAST (end_turn) is a turn anchor; the tool_use frames are mid-turn.
      { type: 'user', uuid: 'u2', message: { role: 'user', content: 'two' } },
      { type: 'assistant', uuid: 'a2-tool1', timestamp: '2026-01-01T00:01:00Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } },
      { type: 'assistant', uuid: 'a2-tool2', timestamp: '2026-01-01T00:01:30Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Read' }] } },
      { type: 'assistant', uuid: 'a2', timestamp: '2026-01-01T00:02:00Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
    ])
    const anchors = turnAnchorsFromJsonl(raw)
    expect(anchors.map((a) => a.assistantUuid)).toEqual(['a1', 'a2'])
    expect(anchors[0].completedAt).toBe(Date.parse('2026-01-01T00:00:00Z'))
  })

  it('excludes failed turns (error / isApiErrorMessage)', () => {
    const raw = jsonl([
      // A success turn.
      { type: 'assistant', uuid: 'ok', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [] } },
      // A failed turn (API error) — NOT a legal anchor.
      { type: 'assistant', uuid: 'err1', timestamp: '2026-01-01T00:01:00Z', isApiErrorMessage: true, error: 'server_error', message: { role: 'assistant', stop_reason: 'stop_sequence', content: [] } },
      // Another failed turn with an explicit error field.
      { type: 'assistant', uuid: 'err2', timestamp: '2026-01-01T00:02:00Z', error: 'unknown', message: { role: 'assistant', stop_reason: 'end_turn', content: [] } },
    ])
    const anchors = turnAnchorsFromJsonl(raw)
    expect(anchors.map((a) => a.assistantUuid)).toEqual(['ok'])
  })

  it('excludes sidechain (subagent) assistant frames', () => {
    const raw = jsonl([
      { type: 'assistant', uuid: 'main', timestamp: '2026-01-01T00:00:00Z', isSidechain: false, message: { role: 'assistant', stop_reason: 'end_turn', content: [] } },
      // Subagent inner stream — must not be an anchor.
      { type: 'assistant', uuid: 'sub', timestamp: '2026-01-01T00:00:30Z', isSidechain: true, message: { role: 'assistant', stop_reason: 'end_turn', content: [] } },
    ])
    const anchors = turnAnchorsFromJsonl(raw)
    expect(anchors.map((a) => a.assistantUuid)).toEqual(['main'])
  })

  it('excludes (none) stop_reason frames that are tool-use-only (older SDK mid-turn calls)', () => {
    // Older SDK versions didn't write stop_reason on tool-call frames.
    // Such a frame has content = [tool_use] only (no text/thinking) and
    // must NOT be treated as a turn end — cutting there orphans the result.
    const raw = jsonl([
      // A real turn end (text + end_turn).
      { type: 'assistant', uuid: 'end', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
      // Mid-turn tool call, no stop_reason, tool_use-only content — excluded.
      { type: 'assistant', uuid: 'tool-only', timestamp: '2026-01-01T00:00:30Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } },
      // (none) with text content — kept (a real turn end missing the flag).
      { type: 'assistant', uuid: 'text-only', timestamp: '2026-01-01T00:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
      // (none) with mixed text + tool_use — kept (text present → not tool-only).
      { type: 'assistant', uuid: 'mixed', timestamp: '2026-01-01T00:02:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Read' }] } },
    ])
    const anchors = turnAnchorsFromJsonl(raw)
    expect(anchors.map((a) => a.assistantUuid)).toEqual(['end', 'text-only', 'mixed'])
  })

  it('includes stop_sequence and (none) stop_reasons as turn ends', () => {
    const raw = jsonl([
      { type: 'assistant', uuid: 'seq', timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', stop_reason: 'stop_sequence', content: [] } },
      { type: 'assistant', uuid: 'none', timestamp: '2026-01-01T00:01:00Z', message: { role: 'assistant', content: [] } },
    ])
    const anchors = turnAnchorsFromJsonl(raw)
    expect(anchors.map((a) => a.assistantUuid)).toEqual(['seq', 'none'])
  })

  it('falls back to Date.now() for completedAt when timestamp is missing', () => {
    const before = Date.now()
    const raw = jsonl([
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', stop_reason: 'end_turn', content: [] } },
    ])
    const anchors = turnAnchorsFromJsonl(raw)
    const after = Date.now()
    expect(anchors).toHaveLength(1)
    expect(anchors[0].completedAt).toBeGreaterThanOrEqual(before)
    expect(anchors[0].completedAt).toBeLessThanOrEqual(after)
  })

  it('returns empty for an empty transcript', () => {
    expect(turnAnchorsFromJsonl('')).toEqual([])
  })
})
