/**
 * Per-session transcript search index.
 *
 * Built from the transcript seq store (via the manager's window reads), not
 * the on-disk JSONL: every row carries an append-stable seq, so a hit can be
 * jumped to without another uuid→index lookup. Rows are the messages the main
 * transcript can render: sidechain frames are excluded, hidden frames are
 * excluded, and a tool_result stays attached to its owning tool_use's seq.
 *
 * The index is incremental: each session keeps a `lastIndexedSeq` watermark
 * and only reads messages above it on subsequent queries. A generation change
 * (`/clear`) invalidates the cache and triggers a full rebuild.
 */
import { countMatches } from '../shared/search/match.js'
import { extractMessagePlainText } from '../shared/search/extract.js'
import { shouldHideByDefault } from '../shared/message-visibility.js'
import { userMessageHasToolResult } from '../shared/user-frames.js'
import type { TranscriptPageMessage, TranscriptPageResponse } from '../shared/transcript-page.js'
import type {
  SessionSearchHit,
  SessionSearchResponse,
  SessionSearchRole,
} from '../shared/session-search.js'
import type { SeqMessage } from './transcript-store.js'

export interface SessionSearchDeps {
  getWindow(id: string, before?: number, limit?: number): Promise<TranscriptPageResponse>
  getAfter(
    id: string,
    afterSeq: number,
    limit: number,
  ): Promise<{ generation: number; headSeq: number; totalCount: number; messages: SeqMessage[] }>
  isDegraded(id: string): Promise<boolean>
  /** Bumped by transcript evictions; a change invalidates the cached rows. */
  getTombstoneEpoch(id: string): Promise<number>
}

export interface SessionSearchIndex {
  search(id: string, query: string, limit: number): Promise<SessionSearchResponse>
}

interface Row {
  seq: number
  messageSeq: number
  uuid: string | null
  role: SessionSearchRole
  text: string
  turnSeq: number
  turnNo: number
  turnPrompt: string
  ownerToolUseId?: string
  timestamp?: number
}

interface TurnState {
  turnNo: number
  turnSeq: number
  turnPrompt: string
}

interface IndexState {
  rows: Row[]
  turn: TurnState
  toolUseSeq: Map<string, number>
  generation: number
  headSeq: number
  lastIndexedSeq: number
  tombstoneEpoch: number
}

interface LooseMessage {
  type?: string
  subtype?: string
  uuid?: string
  parent_tool_use_id?: string | null
  receivedAt?: number
  timestamp?: string
  message?: { content?: unknown }
}

const TURN_PROMPT_MAX = 80
const SNIPPET_MAX = 180
const PAGE_SIZE = 1000
const MAX_SESSIONS = 4

