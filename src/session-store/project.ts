// Render-projection for the localStorage transcript cache.
//
// The cache is a render HINT to mask WS-replay latency on cold load — not a
// durable store (the server's in-memory ring + on-disk .jsonl are the source
// of truth). Persisting full messages let a single large session blow past
// the per-session byte budget: tool_result bodies, pasted images, and long
// assistant turns are the byte hogs, and the old count-based trim couldn't
// bound bytes for "few but large" sessions.
//
// `projectMessage` returns a capped COPY of a message, applied ONLY on the
// persist path (live state is never touched). Caps are set well above the
// display limits (tool_result renders 4000 chars; cap 8000) so the cold-load
// view is visually identical until WS replay lands and replaces the capped
// items with full server messages by uuid. The server already destructively
// trims tool_result bodies to 50K (`trimLargeToolResults`), and the client
// only displays 4000, so there is no "full body" to fetch on demand — the
// projection cap simply matches the reality of what's ever shown.
//
// Index rebuild (`rebuildIndexesFromMessages`) runs over these projected
// messages on hydrate. Capping is safe there:
//  - `getToolResultOutcomes` reads `is_error` (preserved).
//  - `getPlanResultDecisions` substring-matches short REJECTION_NEEDLES at
//    the START of the result text; an 8000-char cap preserves the match.
//  - `getToolResultEntries` passes `content` through as `unknown`.
// Truncating a >8K plan/workflow body is non-fatal: the card renders
// truncated markdown on cold load until replay replaces it.

import type { Block, SdkMessage } from '../types'

/** Per-field char caps. Chosen > display limits so cold-load render is
 *  visually identical until replay lands. */
const CAP_TOOL_RESULT = 8_000 // ToolResultDetails displays 4000
const CAP_TEXT = 16_000 // assistant text blocks, string message.content
const CAP_THINKING = 8_000 // expanded <pre> view
/** tool_use input fields that carry file/diff content (Write.content,
 *  Edit/MultiEdit old_string/new_string). Tool inputs are smaller than
 *  tool_results on average but Write can carry a whole file; 64KB covers
 *  normal files and only truncates pathological ones. */
const CAP_TOOL_INPUT = 64 * 1024

const TRUNC_MARKER = '\n…[truncated]'
const IMAGE_MARKER = '[image omitted — reload to view]'

/** Truncate a string to `cap` chars + marker. Returns the original reference
 *  (no copy) when already within budget so the common case allocates nothing. */
function capString(s: string, cap: number): string {
  return s.length > cap ? s.slice(0, cap) + TRUNC_MARKER : s
}

/** Cap the `input` of a tool_use block. Only the few fields that can carry
 *  large file/diff content are capped; structural fields (file_path, command,
 *  pattern, questions, todos…) are left untouched. Returns the original
 *  `input` reference when nothing changed. */
function capToolInput(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input
  const obj = input as Record<string, unknown>
  let changed = false
  const out: Record<string, unknown> = {}

  // Single large string fields.
  for (const key of ['content', 'old_string', 'new_string'] as const) {
    const v = obj[key]
    if (typeof v === 'string' && v.length > CAP_TOOL_INPUT) {
      out[key] = v.slice(0, CAP_TOOL_INPUT) + TRUNC_MARKER
      changed = true
    } else {
      out[key] = v
    }
  }

  // MultiEdit `edits[]` — each entry can carry old_string/new_string.
  const edits = obj['edits']
  if (Array.isArray(edits)) {
    const cappedEdits = edits.map((e) => {
      if (!e || typeof e !== 'object') return e
      const ed = e as Record<string, unknown>
      let eChanged = false
      const eOut: Record<string, unknown> = { ...ed }
      for (const key of ['old_string', 'new_string'] as const) {
        const v = ed[key]
        if (typeof v === 'string' && v.length > CAP_TOOL_INPUT) {
          eOut[key] = v.slice(0, CAP_TOOL_INPUT) + TRUNC_MARKER
          eChanged = true
        }
      }
      return eChanged ? eOut : ed
    })
    if (cappedEdits.some((e, i) => e !== edits[i])) {
      out['edits'] = cappedEdits
      changed = true
    } else {
      out['edits'] = edits
    }
  }

  // Copy through any other keys by reference.
  for (const k of Object.keys(obj)) {
    if (!(k in out)) out[k] = obj[k]
  }
  return changed ? out : input
}

