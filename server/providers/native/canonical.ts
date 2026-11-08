/** Protocol-neutral streaming IR. The turn loop (loop.ts) consumes ONLY
 *  these; each protocol adapter (P1: anthropic-stream.ts) translates its
 *  wire events into this shape. `raw` carries the protocol-native event for
 *  stream_event UI passthrough — the loop must never branch on it.
 *
 *  Deliberately imports NOTHING: this file lands in Task 2, before frames.ts
 *  (Task 3), and must typecheck alone. Usage is a self-contained partial. */
export type CanonicalUsagePartial = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export type CanonicalBlockStart =
  | { type: 'text' }
  | { type: 'thinking' }
  | { type: 'tool_use'; id: string; name: string }

export type CanonicalDelta =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_input'; json: string }

export type CanonicalEvent = (
  | { kind: 'message_start'; usage?: CanonicalUsagePartial }
  | { kind: 'block_start'; index: number; block: CanonicalBlockStart }
  | { kind: 'block_delta'; index: number; delta: CanonicalDelta }
  | { kind: 'block_end'; index: number }
  | { kind: 'message_end'; stopReason: string | null; usage?: CanonicalUsagePartial }
) & { raw?: unknown }
