/**
 * Shared shape probe for an assistant message frame.
 *
 * An assistant message reaches this app in two representations:
 *
 * - **Per-block frames** — the CLI's dominant JSONL shape and the shape its
 *   live stream emits: one frame per content block, each with its own uuid.
 * - **A whole-message frame** — one frame carrying every content block under
 *   the message's original uuid. The live stream splits such a message into
 *   derived-uuid frames
 *   (`uuid.slice(0,24) + blockIndex.toString(16).padStart(12,'0')`), so the
 *   two representations share no uuid.
 *
 * `message.id` is the API response identity and is unique per response, so it
 * is the only identity common to both. Both sides use it to recognize a
 * whole-message frame whose response is already held under different uuids:
 * the client's replay merge (`dropCachedAssistantResponses`) and the server's
 * transcript reconcile (`backfillFromEntries` / `foldSidecarRows`).
 *
 * The two consumers apply deliberately different completeness rules on top of
 * the id. The server requires the recorded blocks to reproduce the line
 * exactly before it skips it, because a partial live recording must not lose
 * the blocks the disk line alone carries. The client treats its cached items
 * as the authoritative response for the merge and keeps a frame whose own uuid
 * is cached for the overlap bracket (see the function's own doc for why).
 */

export interface AssistantMessageShape {
  /** The API response id (`message.id`). */
  id: string
  /** Content blocks, or null when the message's content isn't an array. */
  blocks: unknown[] | null
}

/** Returns the assistant frame's response id and blocks, or null when the
 *  message isn't an assistant frame or carries no response id. */
export function assistantMessageShapeOf(msg: unknown): AssistantMessageShape | null {
  if (!msg || typeof msg !== 'object') return null
  const m = msg as { type?: unknown; message?: { id?: unknown; content?: unknown } }
  if (m.type !== 'assistant') return null
  const id = m.message?.id
  if (typeof id !== 'string' || id === '') return null
  return { id, blocks: Array.isArray(m.message?.content) ? m.message.content : null }
}