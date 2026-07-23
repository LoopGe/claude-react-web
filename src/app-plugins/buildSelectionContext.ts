// Build a MessageSelectionCommandContext from a live DOM Selection.
//
// The selection is a SINGLE-GESTURE capability: only the text the user just
// selected, on ONE message. This module enforces the plan's selection rules:
//   - collapsed / empty selection → null (no plugin menu shown).
//   - selection spanning more than one message boundary → rejected (the
//     start and end containers must both lie within `messageBoundary`).
//   - text truncated to selectionDefaultChars (20 000 hard cap), with
//     `truncated` set when it was cut.
//   - DOM Range / coordinates are NOT included — only the text + length +
//     truncated flag. The client keeps the anchor (element + rect) separately
//     in invocation-anchor-store.

import { LIMITS } from '../../shared/app-plugins/validation.js'
import type { MessageSelectionCommandContext } from '../../shared/app-plugins/command-context.js'

export interface BuildSelectionParams {
  selection: Selection
  sessionId: string
  messageId: string
  /** The element that bounds the message the gesture is on. The selection's
   *  start AND end containers must be inside it, else the selection crosses
   *  messages and is rejected. */
  messageBoundary: HTMLElement
  role: 'user' | 'assistant' | 'system' | 'tool'
  contentBlockType: 'text' | 'code' | 'thinking' | 'tool-use' | 'tool-result'
}

export type BuildSelectionResult =
  | { ok: true; context: MessageSelectionCommandContext }
  | { ok: false; reason: 'empty' | 'cross-message' | 'sensitive-block' }

/** Build the context. Returns `{ok:false, reason:'empty'}` for a collapsed/
 *  empty selection (caller shows no menu), `cross-message` for a selection
 *  that leaves the message boundary, `sensitive-block` for thinking/tool-result
 *  blocks the host doesn't expose to ordinary selection plugins by default. */
export function buildSelectionContext(params: BuildSelectionParams): BuildSelectionResult {
  const { selection, sessionId, messageId, messageBoundary, role, contentBlockType } = params
  if (selection.isCollapsed || selection.rangeCount === 0) return { ok: false, reason: 'empty' }
  const range = selection.getRangeAt(0)
  // Reject cross-message / cross-panel selections: both endpoints must be
  // inside the message boundary.
  if (!messageBoundary.contains(range.startContainer) || !messageBoundary.contains(range.endContainer)) {
    return { ok: false, reason: 'cross-message' }
  }
  // Sensitive blocks default to off for the ordinary selection menu.
  if (contentBlockType === 'thinking' || contentBlockType === 'tool-result') {
    return { ok: false, reason: 'sensitive-block' }
  }
  const text = selection.toString()
  if (!text.trim()) return { ok: false, reason: 'empty' }
  const originalLength = text.length
  let truncated = false
  let body = text
  // Hard cap at selectionMaxChars (20 000); flag truncated over
  // selectionDefaultChars (5 000) so the plugin knows the selection was
  // larger than the default transmit window even when not hard-cut.
  if (originalLength > LIMITS.selectionMaxChars) {
    body = text.slice(0, LIMITS.selectionMaxChars)
    truncated = true
  } else if (originalLength > LIMITS.selectionDefaultChars) {
    truncated = true
  }
  return {
    ok: true,
    context: {
      source: 'message-selection',
      invocationId: '', // server-generated on execute
      commandId: '', // filled by the caller
      invokedAt: Date.now(),
      sessionId,
      messageId,
      message: { role, contentBlockType },
      selection: { text: body, length: originalLength, truncated },
    },
  }
}
