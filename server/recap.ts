// Session recap generator — state machine.
//
// This module is the single owner of `session.recap`. Three things live
// here:
//   1. The pure transcript-extraction + LLM-call helpers (extractHistory,
//      buildTranscript, callAnthropic, detectLanguage).
//   2. `RecapManager` — a small state machine whose two public verbs are
//      `invalidate(sessionId)` and `requestGenerate(sessionId)`. It owns
//      the lifecycle (`pending → ready/error`), the in-flight dedup, and
//      the broadcast.
//   3. The recap is not a synthetic `type:'recap'` SDK message in
//      session.history any more. It lives on `session.recap` and is
//      pushed to clients via the `session-recap-update` WS frame
//      (carried inside SessionInfo on full updates too).
//
// Invariants (enforced by the route layer + this module):
//   - We NEVER generate a recap while `phaseOf(session) !== 'idle'`.
//     The route returns 409/410/412 in those cases; clients also gate
//     auto-fire on phase. Belt + braces.
//   - We NEVER store an error in cache. A failed run leaves
//     session.recap with `status:'error'`; the next requestGenerate
//     re-tries from scratch.
//   - We do NOT persist recap to disk (per spec). Server restart drops
//     all recaps; the client's idle timer will re-arm and regenerate.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { config as serverConfig } from './config.js'
import { callAnthropicMessages } from './anthropic-api.js'
import type { SessionRecap, SessionRecapStats } from '../shared/session-info.js'
import { HttpError } from './errors.js'

// ── Types ──────────────────────────────────────────────────────────

export type { SessionRecap, SessionRecapStats } from '../shared/session-info.js'

/** Hooks the recapManager calls back into the SessionManager.
 *  Kept as a thin interface so this module never imports
 *  SessionManager and the unit tests can mock both sides. */
export interface RecapManagerDeps {
  /** Current SessionPhase. recapManager refuses to generate when not 'idle'. */
  getPhase: (sessionId: string) => 'idle' | 'working' | 'terminated' | 'dormant' | 'unknown'
  /** Live message history for the session (snapshot). Returns null
   *  when the session is dormant — recapManager surfaces a 412. */
  getHistory: (sessionId: string) => SDKMessage[] | null
  /** Mutator: write the session's recap field. The caller is expected
   *  to also broadcast (via broadcastRecap). recapManager calls these
   *  in pairs after every transition. */
  setRecap: (sessionId: string, recap: SessionRecap | undefined) => void
  /** Push a `session-recap-update` to the session's subscribers AND
   *  fan out a session-update on the global channel so the sidebar
   *  recap-status indicator (if any) stays current. */
  broadcastRecap: (sessionId: string, recap: SessionRecap | undefined) => void
}

// ── Language detection ─────────────────────────────────────────────
//
// (Unchanged from the previous revision — see git history for the long
// design note. Counts non-Latin script characters in user-role text and
// returns a language label, or null for Latin-script transcripts where
// the LLM has to infer English/French/Spanish/etc. from context.)

export function detectLanguage(userText: string): string | null {
  let cjk = 0
  let kana = 0
  let hangul = 0
  let cyrillic = 0
  let arabic = 0
  let hebrew = 0
  let thai = 0
  let devanagari = 0
  for (const ch of userText) {
    const cp = ch.codePointAt(0)
    if (cp == null) continue
    if (
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0x1100 && cp <= 0x11ff) ||
      (cp >= 0x3130 && cp <= 0x318f) ||
      (cp >= 0xa960 && cp <= 0xa97f) ||
      (cp >= 0xd7b0 && cp <= 0xd7ff)
    ) hangul++
    else if (cp >= 0x3040 && cp <= 0x30ff) kana++
    else if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x20000 && cp <= 0x2ebef) ||
      (cp >= 0x30000 && cp <= 0x3134f) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0x2f800 && cp <= 0x2fa1f)
    ) cjk++
    else if (cp >= 0x0400 && cp <= 0x04ff) cyrillic++
    else if (cp >= 0x0600 && cp <= 0x06ff) arabic++
    else if (cp >= 0x0590 && cp <= 0x05ff) hebrew++
    else if (cp >= 0x0e00 && cp <= 0x0e7f) thai++
    else if (cp >= 0x0900 && cp <= 0x097f) devanagari++
  }
  const MIN = 4
  if (hangul >= MIN) return 'Korean (한국어)'
  if (kana >= MIN) return 'Japanese (日本語)'
  if (cjk >= MIN) return 'Chinese (中文)'
  if (cyrillic >= MIN) return 'Russian (Русский)'
  if (arabic >= MIN) return 'Arabic (العربية)'
  if (hebrew >= MIN) return 'Hebrew (עברית)'
  if (thai >= MIN) return 'Thai (ไทย)'
  if (devanagari >= MIN) return 'Hindi (हिन्दी)'
  return null
}

