// The native WIRE adapter (design R3): neutral model history → Anthropic API
// request messages. This is a BOUNDARY module — it imports the neutral
// vocabulary AND the API-request projection (attachment-projection), never the
// reverse. The vocabulary stays pure; the T18 neutrality pin excludes this
// directory (and attachment-projection.ts) from the core purity scan.
//
// Ownership split vs neutral replay (T13): replay folds the durable event
// stream into NEUTRAL model history — first-class role-tool ToolResultMessages
// (ungrouped), raw-JSON tool-call arguments — applying the EVENT-level
// semantics (compact floor, sidechain skip, supplement dedup, skill body
// verbatim, signed-thinking retention). This adapter owns the API-level
// semantics the Anthropic Messages request requires:
//   - consecutive tool results grouped into ONE user message per assistant turn
//     (an assistant or non-tool user message closes the open group);
//   - raw-JSON tool-call arguments parsed into tool_use.input;
//   - the signed-thinking filter (unsigned thinking / empty redacted data is
//     rejected by the API on replay, so it is stripped here);
//   - file/PDF projection, delegated verbatim to attachment-projection's
//     projectNativeMessages so the two paths can never diverge.
//
// Grouping is a WIRE concern, not a vocabulary one: the neutral history keeps
// tool results first-class; only the request shape needs them merged.

import { isRetainedThinkingBlock, parseToolInput, type ContentBlock } from '../vocabulary/types.js'
import type { RequestMessage, ToolResultMessage } from '../vocabulary/message.js'
import { projectNativeMessages, type NativeProjectionOptions } from '../attachment-projection.js'

/** Project one neutral assistant block to its API shape. Only text / reasoning
 *  / tool-call occur in assistant output; any other kind is a contract violation
 *  surfaced loudly (mirrors the host adapter's sdkAssistantBlock). The reasoning
 *  projection preserves the signature / redacted data the API needs on replay;
 *  the retention filter runs over the projected blocks afterwards. */
function wireAssistantBlock(block: ContentBlock): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      if (block.redacted === true) return { type: 'redacted_thinking', data: block.data }
      return {
        type: 'thinking',
        thinking: block.text,
        ...(typeof block.signature === 'string' && block.signature !== '' ? { signature: block.signature } : {}),
      }
    case 'tool-call':
      return { type: 'tool_use', id: block.id, name: block.name, input: parseToolInput(block.arguments) }
    default:
      throw new Error(`native wire adapter: block kind "${(block as { type: string }).type}" is not an assistant emission`)
  }
}

/** Project one neutral user-input / tool-result content block to its API shape.
 *  Text passes through; a file occurrence keeps its resolved attachment for
 *  attachment-projection to turn into handle text / a PDF document; a legacy
 *  base64 image is already API-shaped. A store-backed image ref needs byte
 *  projection that is not yet wired into the request path — surfaced loudly
 *  rather than sent as a non-API shape. */
function wireInputBlock(block: ContentBlock): unknown {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'file':
      return { type: 'file', attachment: block.attachment }
    case 'image':
      if ('attachment' in block) {
        throw new Error('native wire adapter: store-backed image ref projection is not yet wired into the request path')
      }
      return { type: 'image', source: block.source }
    default:
      throw new Error(`native wire adapter: block kind "${(block as { type: string }).type}" is not user/tool input`)
  }
}

/** One first-class tool result → a tool_result block. The inner content is
 *  projected like user input (text / file / image); is_error defaults to false
 *  (mirrors the host adapter's projectToolResult). */
function wireToolResult(message: ToolResultMessage): Record<string, unknown> {
  return {
    type: 'tool_result',
    tool_use_id: message.toolCallId,
    content: message.content.map(wireInputBlock),
    is_error: message.isError ?? false,
  }
}

/**
 * Project neutral model history to the Anthropic API request `messages` array.
 *
 * Consecutive role-tool messages merge into ONE user message (the API requires
 * every tool_result for an assistant turn in a single user message); an
 * assistant or non-tool user message closes the open group. Assistant blocks
 * are projected and then passed through the signed-thinking filter. File/PDF
 * projection is delegated to projectNativeMessages, which builds an independent
 * request copy on every round — the neutral history is never mutated.
 *
 * System and developer messages are NOT conversation messages: the system
 * prompt rides StreamRequest.system and tool additions/removals shape the
 * `tools` array. Either appearing in model history is a producer contract
 * violation, surfaced loudly.
 */
export async function projectNativeHistoryToWire(
  history: readonly RequestMessage[],
  opts: NativeProjectionOptions,
  signal: AbortSignal,
): Promise<unknown[]> {
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = []
  // The open tool-result group: consecutive role-tool messages append their
  // tool_result block here instead of starting a new user message.
  let openResults: { role: 'user'; content: unknown[] } | null = null

  for (const message of history) {
    switch (message.role) {
      case 'tool': {
        const block = wireToolResult(message)
        if (openResults) {
          openResults.content.push(block)
        } else {
          openResults = { role: 'user', content: [block] }
          messages.push(openResults)
        }
        break
      }
      case 'assistant':
        messages.push({
          role: 'assistant',
          content: message.content.map(wireAssistantBlock).filter(isRetainedThinkingBlock),
        })
        openResults = null
        break
      case 'user':
        messages.push({ role: 'user', content: message.content.map(wireInputBlock) })
        openResults = null
        break
      case 'system':
      case 'developer':
        throw new Error(`native wire adapter: role "${message.role}" is not a conversation message (system prompt and tool additions ride separate request fields)`)
    }
  }

  return projectNativeMessages(messages, opts, signal)
}
