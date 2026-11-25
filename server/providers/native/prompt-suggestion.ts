// server/providers/native/prompt-suggestion.ts
/**
 * Turn-end suggestion suppression chain + the SUGGESTION MODE prompt
 * constant. Pure decision logic: no I/O, no side effects — the orchestrator
 * (NativeSession) gathers the inputs and acts on the reason. Cost protection
 * is the point: a cache-cold prefix means a full-price re-read, so the chain
 * refuses to generate rather than pay for it (design §5, research note
 * docs/research/2026-11-25-prompt-suggestions.md §3.2 / §3.4).
 */
import type { TokenUsage } from './vocabulary/types.js'

/** The fixed user message appended after the snapshot prefix. Verbatim from
 *  the CLI's prompt constant I (research §3.3, claude.exe @ 263,539,803) —
 *  every line, including the safety clause, copied unchanged. */
export const SUGGESTION_PROMPT = `[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]

FIRST: Look at the user's recent messages and original request.

Your job is to predict what THEY would type - not what you think they should do.

THE TEST: Would they think "I was just about to type that"?

EXAMPLES:
User asked "fix the bug and run tests", bug is fixed → "run the tests"
After code written → "try it out"
Claude offers options → suggest the one the user would likely pick, based on conversation
Claude asks to continue → "yes" or "go ahead"
Task complete, obvious follow-up → "commit this" or "push it"
After error or misunderstanding → silence (let them assess/correct)

Be specific: "run the tests" beats "continue".

NEVER SUGGEST:
- Evaluative ("looks good", "thanks")
- Questions ("what about...?")
- Claude-voice ("Let me...", "I'll...", "Here's...")
- New ideas they didn't ask about
- Multiple sentences

Stay silent if the next step isn't obvious from what the user said.

Stay silent if a suggestion could be unsafe or inappropriate — including any sensitive topic (security incidents, credentials, harm, private data). Even when the user is doing legitimate security or cybersecurity work, do not predict potentially unsafe actions.

Format: 2-12 words, match the user's style. Or nothing.

Reply with ONLY the suggestion, no quotes or explanation.`

/** Output budget for the suggestion request (design §4: unconditional 1024 —
 *  a defensive cap for gateways that ignore thinking:disabled, not a cost
 *  reservation). */
export const SUGGESTION_MAX_TOKENS = 1024

/** Native sends bare ephemeral cache breakpoints = 5-minute TTL. */
export const SUGGESTION_CACHE_TTL_MS = 300_000

/** Generate only while the prefix is younger than TTL × 0.9 (CLI zln). */
export const SUGGESTION_WARM_RATIO = 0.9

/** Uncached-tail ceiling: last round's input + output over this is not worth
 *  a full-price read (CLI O, P = 1e4). */
export const SUGGESTION_TAIL_LIMIT = 10_000

/** The wire shape of the last main request, captured at send time: the fork
 *  replays this prefix byte-for-byte so the parent's cache breakpoints still
 *  hit. `at` is the capture timestamp (ms). */
export interface SuggestionSnapshot {
  at: number
  model: string
  system: string
  tools: unknown[]
  messages: unknown[]
}

export interface SuggestionGateInput {
  enabled: boolean
  assistantCount: number
  turnIsError: boolean
  permissionMode: string
  currentModel: string
  snapshot: SuggestionSnapshot | null
  lastRoundUsage: TokenUsage | null
  now: number
}

/** The suppression chain (design §5), first hit wins; null = generate.
 *  Reason strings align with the CLI telemetry names for cross-reference.
 *  The evidence gate treats a missing cacheReadTokens as cold: the usage
 *  bridge omits the field when the gateway reports no cache reads, and no
 *  report is no evidence — cache-less gateways stay silently off. */
export function suggestionSuppressionReason(input: SuggestionGateInput): string | null {
  if (input.enabled === false) return 'disabled'
  if (input.assistantCount < 2) return 'early_conversation'
  if (input.turnIsError) return 'last_response_error'
  if (input.permissionMode === 'plan') return 'plan_mode'
  const snapshot = input.snapshot
  if (snapshot === null) return 'no_snapshot'
  if (input.currentModel !== snapshot.model) return 'model_switched'
  const usage = input.lastRoundUsage
  if (usage === null) return 'cache_cold'
  if ((usage.cacheReadTokens ?? 0) === 0) return 'cache_cold'
  if (input.now - snapshot.at >= SUGGESTION_CACHE_TTL_MS * SUGGESTION_WARM_RATIO) return 'cache_cold'
  if (usage.inputTokens + usage.outputTokens > SUGGESTION_TAIL_LIMIT) return 'uncached'
  return null
}