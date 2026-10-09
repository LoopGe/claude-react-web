import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageSearchHit } from '../../shared/search-results.js'
import type { HistoryPage } from '../history-reader.js'
import {
  HISTORY_READ_ONLY_TOOLS,
  HISTORY_TOOLS_SERVER_NAME,
  buildHistoryToolDefs,
  createHistoryTools,
  formatTranscriptMessage,
  type HistoryHost,
} from './history-tools.js'

const host = vi.hoisted(() => ({
  list: vi.fn(),
  searchMessages: vi.fn(),
  getHistoryPage: vi.fn(),
}))

function buildDefs(cwd: string | null = '/repo') {
  return buildHistoryToolDefs(host as unknown as HistoryHost, cwd)
}

function callTool(name: string, input: unknown, cwd: string | null = '/repo') {
  const def = buildDefs(cwd).find((t) => t.name === name)
  if (!def) throw new Error(`no such tool: ${name}`)
  return def.handler(input as never, undefined)
}

const firstText = (r: { content?: Array<{ type: string; text?: string }> }) =>
  r.content?.find((c) => c.type === 'text')?.text ?? ''

function hit(over: Partial<MessageSearchHit> = {}): MessageSearchHit {
  return {
    id: 's1:uuid1',
    sessionId: 's1',
    sessionTitle: 'Fix login bug',
    cwd: '/repo',
    messageUuid: 'uuid1',
    messageIndex: 4,
    messageType: 'assistant',
    snippet: '…the fix was to…',
    matchCount: 2,
    matchOrdinal: 0,
    lastModified: 1000,
    ...over,
  }
}

function page(over: Partial<HistoryPage> = {}): HistoryPage {
  return { messages: [], totalCount: 0, startIndex: 0, hasMore: false, ...over }
}

beforeEach(() => {
  vi.clearAllMocks()
  host.searchMessages.mockResolvedValue([])
  host.list.mockReturnValue([])
  host.getHistoryPage.mockResolvedValue(page())
})

describe('history_search', () => {
  it('passes query / sessionId / limit through and slims the hits', async () => {
    host.searchMessages.mockResolvedValue([hit()])
    const r = await callTool('history_search', { query: 'the fix', sessionId: 's1', limit: 5 })
    expect(host.searchMessages).toHaveBeenCalledWith('the fix', { limit: 5, sessionId: 's1', cwd: undefined })
    const parsed = JSON.parse(firstText(r))
    expect(parsed.hitCount).toBe(1)
    expect(parsed.hits[0]).toMatchObject({ sessionId: 's1', messageIndex: 4, snippet: '…the fix was to…' })
    // internal fields dropped
    expect(parsed.hits[0].matchOrdinal).toBeUndefined()
    expect(parsed.hits[0].id).toBeUndefined()
  })

  it('maps sameCwdOnly to the cwd filter bound from the calling session', async () => {
    await callTool('history_search', { query: 'the fix', sameCwdOnly: true })
    expect(host.searchMessages).toHaveBeenCalledWith('the fix', { limit: undefined, sessionId: undefined, cwd: '/repo' })
  })

  it('errors loudly when sameCwdOnly is requested but the session has no cwd', async () => {
    const r = await callTool('history_search', { query: 'the fix', sameCwdOnly: true }, null)
    expect(r.isError).toBe(true)
    expect(firstText(r)).toContain('sameCwdOnly requires this session to have a cwd')
    expect(host.searchMessages).not.toHaveBeenCalled()
  })
})

describe('history_read_context', () => {
  it('resolves the window with one sliceWindow-shaped page call and marks the hit', async () => {
    // 100-message transcript; hit at index 50, window ±2. The fake page
    // mirrors history-reader's sliceWindow: end = min(before, total),
    // start = max(0, end - limit).
    const msgs = Array.from({ length: 5 }, (_, i) =>
      i === 2
        ? { type: 'user', message: { role: 'user', content: 'the actual hit' } }
        : { type: 'user', message: { role: 'user', content: `msg ${i}` } },
    )
    host.getHistoryPage.mockImplementation(async (_id: string, opts: { before?: number; limit: number }) => {
      expect(opts.before).toBe(50 + 2 + 1)
      expect(opts.limit).toBe(2 + 2 + 1)
      const end = Math.max(0, Math.min(opts.before!, 100))
      const start = Math.max(0, end - opts.limit)
      return page({ messages: msgs, totalCount: 100, startIndex: start, hasMore: start > 0 })
    })
    const r = await callTool('history_read_context', { sessionId: 's1', messageIndex: 50, beforeCount: 2, afterCount: 2 })
    expect(r.isError).toBeUndefined()
    const text = firstText(r)
    expect(text).toContain('messages 48–52 of 100')
    expect(text).toContain('>>> [user] the actual hit')
    expect(text).toContain('[user] msg 0')
    expect(text).toContain('[user] msg 4')
  })

  it('defaults the window to ±10 and renders tool blocks inline (capped, thinking skipped)', async () => {
    host.getHistoryPage.mockResolvedValue(
      page({
        totalCount: 3,
        startIndex: 0,
        messages: [
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'running it' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
          { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'ECONNREFUSED 429 at upstream' }] }] } },
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'done' }] } },
        ],
      }),
    )
    const r = await callTool('history_read_context', { sessionId: 's1', messageIndex: 1 })
    expect(host.getHistoryPage).toHaveBeenCalledWith('s1', { before: 12, limit: 21 })
    const text = firstText(r)
    expect(text).toContain('[tool_use: Bash] {"command":"npm test"}')
    // tool_result TEXT is searchable (shared/search/extract.ts) — the read-back
    // must surface it, or the search→read workflow drops the matched body.
    expect(text).toContain('[tool_result] ECONNREFUSED 429 at upstream')
    expect(text).toContain('[assistant] done')
    expect(text).not.toContain('hidden')
  })

  it('flags a stale hit index outside the served window without a nonsense range', async () => {
    // Fully empty page (e.g. the session was cleared since the search) — the
    // old header rendered `messages 0–-1 of 0`.
    host.getHistoryPage.mockResolvedValue(page({ totalCount: 0, startIndex: 0, messages: [] }))
    const r = await callTool('history_read_context', { sessionId: 's1', messageIndex: 40 })
    const text = firstText(r)
    expect(text).toContain('requested message outside window')
    expect(text).toContain('messages 0 of 0')
    expect(text).not.toContain('-1')
  })

  it('emits the hit line first and never truncates it away on a full window', async () => {
    const filler = 'y'.repeat(2000)
    const msgs = Array.from({ length: 12 }, (_, i) =>
      i === 11
        ? { type: 'user', message: { role: 'user', content: 'THE PRECISE HIT' } }
        : { type: 'user', message: { role: 'user', content: `${filler} ${i}` } },
    )
    host.getHistoryPage.mockResolvedValue(page({ totalCount: 12, startIndex: 0, messages: msgs }))
    const r = await callTool('history_read_context', { sessionId: 's1', messageIndex: 11 })
    const text = firstText(r)
    expect(text).toContain('>>> [user] THE PRECISE HIT')
    expect(text).toContain('… output truncated at')
  })

  it('surfaces host errors as isError text results, never a rejection', async () => {
    host.getHistoryPage.mockRejectedValue(new Error('session not found'))
    const r = await callTool('history_read_context', { sessionId: 'nope', messageIndex: 0 })
    expect(r.isError).toBe(true)
    expect(firstText(r)).toContain('session not found')
  })
})