// ── History extraction ─────────────────────────────────────────────

interface ExtractedLine {
  role: 'User' | 'Assistant'
  text: string
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: string }>)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
}

function extractToolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return (content as Array<{ type?: string; name?: string }>)
    .filter((b) => b.type === 'tool_use' && typeof b.name === 'string')
    .map((b) => b.name as string)
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}

function extractHistory(messages: SDKMessage[]): {
  lines: ExtractedLine[]
  stats: SessionRecapStats
  language: string | null
} {
  const lines: ExtractedLine[] = []
  const toolSet = new Set<string>()
  let userTurns = 0
  let assistantTurns = 0
  let totalCost = 0
  let totalDuration = 0
  let userTextBuf = ''

  for (const msg of messages) {
    const m = msg as Record<string, unknown>
    const type = m.type as string

    if (type === 'user') {
      const content = (m as { message?: { content?: unknown } }).message?.content
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
      const cost = (m as { total_cost_usd?: number }).total_cost_usd
      if (typeof cost === 'number') totalCost = cost
      const dur = (m as { duration_ms?: number }).duration_ms
      if (typeof dur === 'number') totalDuration += dur
    }
  }

  const stats: SessionRecapStats = {
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

function buildTranscript(lines: ExtractedLine[], language: string | null): string {
  const CHAR_BUDGET = 12_000
  const formatted = lines.map((l, i) => `[${i + 1}] ${l.role}: ${l.text}`)
  const tailHint = language
    ? `\n\n---\nWrite the recap summary in ${language}.`
    : `\n\n---\nWrite the recap summary in the same language the user uses in their messages above.`
  const effectiveBudget = CHAR_BUDGET - tailHint.length
  const total = formatted.reduce((n, s) => n + s.length + 1, 0)
  if (total <= effectiveBudget) return formatted.join('\n') + tailHint

  const head = formatted.slice(0, 3)
  let budget = effectiveBudget - head.reduce((n, s) => n + s.length + 1, 0) - 40
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
    temperature: 0,
  })
  return text.replace(/<\/?React\.Fragment\s*>|<>|<\/>/g, '').replace(/\s{2,}/g, ' ').trim()
}

// ── State machine ──────────────────────────────────────────────────

/** Owns the recap lifecycle for every session. One instance per
 *  SessionManager. Public surface is intentionally tiny — `invalidate`
 *  on every conversation mutation, `requestGenerate` on every recap
 *  trigger (manual or automatic). All edge cases (concurrent requests,
 *  busy session, dormant session, missing auth) are handled inside.
 *
 *  Why a class rather than module-level state: the previous file used
 *  module-scoped Maps for cache + inflight, which made per-instance
 *  isolation in tests painful and tied recap lifetime to the process
 *  rather than the SessionManager that owns it. */
export class RecapManager {
  private deps: RecapManagerDeps
  /** In-flight LLM calls keyed by sessionId. A second concurrent
   *  requestGenerate hits the same promise — no double-spend. */
  private inflight = new Map<string, Promise<SessionRecap>>()
  /** Monotonic generation counter per session. Bumped on every
   *  invalidate(); the in-flight #doGenerate snapshots the value at
   *  start and #applyResult drops the final ready/error write when the
   *  current generation has moved on. The transient 'pending' write is
   *  still broadcast so the UI can show progress before invalidation. */
  private generation = new Map<string, number>()

  constructor(deps: RecapManagerDeps) {
    this.deps = deps
  }

  /** Drop any stored recap for a session. Called from SessionManager
   *  on every conversation mutation (send, sendContent, delete,
   *  unload). The next requestGenerate triggers a fresh LLM call. */
  invalidate(sessionId: string): void {
    this.deps.setRecap(sessionId, undefined)
    this.deps.broadcastRecap(sessionId, undefined)
    // Bump the generation so any in-flight LLM call landing after this
    // point is recognised as stale and discarded by #applyResult. We do
    // NOT cancel the in-flight call itself — the network round-trip is
    // already paid for, dropping the result is cleaner than tearing
    // down the AbortController plumbing.
    this.generation.set(sessionId, (this.generation.get(sessionId) ?? 0) + 1)
  }