/** Cap a tool_result block's `content` (string | Block[] | undefined).
 *  Preserves `tool_use_id`, `is_error`, `type`. Returns the original block
 *  reference when nothing changed. */
function capToolResultBlock(block: Block): Block {
  const content = block.content
  let nextContent: unknown = content
  let changed = false
  if (typeof content === 'string') {
    if (content.length > CAP_TOOL_RESULT) {
      nextContent = content.slice(0, CAP_TOOL_RESULT) + TRUNC_MARKER
      changed = true
    }
  } else if (Array.isArray(content)) {
    // Cap inner text blocks; DROP inner image blocks (a tool that returns a
    // screenshot / MCP image result puts a base64 image block here — left
    // alone it would persist at full size, and IDB has no byte cap, so this
    // is the unbounded-growth path the projection exists to prevent). Other
    // non-text, non-image blocks (rare in tool_result) pass through.
    const capped: Block[] = []
    let arrChanged = false
    for (const inner of content) {
      if (inner && typeof inner === 'object' && (inner as Block).type === 'image') {
        arrChanged = true // drop
        continue
      }
      if (inner && typeof inner === 'object' && (inner as Block).type === 'text') {
        const t = (inner as Block).text
        if (typeof t === 'string' && t.length > CAP_TOOL_RESULT) {
          capped.push({ ...(inner as Block), text: t.slice(0, CAP_TOOL_RESULT) + TRUNC_MARKER })
          arrChanged = true
          continue
        }
      }
      capped.push(inner as Block)
    }
    if (arrChanged) {
      // If dropping image(s) emptied the array (an image-only tool result —
      // e.g. a screenshot tool), substitute a text marker so the card doesn't
      // render as a blank "(empty)" on cold load. Mirrors the top-level
      // image-only handling in projectMessage.
      if (capped.length === 0) {
        capped.push({ type: 'text', text: IMAGE_MARKER })
      }
      nextContent = capped
      changed = true
    }
  }
  return changed ? { ...block, content: nextContent } : block
}

/** Project a single block. Returns the original reference when nothing
 *  changed (the common case for small blocks). Image blocks are dropped. */
function projectBlock(block: Block): Block | null {
  switch (block.type) {
    case 'text': {
      const t = block.text
      if (typeof t === 'string' && t.length > CAP_TEXT) {
        return { ...block, text: t.slice(0, CAP_TEXT) + TRUNC_MARKER }
      }
      return block
    }
    case 'thinking': {
      const t = block.thinking
      if (typeof t === 'string' && t.length > CAP_THINKING) {
        return { ...block, thinking: t.slice(0, CAP_THINKING) + TRUNC_MARKER }
      }
      return block
    }
    case 'tool_use': {
      const cappedInput = capToolInput(block.input)
      return cappedInput === block.input ? block : { ...block, input: cappedInput }
    }
    case 'tool_result':
      return capToolResultBlock(block)
    case 'image':
      // Images (base64) are the single largest field — 500KB-2MB each.
      // Drop on persist; replay restores them within seconds. The caller
      // substitutes a marker if this leaves the message with no blocks.
      return null
    default:
      return block
  }
}

/** Project a message to its capped cache form. Returns the original message
 *  reference when no content needed changing (small messages allocate zero).
 *  Never touches `uuid` / `parent_tool_use_id` / timestamps — replay relies
 *  on uuid identity to replace capped items with full server messages. */
export function projectMessage(msg: SdkMessage): SdkMessage {
  const message = msg.message
  if (!message) return msg
  const content = message.content

  // String content — cap as text.
  if (typeof content === 'string') {
    if (content.length <= CAP_TEXT) return msg
    return {
      ...msg,
      message: { ...message, content: capString(content, CAP_TEXT) },
    }
  }

  if (!Array.isArray(content)) return msg

  // Array content — project each block, drop images.
  let changed = false
  const out: Block[] = []
  for (const block of content) {
    const projected = projectBlock(block as Block)
    if (projected === null) {
      changed = true // image dropped
    } else {
      if (projected !== block) changed = true
      out.push(projected)
    }
  }

  // If every block was dropped (e.g. an image-only user prompt), substitute a
  // marker so the bubble still renders and reserves space on cold load.
  if (out.length === 0) {
    out.push({ type: 'text', text: IMAGE_MARKER })
    changed = true
  }

  if (!changed) return msg
  return { ...msg, message: { ...message, content: out } }
}
