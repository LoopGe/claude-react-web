// Compact summary generator — the LLM summarisation behind
// SessionManager.compact().
//
// Shares the transcript-extraction machinery with recap.ts (extractHistory /
// buildTranscript) but uses a compact-appropriate system prompt: instead of a
// "what was I doing" recap for a returning user, the summary must be a
// drop-in continuation seed — everything the fresh session needs to keep
// working (decisions, constraints, open questions, file names, the immediate
// next step). The summary is later seeded into the new session as a
// `shouldQuery:false` user message (merged into the next real user turn), so
// it reads like the user restating where they are — not like a status report.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { config as serverConfig } from './config.js'
import { callAnthropicMessages } from './anthropic-api.js'
import { extractHistory, buildTranscript } from './recap.js'

const COMPACT_SYSTEM_PROMPT = `You are compressing a Claude Code conversation so it can continue in a fresh session. Write a compact hand-off summary the user (or a fresh model) can continue from directly. Preserve:
1. The high-level task and goal.
2. Decisions made and why (briefly).
3. Constraints, requirements, and open questions.
4. Concrete artifacts: file paths, function/component names, commands run.
5. The immediate next step, if one is apparent.

Write in dense prose, not bullet soup. Do NOT restate generic status ("we chatted about X"). Keep file paths, error messages, and code identifiers verbatim. Omit anything the continuation cannot act on (greetings, sign-offs, ceremony). Start directly.`

/** Summarise a session's message history into a compact continuation seed.
 *  Returns an empty string when the history has no compressible content
 *  (e.g. no user/assistant turns) — the caller should then skip seeding and
 *  fall back to a plain clear. */
export async function summarizeForCompact(messages: SDKMessage[], sessionModel?: string): Promise<string> {
  const { lines, language } = extractHistory(messages)
  if (lines.length === 0) return ''

  if (!serverConfig.authToken) {
    throw new Error('compact unavailable: authToken is not configured. Set authToken in config.json.')
  }

  const transcript = buildTranscript(lines, language, {
    tailHint: language
      ? `\n\n---\nWrite the hand-off summary in ${language}.`
      : `\n\n---\nWrite the hand-off summary in the same language the user uses in their messages above.`,
  })
  const model = serverConfig.recapModel || sessionModel
  if (!model) throw new Error('No model configured for compact summary and session has no model')

  const text = await callAnthropicMessages({
    model,
    system: COMPACT_SYSTEM_PROMPT,
    userContent: transcript,
    maxTokens: 1000,
    temperature: 0,
  })
  // Compact summaries are plain prose; collapse the same whitespace-trim
  // recap uses (no code fences / JSX fragments to strip here).
  return text.replace(/\s{2,}/g, ' ').trim()
}
