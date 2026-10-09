// Dev-only first-party `history-tools` in-process MCP server.
//
// Exposes cross-session transcript search to the agent as
// `mcp__history-tools__*` tools — the only path an in-session agent has to the
// user's OTHER sessions (search + paged read + session discovery). Handlers
// call SessionManager directly through a narrow structural host (HistoryHost)
// — same pattern as app-debug's DebugHost — so there is no REST round-trip,
// no auth surface, and tests can pass a fake.
//
// REACHABILITY IS THE SECURITY BOUNDARY (mirrors app-debug): this module is
// only ever registered by `server/dev-mode.ts`'s enableDevMode, which the CLI
// calls only on a dev runtime. A published dist/cli.mjs run cannot expose
// these tools through configuration alone.
//
// All three tools are read-only (readOnlyToolNames → permission-broker
// exemption). Cross-project visibility is the deliberate default: searching
// every session is the tool's whole point. `sameCwdOnly` narrows to sessions
// spawned in the CALLING session's cwd (bound via buildTools) — compared via
// canonical paths (server/cwd-equality.ts), not raw string equality.

import { z } from 'zod'
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { FirstPartyToolServer } from './types.js'
import type { MessageSearchHit } from '../../shared/search-results.js'
import type { HistoryPage } from '../history-reader.js'
import { sameCwd } from '../cwd-equality.js'
import { ok, guard, json } from './call-result.js'

/** Server name — tool FQN is `mcp__history-tools__{name}`. */
export const HISTORY_TOOLS_SERVER_NAME = 'history-tools'

/** Bare read-only tool names — permission-broker exemption via the registry. */
export const HISTORY_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'history_search',
  'history_read_context',
  'history_list_sessions',
])

/** Structural slice of SessionManager the history tools need — declared
 *  locally so this module stays free of session internals and tests fake it. */
export interface HistoryHost {
  list(): HistorySessionInfo[]
  searchMessages(
    query: string,
    opts?: { limit?: number; sessionId?: string; cwd?: string },
  ): Promise<MessageSearchHit[]>
  getHistoryPage(
    id: string,
    opts: { before?: number; limit: number },
  ): Promise<HistoryPage>
}

export interface HistorySessionInfo {
  id: string
  title?: string
  cwd?: string
  provider?: string
  model?: string
  lastTurnAt?: number
  lastActivityAt: number
  messageCount: number
}

const BLOCK_TEXT_CAP = 400
const MAX_CONTEXT_OUTPUT_CHARS = 20_000

/** Render one content block inline. Tool blocks are NOT collapsed to opaque
 *  markers: history_search indexes tool_result text and tool_use inputs
 *  (shared/search/extract.ts), so the read-back must surface the matched
 *  text or the documented search→read workflow drops the hit's own body.
 *  Each block is capped; thinking is skipped. */
function renderBlock(block: unknown): string | null {
  if (!block || typeof block !== 'object') return null
  const b = block as { type?: string; text?: unknown; name?: unknown; input?: unknown; content?: unknown }
  const cap = (s: string) => (s.length > BLOCK_TEXT_CAP ? s.slice(0, BLOCK_TEXT_CAP) + `… (+${s.length - BLOCK_TEXT_CAP} chars)` : s)
  if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) return cap(b.text.trim())
  if (b.type === 'tool_use' && typeof b.name === 'string') {
    const input = b.input != null ? JSON.stringify(b.input) : ''
    return cap(`[tool_use: ${b.name}]${input ? ' ' + input : ''}`)
  }
  if (b.type === 'tool_result') {
    const c = b.content
    let text: string | null = null
    if (typeof c === 'string') text = c
    else if (Array.isArray(c)) {
      text = c
        .map((item) => (item && typeof item === 'object' && (item as { type?: string }).type === 'text' ? String((item as { text?: unknown }).text ?? '') : ''))
        .filter((t) => t.trim())
        .join('\n')
    }
    return text && text.trim() ? cap(`[tool_result] ${text.trim()}`) : '[tool_result]'
  }
  return null
}

