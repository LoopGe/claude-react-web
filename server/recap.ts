// Session recap generator.
//
// Reads a session's message history, calls the Anthropic Messages API
// (direct fetch — not through the SDK) to produce a concise summary,
// and caches the result in-memory.
//
// There is no local-fallback summary: when the API key is missing or
// the call fails we throw, and the route layer surfaces the error as
// a `state: 'error'` recap message. Hiding failures behind a generic
// "Empty session" string was misleading — users had no way to tell a
// truly empty conversation apart from a misconfigured authToken.

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
//
// Errors are NOT cached. When auth is missing or the API throws,
// generateRecap rejects and nothing lands in the map — the next click
// re-tries from scratch. (The empty-session shortcut also doesn't write
// to the cache: it would invalidate on the first user turn anyway.)

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
 * Only meaningful when the cache already contains an entry for the
 * session (i.e. generateRecap successfully called the LLM). Empty-session
 * results don't write to the cache, so this is a no-op for them.
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

// ── Language detection ─────────────────────────────────────────────
//
// Why this exists: when a user types in Chinese / Japanese / Korean /
// Russian / etc., the LLM frequently produces an English summary because
//   1. the system prompt is in English (strong dominant-language signal),
//   2. tool outputs / file paths / stack traces in the transcript are
//      overwhelmingly English, drowning out the user's actual language,
//   3. truncation can leave only English tail content visible.
//
// We count script characters in *user-role text only* (the user's chat
// turns are the most reliable language signal — assistant turns echo
// whichever language the prior recap chose) and pick the dominant
// non-Latin script above a small threshold.
//
// Why Latin-script users get null instead of 'English': we cannot
// reliably distinguish English from French/Spanish/German/etc. with a
// script-only heuristic. If we returned 'English' for every Latin-script
// transcript, French users would get summaries explicitly forced to
// English — strictly worse than the pre-detection baseline. Returning
// null tells buildSystemPrompt to fall back to the generic "match the
// user's language" directive, which lets the LLM correctly infer
// French/Spanish/etc. from context (the same behaviour we shipped
// before adding detection at all).

/** Returns a human-readable language label (with a native sample so the
 *  LLM gets both an English name and an in-language anchor) when a
 *  non-Latin script dominates the user's input. Returns null for
 *  Latin-script input (English, French, Spanish, German, …) — the
 *  caller falls back to a generic "respond in the user's language"
 *  directive in that case. */
