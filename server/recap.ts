// Session recap generator.
//
// Reads a session's message history, calls the Anthropic Messages API
// (direct fetch — not through the SDK) to produce a concise summary,
// and caches the result in-memory. Falls back to a simple extraction
// when no API key is configured.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { config as serverConfig } from './config.js'
import { callAnthropicMessages } from './anthropic-api.js'

// ── Types ──────────────────────────────────────────────────────────

export interface RecapStats {
  messageCount: number
  userTurns: number
  assistantTurns: number
  totalCostUsd: number
  durationMs: number
  toolsUsed: string[]
}

export interface RecapResult {
  summary: string
  stats: RecapStats
  cached: boolean
  generatedAt: number
  fallback?: boolean
}

interface CacheEntry {
  summary: string
  stats: RecapStats
  messageCount: number
  lastMessageUuid: string
  /** The UUID of the last message at the time the recap was generated.
   *  Used by the route handler after appendRecap() to bump the cache
   *  snapshot so that subsequent requests with no new messages hit the
   *  cache instead of re-calling the LLM. */
  lastMessageUuidAtGeneration: string
  generatedAt: number
}

// ── Cache ──────────────────────────────────────────────────────────
//
// Cache lifetime rules (NO time-based TTL):
//   1. `invalidateRecapCache(id)` — called on every send() and delete()
//      in SessionManager. New user turn = stale summary, full stop.
//   2. Message-count + last-message-uuid fingerprint mismatch — covers
//      compaction, history truncation, or any other path that mutates
//      the transcript without going through send() (rare, but possible
//      under future SDK features).
//   3. LRU eviction when the map exceeds `CACHE_MAX_ENTRIES`.
//   4. Process restart — the Map is in-memory only.
//
// We deliberately do NOT expire by wall-clock age. A summary stays valid
// as long as the underlying conversation is unchanged: a 6-hour-old
// summary of a conversation that hasn't grown in 6 hours is still 100%
// accurate, and re-running the LLM would burn money + tokens for an
// identical result.

const cache = new Map<string, CacheEntry>()
const CACHE_MAX_ENTRIES = 200

/** In-flight dedup map: if two requests for the same session arrive
 *  concurrently, the second one reuses the first one's promise. */
const inflight = new Map<string, Promise<RecapResult>>()

export function invalidateRecapCache(sessionId: string): void {
  cache.delete(sessionId)
}

/**
 * Bump the cache entry after appendRecap() adds the recap message to the
 * session's history. Without this, the next request sees a different
 * messageCount + lastMessageUuid and needlessly re-calls the LLM.
 *
 * Only called when generateRecap returned a non-fallback result (which is
 * the only case where the cache is populated).
 */
export function updateRecapCacheAfterAppend(
  sessionId: string,
  newMessageCount: number,
  newLastMessageUuid: string,
): void {
  const entry = cache.get(sessionId)
  if (entry) {
    entry.messageCount = newMessageCount
    entry.lastMessageUuid = newLastMessageUuid
  }
}

// ── History extraction ─────────────────────────────────────────────

interface ExtractedLine {
  role: 'User' | 'Assistant'
  text: string
}

/** Pull a flat text block from a message's content field. */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: string }>)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
}

/** Pull tool_use block names from assistant content. */
function extractToolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return (content as Array<{ type?: string; name?: string }>)
    .filter((b) => b.type === 'tool_use' && typeof b.name === 'string')
    .map((b) => b.name as string)
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}