/** One transcript message → a compact text rendering: role tag + text, tool
 *  calls/results kept as capped inline renders. Returns null for messages
 *  with nothing renderable (e.g. thinking-only). */
export function formatTranscriptMessage(msg: unknown): string | null {
  if (!msg || typeof msg !== 'object') return null
  const m = msg as {
    type?: string
    message?: { role?: string; content?: unknown }
  }
  const role = m.message?.role ?? m.type
  if (!role) return null
  const content = m.message?.content

  const parts: string[] = []
  if (typeof content === 'string') {
    if (content.trim()) parts.push(content.trim())
  } else if (Array.isArray(content)) {
    for (const block of content) {
      const rendered = renderBlock(block)
      if (rendered != null) parts.push(rendered)
    }
  }
  if (parts.length === 0) return null

  const body = parts.join('\n')
  const capped = body.length > 2000 ? body.slice(0, 2000) + `… (+${body.length - 2000} chars)` : body
  const tag = role === 'user' ? '[user]' : role === 'assistant' ? '[assistant]' : `[${role}]`
  return `${tag} ${capped}`
}

/** The tool definitions, bound to the host and the CALLING session's cwd
 *  (null when the session has none — sameCwdOnly then errors). */
export function buildHistoryToolDefs(host: HistoryHost, boundCwd: string | null): SdkMcpToolDefinition<any>[] {
  const readOnly = { readOnlyHint: true }

  /** Resolve the cwd for sameCwdOnly — the calling session's, which may not
   *  exist. Errors loudly rather than silently degrading to unfiltered. */
  const requireCwd = (): string => {
    if (!boundCwd) throw new Error('sameCwdOnly requires this session to have a cwd, but it has none')
    return boundCwd
  }

  return [
    tool(
      'history_search',
      'Full-text search across ALL of the user\'s past and current claude-react-web sessions (disk transcripts, dormant sessions included). Use it to recall prior discussions, decisions, error fixes, or earlier work. Matches text in user/assistant messages AND tool results/inputs (commands, edits). Returns hits with sessionId / messageIndex / snippet; feed messageIndex into history_read_context for the surrounding transcript. Default is cross-project; pass sameCwdOnly:true to restrict to sessions started in THIS session\'s working directory.',
      {
        query: z.string().min(2).describe('Plain-text query (case-insensitive substring match, min 2 chars)'),
        sessionId: z.string().optional().describe('Restrict the search to this one session'),
        sameCwdOnly: z.boolean().optional().describe('Restrict to sessions spawned in this session\'s cwd'),
        limit: z.number().int().min(1).max(100).optional().describe('Max hits (default 30)'),
      },
      async (a) =>
        guard(async () => {
          const cwd = a.sameCwdOnly ? requireCwd() : undefined
          const hits = await host.searchMessages(a.query, {
            limit: a.limit,
            sessionId: a.sessionId,
            cwd,
          })
          return json({
            query: a.query,
            hitCount: hits.length,
            // Slim the hits: drop the two internal fields, keep the rest —
            // future MessageSearchHit fields surface automatically.
            hits: hits.map(({ id: _id, matchOrdinal: _ordinal, ...rest }) => rest),
          })
        }),
      { annotations: readOnly },
    ),
    tool(
      'history_read_context',
      'Read a window of transcript around a known message of another session. sessionId and messageIndex come from history_search hits (messageIndex is the chronological transcript index). beforeCount / afterCount size the window (default 10 each). Returns compact text: user/assistant messages with their text, tool calls and tool results rendered inline (capped). Works for dormant sessions too.',
      {
        sessionId: z.string(),
        messageIndex: z.number().int().min(0),
        beforeCount: z.number().int().min(0).max(50).optional().describe('Messages BEFORE the hit (default 10)'),
        afterCount: z.number().int().min(0).max(50).optional().describe('Messages AFTER the hit (default 10)'),
      },
      async (a) =>
        guard(async () => {
          const beforeCount = a.beforeCount ?? 10
          const afterCount = a.afterCount ?? 10
          // sliceWindow semantics: the page ends just before `before`, so one
          // call covers [messageIndex - beforeCount, messageIndex + afterCount].
          const page = await host.getHistoryPage(a.sessionId, {
            before: a.messageIndex + afterCount + 1,
            limit: beforeCount + afterCount + 1,
          })
          const hitOffset = a.messageIndex - page.startIndex
          const hitMissing = hitOffset < 0 || hitOffset >= page.messages.length
          const range = page.messages.length > 0
            ? `${page.startIndex}–${page.startIndex + page.messages.length - 1}`
            : `${page.startIndex}`
          const lines: string[] = [
            `session ${a.sessionId} — messages ${range} of ${page.totalCount}` +
              (hitMissing ? ' (requested message outside window — transcript changed since search?)' : ''),
          ]
          let total = lines[0].length
          // The hit message is what the caller asked for: emit it FIRST so a
          // long surrounding window can never truncate it away.
          if (!hitMissing) {
            const rendered = formatTranscriptMessage(page.messages[hitOffset])
            if (rendered != null) {
              const line = ` >>> ${rendered}`
              total += line.length
              lines.push(line)
            }
          }
          for (let i = 0; i < page.messages.length; i++) {
            if (i === hitOffset) continue
            const rendered = formatTranscriptMessage(page.messages[i])
            if (rendered == null) continue
            const line = `     ${rendered}`
            if (total + line.length > MAX_CONTEXT_OUTPUT_CHARS) {
              lines.push(`… output truncated at ${MAX_CONTEXT_OUTPUT_CHARS} chars`)
              break
            }
            total += line.length
            lines.push(line)
          }
          return ok(lines.join('\n'))
        }),
      { annotations: readOnly },
    ),
    tool(
      'history_list_sessions',
      'List known sessions (id, title, cwd, provider, model, activity) to discover what history exists before searching. Optionally filter by an explicit cwd, by this session\'s cwd (sameCwdOnly — ignored when cwd is given), and cap the count.',
      {
        cwd: z.string().optional().describe('Only sessions spawned in this directory (canonical comparison)'),
        sameCwdOnly: z.boolean().optional().describe('Only sessions spawned in this session\'s cwd'),
        limit: z.number().int().min(1).max(100).optional().describe('Max sessions (default 50)'),
      },
      async (a) =>
        guard(async () => {
          let sessions = host.list()
          // An explicit cwd answers the query on its own — sameCwdOnly only
          // errors when it would be the sole filter and the session has none.
          const filterCwd = a.cwd ?? (a.sameCwdOnly ? requireCwd() : undefined)
          if (filterCwd !== undefined) {
            const kept = []
            for (const s of sessions) {
              if (await sameCwd(s.cwd, filterCwd)) kept.push(s)
            }
            sessions = kept
          }
          sessions = sessions
            .sort((x, y) => (y.lastTurnAt ?? y.lastActivityAt) - (x.lastTurnAt ?? x.lastActivityAt))
            .slice(0, a.limit ?? 50)
          return json({
            count: sessions.length,
            sessions: sessions.map((s) => ({
              id: s.id,
              title: s.title,
              cwd: s.cwd,
              provider: s.provider,
              model: s.model,
              messageCount: s.messageCount,
              lastActivityAt: s.lastTurnAt ?? s.lastActivityAt,
            })),
          })
        }),
      { annotations: readOnly },
    ),
  ]
}

/** Build the history-tools first-party server bound to a host. requiresCwd is
 *  false — searching is global by default; sameCwdOnly degrades to a loud
 *  error when the calling session has no cwd. */
export function createHistoryTools(host: HistoryHost): FirstPartyToolServer {
  return {
    name: HISTORY_TOOLS_SERVER_NAME,
    description: 'Cross-session transcript search and read (dev-only)',
    defaultEnabled: true,
    requiresCwd: false,
    buildTools: (cwd) => buildHistoryToolDefs(host, cwd),
    readOnlyToolNames: HISTORY_READ_ONLY_TOOLS,
  }
}
