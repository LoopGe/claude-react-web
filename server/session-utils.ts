/**
 * Utilities for extracting classifier-consumable data from a Session.
 */

import type { Session } from './session-types.js'

/** Extract the last N user/assistant messages from the session history
 *  as lightweight role+text pairs for the auto-mode classifier.
 *  System messages and tool results are skipped — only top-level
 *  user prompts and assistant text blocks are included. */
export function getMessagesForClassifier(
  session: Session,
  maxMessages: number,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  // session.history uses the SDK's SDKMessage type which has a looser
  // shape than the frontend's SdkMessage. We access fields defensively.
  const history = session.history ?? []
  const result: Array<{ role: 'user' | 'assistant'; content: string }> = []

  // Walk backwards to grab the most recent entries first.
  for (let i = history.length - 1; i >= 0 && result.length < maxMessages; i--) {
    const msg = history[i] as Record<string, unknown>
    if (!msg.message) continue

    const message = msg.message as Record<string, unknown> | undefined
    if (!message) continue

    if (msg.type === 'user' && message.role === 'user') {
      const text = extractText(message.content)
      if (text) result.push({ role: 'user', content: text })
    } else if (msg.type === 'assistant' && message.role === 'assistant') {
      // For assistant messages, extract only text blocks (not tool_use).
      // This mirrors Claude Code's security decision to exclude tool_use
      // inputs from classifier context.
      const text = extractAssistantText(message.content)
      if (text) result.push({ role: 'assistant', content: text })
    }
  }

  result.reverse() // chronological order
  return result
}

/** Extract plain text from a user message's content field.
 *  Content can be a string or an array of content blocks. */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n')
  }
  return ''
}

/** Extract text blocks from an assistant message, skipping tool_use. */
function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
}