/** Extract a compact transcript + stats from the message history. */
function extractHistory(messages: SDKMessage[]): { lines: ExtractedLine[]; stats: RecapStats } {
  const lines: ExtractedLine[] = []
  const toolSet = new Set<string>()
  let userTurns = 0
  let assistantTurns = 0
  let totalCost = 0
  let totalDuration = 0

  for (const msg of messages) {
    const m = msg as Record<string, unknown>
    const type = m.type as string

    if (type === 'user') {
      const content = (m as { message?: { content?: unknown } }).message?.content
      // Skip tool_result-only frames (synthetic SDK bookkeeping).
      if (Array.isArray(content)) {
        const hasToolResult = (content as Array<{ type?: string }>).some((b) => b.type === 'tool_result')
        const hasText = (content as Array<{ type?: string; text?: string }>).some(
          (b) => b.type === 'text' && b.text,
        )
        if (hasToolResult && !hasText) continue
      }
      const text = extractText(content)
      if (!text) continue
      userTurns++
      lines.push({ role: 'User', text: truncate(text.trim(), 500) })
    } else if (type === 'assistant') {
      const content = (m as { message?: { content?: unknown } }).message?.content
      const text = extractText(content)
      for (const name of extractToolNames(content)) toolSet.add(name)
      if (text) {
        assistantTurns++
        lines.push({ role: 'Assistant', text: truncate(text.trim(), 500) })
      }
    } else if (type === 'result') {
      // SDK's total_cost_usd is a *cumulative* value, not per-turn.
      // Always overwrite instead of adding — the last result carries
      // the final running total.
      const cost = (m as { total_cost_usd?: number }).total_cost_usd
      if (typeof cost === 'number') totalCost = cost

      // SDK result messages carry a duration_ms field indicating how
      // long the turn took. Accumulate across all turns.
      const dur = (m as { duration_ms?: number }).duration_ms
      if (typeof dur === 'number') totalDuration += dur
    }
  }

  const stats: RecapStats = {
    messageCount: messages.length,
    userTurns,
    assistantTurns,
    totalCostUsd: Math.round(totalCost * 10000) / 10000,
    durationMs: Math.round(totalDuration),
    toolsUsed: [...toolSet].sort(),
  }
  return { lines, stats }
}

/** Build the transcript text for the summarization prompt. Keeps the
 *  first 3 and last N lines within a ~12k char budget. */
function buildTranscript(lines: ExtractedLine[]): string {
  const CHAR_BUDGET = 12_000
  const formatted = lines.map((l, i) => `[${i + 1}] ${l.role}: ${l.text}`)
  const total = formatted.reduce((n, s) => n + s.length + 1, 0)
  if (total <= CHAR_BUDGET) return formatted.join('\n')

  // Keep first 3 + as many trailing lines as fit.
  const head = formatted.slice(0, 3)
  let budget = CHAR_BUDGET - head.reduce((n, s) => n + s.length + 1, 0) - 40 // 40 for the marker
  const tail: string[] = []
  for (let i = formatted.length - 1; i >= 3; i--) {
    const line = formatted[i]
    if (budget - line.length - 1 < 0 && tail.length > 0) break
    tail.unshift(line)
    budget -= line.length + 1
  }
  const omitted = formatted.length - head.length - tail.length
  return [...head, `[... ${omitted} messages omitted ...]`, ...tail].join('\n')
}