function buildSnippet(text: string, query: string): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX - 3).trimEnd()}...` : text
  const start = Math.max(0, idx - 40)
  const end = Math.min(text.length, idx + query.length + 80)
  let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim()
  if (start > 0) snippet = `...${snippet}`
  if (end < text.length) snippet = `${snippet}...`
  return snippet.length > SNIPPET_MAX ? `${snippet.slice(0, SNIPPET_MAX - 3)}...` : snippet
}

function turnPromptOf(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > TURN_PROMPT_MAX ? `${oneLine.slice(0, TURN_PROMPT_MAX - 1)}…` : oneLine
}

function timestampOf(msg: LooseMessage): number | undefined {
  if (typeof msg.receivedAt === 'number' && Number.isFinite(msg.receivedAt)) return msg.receivedAt
  if (typeof msg.timestamp === 'string') {
    const t = Date.parse(msg.timestamp)
    if (Number.isFinite(t)) return t
  }
  return undefined
}

function blocksOf(msg: LooseMessage): Array<Record<string, unknown>> {
  const content = msg.message?.content
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []
}

/** True when the frame is a real top-level user prompt: the same shape the
 *  queued-turn counter treats as host input (not a tool_result, not a hidden
 *  injection / local-command log). */
function isRealUserPrompt(msg: LooseMessage): boolean {
  if (msg.type !== 'user') return false
  if (msg.parent_tool_use_id != null) return false
  if (userMessageHasToolResult(msg)) return false
  if (shouldHideByDefault(msg)) return false
  return true
}

function emptyState(): IndexState {
  return {
    rows: [],
    turn: { turnNo: 0, turnSeq: 0, turnPrompt: 'Session start' },
    toolUseSeq: new Map(),
    generation: 0,
    headSeq: 0,
    lastIndexedSeq: -1,
    tombstoneEpoch: 0,
  }
}

/** Consume a chronological slice into the index state. Mutates state. */
function consume(state: IndexState, messages: readonly TranscriptPageMessage[]): void {
  for (const entry of messages) {
    state.lastIndexedSeq = entry.seq
    const msg = entry.msg as LooseMessage
    const isToolResult = msg.type === 'user' && userMessageHasToolResult(msg)
    if (msg.type !== 'user' && msg.type !== 'assistant') continue
    if (shouldHideByDefault(msg)) continue
    if (msg.parent_tool_use_id != null && !isToolResult) continue

    // Register tool_use ids before their results land. This must run even for
    // a tool-only assistant row whose text extraction is empty.
    if (msg.type === 'assistant') {
      for (const block of blocksOf(msg)) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          state.toolUseSeq.set(block.id, entry.seq)
        }
      }
    }

    if (isRealUserPrompt(msg)) {
      state.turn.turnNo += 1
      state.turn.turnSeq = entry.seq
      const promptText = extractMessagePlainText(msg as Parameters<typeof extractMessagePlainText>[0]) ?? ''
      state.turn.turnPrompt = turnPromptOf(promptText) || 'Session start'
    } else if (state.turn.turnNo === 0) {
      state.turn.turnNo = 1
      state.turn.turnSeq = 0
      state.turn.turnPrompt = 'Session start'
    }

    let ownerToolUseId: string | undefined
    let ownerSeq: number | undefined
    if (isToolResult) {
      const block = blocksOf(msg).find((b) => b.type === 'tool_result')
      const id = typeof block?.tool_use_id === 'string' ? block.tool_use_id : undefined
      if (!id) continue
      ownerToolUseId = id
      ownerSeq = state.toolUseSeq.get(id)
      if (ownerSeq === undefined) continue
    }

    const text = extractMessagePlainText(msg as Parameters<typeof extractMessagePlainText>[0])
    if (!text) continue
    const timestamp = timestampOf(msg)

    state.rows.push({
      seq: ownerSeq ?? entry.seq,
      messageSeq: entry.seq,
      uuid: typeof msg.uuid === 'string' ? msg.uuid : null,
      role: isToolResult ? 'tool_result' : msg.type === 'user' ? 'user' : 'assistant',
      text,
      turnSeq: state.turn.turnSeq,
      turnNo: state.turn.turnNo,
      turnPrompt: state.turn.turnPrompt,
      ...(ownerToolUseId !== undefined ? { ownerToolUseId } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
    })
  }
}

async function consumeChunked(state: IndexState, messages: readonly TranscriptPageMessage[]): Promise<void> {
  for (let i = 0; i < messages.length; i += 200) {
    consume(state, messages.slice(i, i + 200))
    if (i + 200 < messages.length) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
}

async function buildFull(id: string, deps: SessionSearchDeps): Promise<IndexState> {
  const pages: TranscriptPageResponse[] = []
  let before: number | undefined
  for (;;) {
    const page = await deps.getWindow(id, before, PAGE_SIZE)
    pages.push(page)
    if (!page.hasMore || page.messages.length === 0) break
    if (before !== undefined && page.startIndex >= before) break
    before = page.startIndex
  }
  const newest = pages[0]
  const state = emptyState()
  state.generation = newest?.generation ?? 0
  state.headSeq = newest?.headSeq ?? 0
  await consumeChunked(state, pages.reverse().flatMap((p) => p.messages))
  // Cover an all-tombstone tail: the watermark is a seq, not a message.
  state.lastIndexedSeq = Math.max(state.lastIndexedSeq, state.headSeq - 1)
  state.tombstoneEpoch = await deps.getTombstoneEpoch(id)
  return state
}

/** Returns false when the generation moved and the caller must rebuild. */
async function append(id: string, deps: SessionSearchDeps, state: IndexState): Promise<boolean> {
  const tombstoneEpoch = await deps.getTombstoneEpoch(id)
  if (tombstoneEpoch !== state.tombstoneEpoch) return false
  let after = state.lastIndexedSeq
  for (;;) {
    const page = await deps.getAfter(id, after, PAGE_SIZE)
    if (page.generation !== state.generation) return false
    await consumeChunked(state, page.messages)
    state.headSeq = page.headSeq
    if (page.messages.length === 0 || page.messages.length < PAGE_SIZE) {
      state.lastIndexedSeq = Math.max(state.lastIndexedSeq, page.headSeq - 1)
      state.tombstoneEpoch = tombstoneEpoch
      return true
    }
    after = page.messages[page.messages.length - 1].seq
  }
}

export function createSessionSearchIndex(deps: SessionSearchDeps): SessionSearchIndex {
  const cache = new Map<string, IndexState>()
  // Serialize searches per session: concurrent queries share one mutable
  // IndexState, so without this two requests can consume the same getAfter
  // page into the rows twice (duplicated hits, inflated totalHits).
  const locks = new Map<string, Promise<unknown>>()

  const withLock = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const previous = locks.get(id) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => gate)
    locks.set(id, tail)
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (locks.get(id) === tail) locks.delete(id)
    }
  }

  const touch = (id: string, state: IndexState): void => {
    cache.delete(id)
    cache.set(id, state)
    while (cache.size > MAX_SESSIONS) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  const runSearch = async (id: string, query: string, limit: number): Promise<SessionSearchResponse> => {
      const q = query.trim()
      if (!q) {
        return { query: '', hits: [], totalHits: 0, truncated: false, indexStatus: 'ok' }
      }

      let state = cache.get(id)
      if (state) {
        const appended = await append(id, deps, state)
        if (!appended) state = await buildFull(id, deps)
      } else {
        state = await buildFull(id, deps)
      }
      touch(id, state)

      const all: SessionSearchHit[] = []
      for (const row of state.rows) {
        if (!row.text.toLowerCase().includes(q.toLowerCase())) continue
        all.push({
          seq: row.seq,
          messageSeq: row.messageSeq,
          messageUuid: row.uuid,
          turnSeq: row.turnSeq,
          turnNo: row.turnNo,
          turnPrompt: row.turnPrompt,
          role: row.role,
          ...(row.timestamp !== undefined ? { timestamp: row.timestamp } : {}),
          snippet: buildSnippet(row.text, q),
          matchCount: countMatches(row.text, q),
          ...(row.ownerToolUseId !== undefined ? { ownerToolUseId: row.ownerToolUseId } : {}),
        })
      }
      const totalHits = all.length
      const hits = all.slice(0, limit)
      return {
        query: q,
        hits,
        totalHits,
        truncated: totalHits > hits.length,
        indexStatus: (await deps.isDegraded(id)) ? 'degraded' : 'ok',
      }
    }

  return {
    search: (id, query, limit) => withLock(id, () => runSearch(id, query, limit)),
  }
}