export function detectLanguage(userText: string): string | null {
  let cjk = 0
  let kana = 0 // hiragana + katakana (Japanese-exclusive)
  let hangul = 0
  let cyrillic = 0
  let arabic = 0
  let hebrew = 0
  let thai = 0
  let devanagari = 0
  for (const ch of userText) {
    const cp = ch.codePointAt(0)
    if (cp == null) continue
    // Hangul: Syllables + Jamo + Compatibility Jamo + Extended-A/B.
    // The extended ranges cover archaic / academic Korean which would
    // otherwise miss the threshold in short messages.
    if (
      (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
      (cp >= 0x1100 && cp <= 0x11ff) || // Hangul Jamo
      (cp >= 0x3130 && cp <= 0x318f) || // Hangul Compatibility Jamo
      (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo Extended-A
      (cp >= 0xd7b0 && cp <= 0xd7ff)    // Hangul Jamo Extended-B
    ) hangul++
    else if (cp >= 0x3040 && cp <= 0x30ff) kana++
    // CJK: Unified + Ext A through G + Compat. Without the SMP ranges,
    // rare characters (classical Chinese, unusual personal names) fall
    // through to the English-default branch.
    else if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||  // CJK Unified Ideographs
      (cp >= 0x3400 && cp <= 0x4dbf) ||  // CJK Ext A
      (cp >= 0x20000 && cp <= 0x2ebef) || // CJK Ext B-F (contiguous block)
      (cp >= 0x30000 && cp <= 0x3134f) || // CJK Ext G
      (cp >= 0xf900 && cp <= 0xfaff) ||  // CJK Compat Ideographs
      (cp >= 0x2f800 && cp <= 0x2fa1f)   // CJK Compat Ideographs Supplement
    ) cjk++
    else if (cp >= 0x0400 && cp <= 0x04ff) cyrillic++
    else if (cp >= 0x0600 && cp <= 0x06ff) arabic++
    else if (cp >= 0x0590 && cp <= 0x05ff) hebrew++
    else if (cp >= 0x0e00 && cp <= 0x0e7f) thai++
    else if (cp >= 0x0900 && cp <= 0x097f) devanagari++
  }
  // Threshold: a handful of non-Latin chars in user input is a strong
  // intentional signal. Anything below this is probably a stray symbol
  // (e.g. a single diacritic in an otherwise-English message).
  const MIN = 4
  // Hangul is Korean-exclusive — easiest disambiguation, check first.
  if (hangul >= MIN) return 'Korean (한국어)'
  // Japanese requires kana; CJK alone is Chinese. Order matters because
  // Japanese text usually contains both kana and CJK kanji.
  if (kana >= MIN) return 'Japanese (日本語)'
  if (cjk >= MIN) return 'Chinese (中文)'
  if (cyrillic >= MIN) return 'Russian (Русский)'
  if (arabic >= MIN) return 'Arabic (العربية)'
  if (hebrew >= MIN) return 'Hebrew (עברית)'
  if (thai >= MIN) return 'Thai (ไทย)'
  if (devanagari >= MIN) return 'Hindi (हिन्दी)'
  // Latin-script — we can't tell English from French/Spanish/German/etc.
  // by script counts alone, so let the LLM infer from context.
  return null
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
function extractHistory(messages: SDKMessage[]): {
  lines: ExtractedLine[]
  stats: RecapStats
  language: string | null
} {
  const lines: ExtractedLine[] = []
  const toolSet = new Set<string>()
  let userTurns = 0
  let assistantTurns = 0
  let totalCost = 0
  let totalDuration = 0
  // Accumulate full user text (pre-truncation) for language detection so
  // a long Chinese message that gets sliced to 500 chars still contributes
  // its full character mass to the script counts.
  let userTextBuf = ''

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
      userTextBuf += text + '\n'
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
  const language = detectLanguage(userTextBuf)
  return { lines, stats, language }
}

/** Build the transcript text for the summarization prompt. Keeps the
 *  first 3 and last N lines within a ~12k char budget. The language
 *  hint is appended at the very end so it sits at the recency-biased
 *  tail of the user content — empirically this is much stickier than
 *  the same instruction in the system prompt alone. When `language` is
 *  null (Latin-script input we can't pin down) the hint asks the LLM
 *  to infer the language from the user lines instead of naming one. */
function buildTranscript(lines: ExtractedLine[], language: string | null): string {
  const CHAR_BUDGET = 12_000
  const formatted = lines.map((l, i) => `[${i + 1}] ${l.role}: ${l.text}`)
  const tailHint = language
    ? `\n\n---\nWrite the recap summary in ${language}.`
    : `\n\n---\nWrite the recap summary in the same language the user uses in their messages above.`
  // The tail hint is always appended unconditionally, so its length must
  // be charged against the budget — otherwise long conversations end up
  // ~tailHint.length bytes over the documented 12k cap.
  const effectiveBudget = CHAR_BUDGET - tailHint.length
  const total = formatted.reduce((n, s) => n + s.length + 1, 0)
  if (total <= effectiveBudget) return formatted.join('\n') + tailHint

  // Keep first 3 + as many trailing lines as fit.
  const head = formatted.slice(0, 3)
  let budget = effectiveBudget - head.reduce((n, s) => n + s.length + 1, 0) - 40 // 40 for the marker
  const tail: string[] = []
  for (let i = formatted.length - 1; i >= 3; i--) {
    const line = formatted[i]
    if (budget - line.length - 1 < 0 && tail.length > 0) break
    tail.unshift(line)
    budget -= line.length + 1
  }
  const omitted = formatted.length - head.length - tail.length
  return [...head, `[... ${omitted} messages omitted ...]`, ...tail].join('\n') + tailHint
}

// ── Anthropic API ──────────────────────────────────────────────────

/** Build the system prompt with an explicit, last-position language
 *  directive. The language requirement lives both in its own block and
 *  is restated at the tail of the transcript (see buildTranscript) —
 *  belt-and-braces because mixed-script transcripts (Chinese chat +
 *  English file paths / stack traces) bias the model toward English
 *  unless the directive is unmissable.
 *
 *  When `language` is null (the script-detection heuristic couldn't
 *  pin one down — typically Latin-script text where en/fr/es/de all
 *  look identical), we fall back to a generic "match the user" rule.
 *  Forcing 'English' here would actively break French/Spanish/German
 *  users; the catch-all wording lets the LLM infer correctly from the
 *  User: lines in the transcript. */
function buildSystemPrompt(language: string | null): string {
  const intro = `You are a session recap assistant. Summarize the following conversation between a user and Claude (an AI coding assistant) in 2-4 sentences. Focus on:
1. What task or problem the user was working on
2. What files, tools, or code were involved
3. The current status (completed, in-progress, blocked, errored)
Be concise and specific. Use plain language. Do not include a greeting or sign-off. Start directly with the summary.

FORMAT RULES:
- Do NOT use JSX syntax, HTML tags, or code markup (like <>, </>, <Component>) in your response. Write in natural prose only.
- When referencing code elements, use backtick formatting (e.g. \`Button\` component) instead of angle brackets.`

  const languageRule = language
    ? `OUTPUT LANGUAGE — CRITICAL: You MUST write the entire summary in ${language}. This requirement overrides every other language signal in the conversation. File paths, error messages, code identifiers, English log output, and English tool names do NOT change the output language — keep technical identifiers verbatim, but write all surrounding prose in ${language}. Even if most of the transcript content appears to be in English, the summary itself must be in ${language}.`
    : `OUTPUT LANGUAGE — CRITICAL: Write the summary in the same language the USER uses in their "User:" turns above. Do NOT default to English unless the user themselves writes in English. File paths, error messages, code identifiers, English log output, and English tool names do NOT change the output language — keep those technical identifiers verbatim, but write all surrounding prose in the user's language. If the user writes in French, write the summary in French. If they write in Spanish, write in Spanish. Match the user's language exactly.`

  return `${intro}

${languageRule}`
}

async function callAnthropic(transcript: string, language: string | null): Promise<string> {
  const text = await callAnthropicMessages({
    model: serverConfig.recapModel,
    system: buildSystemPrompt(language),
    userContent: transcript,
    maxTokens: 300,
    // Recap is a deterministic summarization task — no creativity needed.
    // Temperature 0 also makes language-adherence more stable.
    temperature: 0,
  })
  // Strip stray JSX fragments (<> </> <React.Fragment> </React.Fragment>) that
  // the LLM sometimes emits when summarising code-heavy conversations.
  return text.replace(/<\/?React\.Fragment\s*>|<>|<\/>/g, '').replace(/\s{2,}/g, ' ').trim()
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
  const { lines, stats, language } = extractHistory(messages)

  // Empty session — no work to do. Not an error: the user just clicked
  // recap on a brand-new conversation. Returned as a normal ready summary
  // (no LLM call, no cache write — would auto-invalidate on the first
  // user turn anyway).
  if (lines.length === 0) {
    return { summary: 'No messages yet.', stats, cached: false, generatedAt: Date.now() }
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
    // Refresh LRU insertion order on cache hit.
    cache.delete(sessionId)
    cache.set(sessionId, cached)
    return { summary: cached.summary, stats: cached.stats, cached: true, generatedAt: cached.generatedAt }
  }
  // Store the pre-generation UUID so the route handler can bump the cache
  // after appendRecap() adds the recap message to history.
  const lastMessageUuidAtGeneration = lastUuid

  // No fallback — if the auth token is missing we throw so the route
  // layer can surface the real reason ("authToken not configured") as a
  // state:'error' recap card. Returning a vague local-summary used to
  // hide misconfiguration.
  if (!serverConfig.authToken) {
    throw new Error(
      'Recap unavailable: authToken is not configured. Set authToken in config.json.',
    )
  }

  // Let API errors propagate. The route layer catches and renders them.
  const transcript = buildTranscript(lines, language)
  const summary = await callAnthropic(transcript, language)

  const generatedAt = Date.now()
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
  return { summary, stats, cached: false, generatedAt }
}