  /**
   * Request a recap for a session. Returns the resulting `SessionRecap`.
   * Throws `HttpError` for unrecoverable cases the route layer should
   * surface verbatim:
   *   409 — phase !== 'idle' (working / queued / pending permission)
   *   410 — phase === 'terminated'
   *   412 — phase === 'dormant' (session unloaded; resume first)
   *   404 — phase === 'unknown' (session not in the manager's map)
   *
   * Cache rules:
   *   - status:'ready' is returned as-is and counts as fresh.
   *     `invalidate()` is the only way fresh becomes stale.
   *   - status:'pending' from a previous call dedups — second caller
   *     awaits the same promise.
   *   - status:'error' is NOT treated as fresh. The next call retries.
   */
  async requestGenerate(sessionId: string): Promise<SessionRecap> {
    const phase = this.deps.getPhase(sessionId)
    switch (phase) {
      case 'unknown':
        throw new HttpError(404, `session ${sessionId} not found`)
      case 'terminated':
        throw new HttpError(410, `session ${sessionId} is terminated — recap unavailable`)
      case 'dormant':
        throw new HttpError(
          412,
          `session ${sessionId} is dormant — resume it before generating a recap`,
        )
      case 'working':
        throw new HttpError(
          409,
          `session ${sessionId} is busy — wait for the current turn to finish before generating a recap`,
        )
      case 'idle':
        break
      default: {
        const _exhaustive: never = phase
        throw new HttpError(500, `unexpected phase: ${_exhaustive}`)
      }
    }

    // In-flight dedup — second concurrent caller reuses the first's
    // promise instead of double-spending on the LLM.
    const existing = this.inflight.get(sessionId)
    if (existing) return existing

    const history = this.deps.getHistory(sessionId)
    if (!history) {
      // Race: phase said idle but history disappeared (session was
      // unloaded between the phase check and here). Treat as 412.
      throw new HttpError(412, `session ${sessionId} is no longer available`)
    }

    const promise = this.#doGenerate(sessionId, history)
    this.inflight.set(sessionId, promise)
    try {
      return await promise
    } finally {
      this.inflight.delete(sessionId)
    }
  }

  /** Drive one generation cycle: extract → call LLM → apply.
   *  Sets `pending` immediately so live subscribers see the loading
   *  state without waiting for the API round-trip. */
  async #doGenerate(sessionId: string, history: SDKMessage[]): Promise<SessionRecap> {
    const { lines, stats, language } = extractHistory(history)
    // Snapshot the generation at dispatch. invalidate() bumps it; the
    // final ready/error apply is then recognised as stale and dropped.
    const gen = this.generation.get(sessionId) ?? 0

    // Empty session: synthesize a ready recap with no LLM call. Same
    // behaviour as the old empty-session shortcut, but now the result
    // also lands on session.recap so the UI can render it consistently.
    if (lines.length === 0) {
      const empty: SessionRecap = {
        status: 'ready',
        summary: 'No messages yet.',
        stats,
        generatedAt: Date.now(),
      }
      this.#applyResult(sessionId, empty, gen)
      return empty
    }

    // Auth check up-front — the LLM call would fail anyway, but failing
    // here gives a sharper error message than the generic fetch error.
    if (!serverConfig.authToken) {
      const errored: SessionRecap = {
        status: 'error',
        error: 'Recap unavailable: authToken is not configured. Set authToken in config.json.',
        generatedAt: Date.now(),
      }
      this.#applyResult(sessionId, errored, gen)
      // Throw so the route returns the error to the explicit caller too.
      throw new Error(errored.error ?? 'authToken not configured')
    }

    // Mark pending so live clients show the loading state immediately.
    // The pending broadcast is intentionally NOT gated on generation —
    // it represents an in-flight call the user just triggered, and the
    // UI relies on it to show a spinner before the LLM round-trip.
    const pending: SessionRecap = { status: 'pending' }
    this.#applyResult(sessionId, pending, gen)