// ── Anthropic API ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a session recap assistant. Summarize the following conversation between a user and Claude (an AI coding assistant) in 2-4 sentences. Focus on:
1. What task or problem the user was working on
2. What files, tools, or code were involved
3. The current status (completed, in-progress, blocked, errored)
Be concise and specific. Use plain language. Do not include a greeting or sign-off. Start directly with the summary. Always respond in the same language the user writes in.
IMPORTANT: Do NOT use JSX syntax, HTML tags, or code markup (like <>, </>, <Component>) in your response. Write in natural prose only. When referencing code elements, use backtick formatting (e.g. \`Button\` component) instead of angle brackets.`

async function callAnthropic(transcript: string): Promise<string> {
  const text = await callAnthropicMessages({
    model: serverConfig.recapModel,
    system: SYSTEM_PROMPT,
    userContent: transcript,
    maxTokens: 300,
    temperature: 0.3,
  })
  // Strip stray JSX fragments (<> </> <React.Fragment> </React.Fragment>) that
  // the LLM sometimes emits when summarising code-heavy conversations.
  return text.replace(/<\/?React\.Fragment\s*>|<>|<\/>/g, '').replace(/\s{2,}/g, ' ').trim()
}

// ── Fallback (no API key) ──────────────────────────────────────────

function buildFallbackSummary(lines: ExtractedLine[], stats: RecapStats): string {
  const lastUser = [...lines].reverse().find((l) => l.role === 'User')
  const parts: string[] = []
  if (stats.userTurns > 0) {
    parts.push(`Session with ${stats.userTurns} user turn${stats.userTurns === 1 ? '' : 's'} and ${stats.assistantTurns} assistant response${stats.assistantTurns === 1 ? '' : 's'}.`)
  } else {
    parts.push('Empty session — no messages yet.')
  }
  if (lastUser) parts.push(`Last message: "${truncate(lastUser.text, 120)}"`)
  return parts.join(' ')
}

// ── Public API ─────────────────────────────────────────────────────

export async function generateRecap(messages: SDKMessage[], sessionId: string): Promise<RecapResult> {
  // Concurrent dedup: if the same session is already generating a recap
  // (e.g. user double-clicks refresh, or two tabs hit simultaneously),
  // reuse the in-flight promise.
  const existing = inflight.get(sessionId)
  if (existing) return existing

  const promise = doGenerateRecap(messages, sessionId)
  inflight.set(sessionId, promise)
  try {
    return await promise
  } finally {
    inflight.delete(sessionId)
  }
}

async function doGenerateRecap(messages: SDKMessage[], sessionId: string): Promise<RecapResult> {
  const { lines, stats } = extractHistory(messages)

  // Empty session — no work to do.
  if (lines.length === 0) {
    return { summary: 'No messages yet.', stats, cached: false, generatedAt: Date.now(), fallback: true }
  }

  // Check cache. No wall-clock TTL — see the cache section header for the
  // full set of invalidation rules.
  const lastMsg = messages[messages.length - 1] as Record<string, unknown> | undefined
  const lastUuid = (lastMsg?.uuid as string) ?? ''
  // If the last message has no UUID (SDK didn't provide one), we can't
  // trust the cache to be valid — any two messages of the same length
  // would look identical. Skip the cache in that case.
  const canTrustCache = !!lastUuid
  const cached = cache.get(sessionId)
  if (
    canTrustCache &&
    cached &&
    cached.messageCount === messages.length &&
    cached.lastMessageUuid === lastUuid
  ) {
    return { summary: cached.summary, stats: cached.stats, cached: true, generatedAt: cached.generatedAt }
  }
  // Store the pre-generation UUID so the route handler can bump the cache
  // after appendRecap() adds the recap message to history.
  const lastMessageUuidAtGeneration = lastUuid

  // Generate. authToken presence is the single gate — config.json is the
  // only source of truth (env vars are no longer consulted).
  const hasKey = !!serverConfig.authToken
  let summary: string
  let fallback = false

  if (hasKey) {
    try {
      const transcript = buildTranscript(lines)
      summary = await callAnthropic(transcript)
    } catch (err) {
      // API call failed — degrade to fallback, but log so we can debug.
      console.warn('[recap] Anthropic API call failed, using fallback:', (err as Error).message)
      summary = buildFallbackSummary(lines, stats)
      fallback = true
    }
  } else {
    summary = buildFallbackSummary(lines, stats)
    fallback = true
  }

  const generatedAt = Date.now()
  // Only cache real AI summaries — fallbacks are a degraded result. With
  // no wall-clock TTL, caching a fallback would freeze the bad summary
  // in place until the next user turn invalidates it. Retries are cheap
  // (network or UI refresh button); keep them available.
  if (!fallback) {
    cache.set(sessionId, {
      summary, stats,
      messageCount: messages.length,
      lastMessageUuid: lastUuid,
      lastMessageUuidAtGeneration,
      generatedAt,
    })
    // LRU eviction: drop oldest entries when the cache exceeds the cap.
    if (cache.size > CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value
      if (oldest) cache.delete(oldest)
    }
  }
  return { summary, stats, cached: false, generatedAt, fallback }
}