describe('history_list_sessions', () => {
  it('projects, filters by cwd, sorts by recency and caps', async () => {
    host.list.mockReturnValue([
      { id: 'old', title: 'Old', cwd: '/repo', provider: 'claude', model: 'm', lastTurnAt: 10, lastActivityAt: 99, messageCount: 3 },
      { id: 'new', title: 'New', cwd: '/other', provider: 'claude', lastActivityAt: 500, messageCount: 7 },
      { id: 'mid', cwd: '/repo', lastTurnAt: 100, lastActivityAt: 100, messageCount: 1 },
    ])
    const r = await callTool('history_list_sessions', { cwd: '/repo', limit: 1 })
    const parsed = JSON.parse(firstText(r))
    expect(parsed.count).toBe(1)
    expect(parsed.sessions[0]).toMatchObject({ id: 'mid', lastActivityAt: 100 })
    expect(parsed.sessions[0].messageCount).toBeDefined()
    expect(parsed.sessions[0].lastTurnAt).toBeUndefined()
  })

  it('sameCwdOnly filters against the bound cwd', async () => {
    host.list.mockReturnValue([
      { id: 'in', cwd: '/repo', lastActivityAt: 1, messageCount: 0 },
      { id: 'out', cwd: '/other', lastActivityAt: 2, messageCount: 0 },
    ])
    const r = await callTool('history_list_sessions', { sameCwdOnly: true })
    const parsed = JSON.parse(firstText(r))
    expect(parsed.sessions.map((s: { id: string }) => s.id)).toEqual(['in'])
  })

  it('an explicit cwd answers the query even when the session has no cwd (no requireCwd throw)', async () => {
    host.list.mockReturnValue([{ id: 'in', cwd: '/anywhere', lastActivityAt: 1, messageCount: 0 }])
    const r = await callTool('history_list_sessions', { cwd: '/anywhere', sameCwdOnly: true }, null)
    expect(r.isError).toBeUndefined()
    const parsed = JSON.parse(firstText(r))
    expect(parsed.sessions.map((s: { id: string }) => s.id)).toEqual(['in'])
  })

  it('sameCwdOnly on a cwd-less session with no explicit cwd errors loudly', async () => {
    const r = await callTool('history_list_sessions', { sameCwdOnly: true }, null)
    expect(r.isError).toBe(true)
    expect(firstText(r)).toContain('sameCwdOnly requires this session to have a cwd')
  })
})

describe('formatTranscriptMessage', () => {
  it('returns null for thinking-only / empty / non-object messages', () => {
    expect(formatTranscriptMessage(null)).toBeNull()
    expect(formatTranscriptMessage({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking' }] } })).toBeNull()
    expect(formatTranscriptMessage({ type: 'assistant' })).toBeNull()
  })

  it('truncates very long bodies', () => {
    const long = 'x'.repeat(3000)
    const out = formatTranscriptMessage({ type: 'user', message: { role: 'user', content: long } })
    expect(out).toContain('(+' )
    expect(out!.length).toBeLessThan(2100)
  })
})

describe('server surface', () => {
  it('declares exactly the 3 read tools read-only, annotated, requiresCwd:false', () => {
    expect([...HISTORY_READ_ONLY_TOOLS].sort()).toEqual(['history_list_sessions', 'history_read_context', 'history_search'])
    const server = createHistoryTools(host as unknown as HistoryHost)
    expect(server.name).toBe(HISTORY_TOOLS_SERVER_NAME)
    expect(server.requiresCwd).toBe(false)
    expect(server.defaultEnabled).toBe(true)
    const tools = buildHistoryToolDefs(host as unknown as HistoryHost, null)
    expect(tools.map((t) => t.name)).toEqual(['history_search', 'history_read_context', 'history_list_sessions'])
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true)
    // metadata path (listToolDefs) builds with cwd=null without touching handlers
    expect(tools).toHaveLength(3)
  })
})
