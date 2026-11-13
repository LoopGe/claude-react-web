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
import { callAnthropicMessages, type AuxLlmTarget } from './anthropic-api.js'
import { extractHistory, buildTranscript } from './recap.js'

const COMPACT_SYSTEM_PROMPT = `You are compressing a Claude Code conversation so it can continue in a fresh session. Write a compact hand-off summary the user (or a fresh model) can continue from directly. Preserve:
1. The high-level task and goal.
2. Decisions made and why (briefly).
3. Constraints, requirements, and open questions.
4. Concrete artifacts: file paths, function/component names, commands run.
5. The immediate next step, if one is apparent.

Write in dense prose, not bullet soup. Do NOT restate generic status ("we chatted about X"). Keep file paths, error messages, and code identifiers verbatim. When attachment blocks are present, preserve the upload id and name needed for later AttachmentRead calls, and state any hydration truncation or omission that limits what you actually saw. Omit anything the continuation cannot act on (greetings, sign-offs, ceremony). Start directly.`

export interface CompactSummaryOptions {
  /** Ordered hydrated handles/text and native image/document blocks. */
  attachmentContent?: readonly unknown[]
  /** Current effective session model, required only for native media. */
  effectiveModel?: string
  hasAttachments?: boolean
  hasNativeMedia?: boolean
}

/** Summarise a session's message history into a compact continuation seed.
 *  Returns an empty string when the history has no compressible content
 *  (e.g. no user/assistant turns) — the caller should then skip seeding and
 *  fall back to a plain clear. `target` (the session's profile credentials +
 *  its resolved model) comes from SessionManager.auxTargetFor. */
export async function summarizeForCompact(
  messages: SDKMessage[],
  target?: AuxLlmTarget,
  options?: CompactSummaryOptions,
): Promise<string> {
  const { lines, language } = extractHistory(messages)
  const attachments = options?.attachmentContent ?? []
  if (lines.length === 0 && attachments.length === 0) return ''

  if (!target?.authToken) {
    throw new Error("compact unavailable: the session's profile has no authToken configured. Set authToken in config.json.")
  }

  const transcript = buildTranscript(lines, language, {
    tailHint: language
      ? `\n\n---\nWrite the hand-off summary in ${language}.`
      : `\n\n---\nWrite the hand-off summary in the same language the user uses in their messages above.`,
  })
  const nativeMedia = options?.hasNativeMedia === true || attachments.some((block) => {
    const type = (block as { type?: unknown })?.type
    return type === 'image' || type === 'document'
  })
  const model = nativeMedia ? options?.effectiveModel : target.model
  if (!model) throw new Error('No model configured for compact summary and session has no model')

  const text = await callAnthropicMessages({
    model,
    target,
    system: COMPACT_SYSTEM_PROMPT,
    userContent: attachments.length > 0
      ? [{ type: 'text', text: transcript }, ...attachments]
      : transcript,
    // 2048: reasoning-model thinking headroom — see recap.ts. Thinking
    // consumes max_tokens before the summary text on GLM / DeepSeek
    // gateways; 1000 was sized for the summary alone.
    maxTokens: 2048,
    temperature: 0,
    caller: 'compact-summary',
  })
  // Compact summaries are plain prose; collapse the same whitespace-trim
  // recap uses (no code fences / JSX fragments to strip here).
  const summary = text.replace(/\s{2,}/g, ' ').trim()
  if (!summary && attachments.length > 0) {
    throw new Error('empty compact summary for attachment input')
  }
  return summary
}