    try {
      const transcript = buildTranscript(lines, language)
      const summary = await callAnthropic(transcript, language)
      const ready: SessionRecap = {
        status: 'ready',
        summary,
        stats,
        generatedAt: Date.now(),
      }
      this.#applyResult(sessionId, ready, gen)
      return ready
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const errored: SessionRecap = {
        status: 'error',
        error: message,
        generatedAt: Date.now(),
      }
      this.#applyResult(sessionId, errored, gen)
      // Re-throw so the route caller sees the failure too.
      throw err
    }
  }

  /** Write + broadcast in one place. Two staleness gates:
   *
   *  1. `gen` — if invalidate() bumped the generation while this LLM
   *     call was in flight, the result is stale; drop it instead of
   *     overwriting the freshly-cleared cache with a stale ready/error.
   *     The gate is bypassed when no `gen` is supplied (legacy callers).
   *
   *  2. phase — if the session has gone away (terminated/dormant/
   *     unknown) between dispatch and result, the setRecap target may
   *     not exist; skip the write and broadcast. */
  #applyResult(sessionId: string, recap: SessionRecap, gen?: number): void {
    if (gen !== undefined) {
      const current = this.generation.get(sessionId) ?? 0
      if (current !== gen) return
    }
    const phase = this.deps.getPhase(sessionId)
    if (phase === 'unknown' || phase === 'terminated' || phase === 'dormant') return
    this.deps.setRecap(sessionId, recap)
    this.deps.broadcastRecap(sessionId, recap)
  }
}

// ── Backwards-compat shim ──────────────────────────────────────────
//
// A few legacy call sites (the test file, and recap.test.ts) still
// import `generateRecap` and `invalidateRecapCache` from this module.
// We keep them as thin wrappers around a module-local RecapManager
// instance that mocks the SessionManager interaction so the existing
// pure-extraction tests keep working without rewriting them.
//
// New code should NOT import these — go through SessionManager's
// recapManager instance instead.

interface LegacyEntry { history: SDKMessage[] }
const legacyState = new Map<string, LegacyEntry>()
const legacyRecaps = new Map<string, SessionRecap>()
const legacyManager = new RecapManager({
  getPhase: (id) => (legacyState.has(id) || legacyRecaps.has(id) ? 'idle' : 'unknown'),
  getHistory: (id) => legacyState.get(id)?.history ?? null,
  setRecap: (id, recap) => {
    if (recap === undefined) legacyRecaps.delete(id)
    else legacyRecaps.set(id, recap)
  },
  broadcastRecap: () => { /* legacy shim — no broadcast */ },
})

/** @deprecated Legacy shim for the standalone tests. New code should
 *  go through SessionManager.recapManager. */
export async function generateRecap(
  messages: SDKMessage[],
  sessionId: string,
): Promise<{ summary: string; stats: SessionRecapStats; cached: boolean; generatedAt: number }> {
  // Cache-hit emulation: if we already have a ready recap for this id
  // and the history hasn't changed, return it as cached. Mirrors the
  // pre-refactor test expectations.
  const prevHistory = legacyState.get(sessionId)?.history
  const prevReady = legacyRecaps.get(sessionId)
  if (
    prevReady?.status === 'ready' &&
    prevHistory &&
    prevHistory.length === messages.length &&
    prevHistory.every((m, i) => (m as { uuid?: string }).uuid === (messages[i] as { uuid?: string }).uuid)
  ) {
    return {
      summary: prevReady.summary ?? '',
      stats: prevReady.stats ?? emptyRecapStats(),
      cached: true,
      generatedAt: prevReady.generatedAt ?? Date.now(),
    }
  }
  legacyState.set(sessionId, { history: messages })
  // LRU cap mirrors the previous module-level CACHE_MAX_ENTRIES.
  if (legacyState.size > 200) {
    const oldest = legacyState.keys().next().value
    if (oldest) {
      legacyState.delete(oldest)
      legacyRecaps.delete(oldest)
    }
  }
  const recap = await legacyManager.requestGenerate(sessionId)
  // requestGenerate may return any RecapStatus. Only 'ready' carries
  // stats/generatedAt; other statuses surface through the return shape
  // below as defaulted values rather than crashing on a non-null
  // assertion.
  if (recap.status === 'ready') {
    return {
      summary: recap.summary ?? '',
      stats: recap.stats ?? emptyRecapStats(),
      cached: false,
      generatedAt: recap.generatedAt ?? Date.now(),
    }
  }
  // Non-ready (pending/error) — preserve the existing test contract
  // (string summary, zeroed stats) without throwing.
  return {
    summary: '',
    stats: emptyRecapStats(),
    cached: false,
    generatedAt: recap.generatedAt ?? Date.now(),
  }
}

function emptyRecapStats(): SessionRecapStats {
  return {
    messageCount: 0,
    userTurns: 0,
    assistantTurns: 0,
    totalCostUsd: 0,
    durationMs: 0,
    toolsUsed: [],
  }
}

/** @deprecated Legacy shim. Use RecapManager.invalidate via
 *  SessionManager.recapManager. */
export function invalidateRecapCache(sessionId: string): void {
  legacyState.delete(sessionId)
  legacyRecaps.delete(sessionId)
  legacyManager.invalidate(sessionId)
}
