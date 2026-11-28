// Fixed-density heuristic token pricing for the native context composition.
// The structural constants mirror DSH's token-meter estimator so the two
// harnesses price identical content comparably; the CJK arm is the deliberate
// divergence — chars/4 underprices Chinese ~4-6×, and Chinese is a core usage
// scenario here. Image blocks carry a reference-only structural price: the
// real request cost of an image is route-owned, not a fixed density.
//
// Neutral core module: imports only sibling vocabulary types.

import type { ContentBlock } from './vocabulary/types.js'

/** Fixed text-density estimate for non-CJK characters. */
export const CHARS_PER_TOKEN = 4
/** Per-block structural overhead for JSON framing and type tags. */
export const BLOCK_OVERHEAD = 4
/** Role-field framing overhead added to every priced message. */
export const ROLE_OVERHEAD = 4

/** Codepoint ranges priced at one token per character: CJK punctuation,
 *  kana, CJK Unified Ideographs (incl. Extension A and B), Hangul syllables,
 *  and fullwidth forms. */
const CJK_RANGES: Array<[number, number]> = [
  [0x3000, 0x303f], [0x3040, 0x30ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xac00, 0xd7af], [0xff00, 0xffef],
  [0x20000, 0x2a6df],
]

function isCjk(cp: number): boolean {
  return CJK_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)
}

/** Price text at the CJK-aware fixed density: 1 token per CJK codepoint,
 *  1/CHARS_PER_TOKEN per other character, ceiled. Iterates by codepoint so
 *  astral characters count once. */
export function estimateText(text: string): number {
  let units = 0
  for (const ch of text) units += isCjk(ch.codePointAt(0)!) ? 1 : 1 / CHARS_PER_TOKEN
  return Math.ceil(units)
}

/** Price content blocks with per-block structural overhead. Text/reasoning
 *  ride the CJK-aware density; tool-call names are ASCII API identifiers
 *  (chars/4) while their raw-JSON arguments ride the full density; every
 *  other block (image/file refs, tool additions/removals, merge extensions)
 *  keeps a conservative structural JSON price. */
export function estimateBlocks(blocks: readonly ContentBlock[]): number {
  let tokens = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += estimateText(block.text) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += Math.ceil(block.name.length / CHARS_PER_TOKEN)
          + estimateText(block.arguments)
          + BLOCK_OVERHEAD
        break
      case 'image': {
        // Store-backed occurrences have known dimensions: price them at the
        // API's own vision density (one token per 750 px) instead of the
        // reference JSON framing. A legacy inline base64 block has no
        // declared dimensions and keeps the structural price.
        const attachment = 'attachment' in block ? block.attachment : undefined
        tokens += (attachment
          && Number.isFinite(attachment.width) && Number.isFinite(attachment.height)
          ? Math.max(1, Math.ceil((attachment.width * attachment.height) / 750))
          : Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN))
          + BLOCK_OVERHEAD
        break
      }
      default:
        tokens += Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
    }
  }
  return tokens
}

/** Price one model-visible message: content blocks plus role framing. */
export function estimateMessage(message: { role: string; content: readonly ContentBlock[] }): number {
  return estimateBlocks(message.content) + ROLE_OVERHEAD
}

/** Price the tool-schema part of the wire request — the exact shape the
 *  loop sends (`{ name, description, input_schema }`). Descriptions may be
 *  Chinese, so the serialized JSON rides the CJK-aware density. */
export function estimateToolSchema(def: { name: string; description: string; schema: unknown }): number {
  return estimateText(JSON.stringify({
    name: def.name,
    description: def.description,
    input_schema: def.schema,
  })) + BLOCK_OVERHEAD
}