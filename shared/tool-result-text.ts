// Single writer of the text runs a tool_result renders.
//
// The renderer (ToolResultDetails), the server search segments
// (extractMessageSearchSegments) and the client match walks all consume this
// one derivation, so the counted/searched text is exactly the rendered text:
// RAW runs (ANSI-aware truncate at 4000 visible chars per text buffer, buffers
// joined "\n\n"), NOT markdown-flattened. Markdown text blocks elsewhere keep
// their own markdown view; only tool_result content uses this raw view.
//
// Internal file blocks ({type:'file'} — native AttachmentRead plumbing) are
// stripped from every public view before render/index (live UI frames are
// text-only summaries; disk reads run publicNativeHistoryLine). They contribute
// nothing here, and the empty-body formatJson(content) fallback is suppressed
// when it would otherwise serialize them, so a file name/digest/path can never
// leak into searchable text (pinned by shared/search/segments.test.ts).

import { isFileBlock } from './attachments.js'
import { formatJson } from './format.js'
import { imageBlockToDataUrl } from './image-block.js'
import { truncate } from './text.js'

/** One rendered piece of a tool_result body: a text run, or a navigable run of
 *  image data URLs. Parts stay in source order for interleaved text + image. */
export type ToolResultPart = { kind: 'text'; text: string } | { kind: 'images'; srcs: string[] }

/** Loose structural block shape both sides' content blocks satisfy (shared/
 *  cannot import src/types). The index signature keeps it assignable to
 *  imageBlockToDataUrl's BlockLike. */
interface ContentBlockLike {
  type?: string
  text?: unknown
  [k: string]: unknown
}

const TEXT_LIMIT = 4000

/** Derive the ordered rendered parts of a tool_result `content` value.
 *  - string content → one text run, truncate(content, 4000).
 *  - array/object content → text buffers (text blocks' `.text`, other non-image
 *    non-file blocks `formatJson(block)`) joined "\n\n" + truncate(…, 4000),
 *    flushed at each image run; consecutive images group into one images part.
 *  - no image runs → the text parts collapse to ONE run (no re-truncation);
 *    an empty body falls back to formatJson(content) UNLESS that would
 *    serialize internal file blocks (then no parts).
 *  - null/undefined elements and internal file blocks are skipped. */
export function toolResultBodyParts(content: unknown): ToolResultPart[] {
  if (typeof content === 'string') return [{ kind: 'text', text: truncate(content, TEXT_LIMIT) }]
  const raw = Array.isArray(content)
    ? content
    : content && typeof content === 'object'
      ? [content]
      : []
  const parts: ToolResultPart[] = []
  let textBuf: string[] = []
  let imgRun: string[] = []
  let sawFileBlock = false

  const flushText = () => {
    if (textBuf.length === 0) return
    const text = truncate(textBuf.join('\n\n'), TEXT_LIMIT)
    if (text) parts.push({ kind: 'text', text })
    textBuf = []
  }
  const flushImgs = () => {
    if (imgRun.length === 0) return
    parts.push({ kind: 'images', srcs: imgRun })
    imgRun = []
  }

  for (const b of raw as Array<ContentBlockLike | null | undefined>) {
    if (b == null) continue
    if (isFileBlock(b)) { sawFileBlock = true; continue }
    const src = imageBlockToDataUrl(b)
    if (src) {
      flushText()
      imgRun.push(src)
    } else if (b.type === 'text' && typeof b.text === 'string') {
      flushImgs()
      textBuf.push(b.text)
    } else {
      flushImgs()
      textBuf.push(formatJson(b))
    }
  }
  flushText()
  flushImgs()

  const texts = parts.filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
  if (texts.length === parts.length) {
    const text = texts.map((p) => p.text).join('\n\n')
    if (!text && sawFileBlock) return []
    return [{ kind: 'text', text: text || formatJson(content) }]
  }
  return parts
}

/** The text runs of a tool_result body — the single view every match count,
 *  ordinal walk and search segment consumes. Image parts contribute no runs. */
export function toolResultTextRuns(content: unknown): string[] {
  return toolResultBodyParts(content)
    .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
    .map((p) => p.text)
}