/**
 * Per-session transcript search index.
 *
 * Built from the transcript seq store (via the manager's window reads), not
 * the on-disk JSONL: every row carries an append-stable seq, so a hit can be
 * jumped to without another uuid→index lookup. Rows are the messages the main
 * transcript can render: sidechain frames are excluded, hidden frames are
 * excluded, and a tool_result stays attached to its owning tool_use's seq.
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
  ownerSeq?: number
  ownerToolUseId?: string
  timestamp?: number
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

async function buildRows(id: string, deps: SessionSearchDeps): Promise<Row[]> {
  // Page backward to the beginning, then reverse into chronological order.
  const pages: TranscriptPageResponse[] = []
  let before: number | undefined
  for (;;) {
    const page = await deps.getWindow(id, before, 1000)
    pages.push(page)
    if (!page.hasMore || page.messages.length === 0) break
    if (before !== undefined && page.startIndex >= before) break
    before = page.startIndex
  }
  const messages: TranscriptPageMessage[] = pages.reverse().flatMap((p) => p.messages)

  const rows: Row[] = []
  const toolUseSeq = new Map<string, number>()
  let turnNo = 0
  let turnSeq = 0
  let turnPrompt = '（会话开头）'

  let processed = 0
  for (const entry of messages) {
    processed++
    if (processed % 200 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }

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
          toolUseSeq.set(block.id, entry.seq)
        }
      }
    }

    if (isRealUserPrompt(msg)) {
      turnNo += 1
      turnSeq = entry.seq
      const promptText = extractMessagePlainText(msg as Parameters<typeof extractMessagePlainText>[0]) ?? ''
      turnPrompt = turnPromptOf(promptText) || '（会话开头）'
    } else if (turnNo === 0) {
      turnNo = 1
      turnSeq = 0
      turnPrompt = '（会话开头）'
    }

    let ownerToolUseId: string | undefined
    let ownerSeq: number | undefined
    if (isToolResult) {
      const block = blocksOf(msg).find((b) => b.type === 'tool_result')
      const id = typeof block?.tool_use_id === 'string' ? block.tool_use_id : undefined
      if (!id) continue
      ownerToolUseId = id
      ownerSeq = toolUseSeq.get(id)
      if (ownerSeq === undefined) continue
    }

    const text = extractMessagePlainText(msg as Parameters<typeof extractMessagePlainText>[0])
    if (!text) continue
    const timestamp = timestampOf(msg)

    rows.push({
      seq: ownerSeq ?? entry.seq,
      messageSeq: entry.seq,
      uuid: typeof msg.uuid === 'string' ? msg.uuid : null,
      role: isToolResult ? 'tool_result' : msg.type === 'user' ? 'user' : 'assistant',
      text,
      turnSeq,
      turnNo,
      turnPrompt,
      ...(ownerSeq !== undefined ? { ownerSeq } : {}),
      ...(ownerToolUseId !== undefined ? { ownerToolUseId } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
    })
  }

  return rows
}

export function createSessionSearchIndex(deps: SessionSearchDeps): SessionSearchIndex {
  return {
    async search(id, query, limit) {
      const q = query.trim()
      if (!q) {
        return { query: '', hits: [], totalHits: 0, truncated: false, indexStatus: 'ok' }
      }
      const rows = await buildRows(id, deps)
      const all: SessionSearchHit[] = []
      for (const row of rows) {
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
    },
  }
}