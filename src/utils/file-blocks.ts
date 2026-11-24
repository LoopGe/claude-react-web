// Split one user message's content blocks into what the UI renders:
// plain text, images, and file references. File references arrive either as
// app-level FileBlocks (live ring/broadcast) or as the handle text the SDK
// persisted (replay/restart); both become the same chip row.

import { isFileBlock, type FileAttachmentRef } from '../../shared/attachments'
import { parseFileHandle } from '../../shared/upload-handle'
import { stripHandles } from '../../shared/attachment-handle'
import { splitFileHandleText } from '../../shared/search/segments'
import { MENTION_PATTERN_G, parseFileMention } from '../../shared/file-mention'
import { messageQuoteRanges } from './quote-text'
import type { Block } from '../types'

export type UserContentSegment =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly block: Block }
  | { readonly type: 'file'; readonly file: FileAttachmentRef }
  | { readonly type: 'mention'; readonly text: string; readonly path: string; readonly dir: boolean }
  /** A line-leading blockquote run. `text` is the EXACT run (`> …` verbatim);
   *  the render layer decodes the displayed excerpt (`quoteTextOf` via
   *  QuotePreview). The run is opaque: a file-handle or mention string inside
   *  it stays literal text, never re-parsed into a file/mention segment. */
  | { readonly type: 'quote'; readonly text: string }

/** Split one text run on @file/@folder mentions (the DSH grammar: any
 * `@non-space` token at a whitespace boundary). `text` keeps the serialized
 * mention verbatim (quotes / trailing slash included); `path`/`dir` are the
 * parsed facts the click-to-preview path resolves. */
function splitMentionText(text: string): UserContentSegment[] {
  const out: UserContentSegment[] = []
  let consumed = 0
  for (const match of text.matchAll(MENTION_PATTERN_G)) {
    const token = match[0]
    const parsed = parseFileMention(token)
    // Every MENTION_PATTERN_G match is parseable by construction (the two
    // share one grammar source); a null here means the grammar drifted.
    if (parsed === null) throw new Error(`unparseable mention token: ${JSON.stringify(token)}`)
    const start = match.index
    if (start > consumed) out.push({ type: 'text', text: text.slice(consumed, start) })
    out.push({ type: 'mention', text: token, path: parsed.path, dir: parsed.dir })
    consumed = start + token.length
  }
  if (consumed < text.length) out.push({ type: 'text', text: text.slice(consumed) })
  return out
}

/** Split one text run on file handles, then mentions. Mentions split AFTER the
 * file-handle split, so a handle's own text is never re-scanned. Bash-mode
 * synthetic frames carry machine XML (<bash-input>…) that BashMessage parses by
 * tag; a `@run` inside the command or stdout is code/output, not a user
 * reference, so those tags stay intact. */
function splitHandlesAndMentions(text: string): UserContentSegment[] {
  const out: UserContentSegment[] = []
  for (const segment of splitFileHandleText(text)) {
    if (segment.type === 'text') {
      if (segment.text.includes('<bash-input>')) {
        if (segment.text !== '') out.push(segment)
        continue
      }
      out.push(...splitMentionText(segment.text))
    } else {
      out.push(segment)
    }
  }
  return out
}

/** Split one text block, recognizing line-leading blockquote runs FIRST so they
 * are opaque to the file-handle and mention parsers: a quoted file-handle or
 * `@path` string stays literal text inside the quote, never resurrected into a
 * file/mention segment. Non-quote pieces between runs go through the ordinary
 * handle/mention split.
 *
 * Bash-mode frames are exempt: a line-leading `>` inside a command or stdout is
 * shell syntax/output, not a user quote, and fragmenting it would break
 * BashMessage's tag slicing (the same rationale as the mention guard). */
function splitTextBlock(text: string): UserContentSegment[] {
  if (text.includes('<bash-input>')) return splitHandlesAndMentions(text)
  const ranges = messageQuoteRanges(text)
  if (ranges.length === 0) return splitHandlesAndMentions(text)
  const out: UserContentSegment[] = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start > cursor) out.push(...splitHandlesAndMentions(text.slice(cursor, range.start)))
    out.push({ type: 'quote', text: text.slice(range.start, range.end) })
    cursor = range.end
  }
  if (cursor < text.length) out.push(...splitHandlesAndMentions(text.slice(cursor)))
  return out
}

/** Project user blocks into render order. Unlike splitUserBlocks, this keeps
 * every text/file/image/mention/quote occurrence in place, including handles
 * embedded in a larger persisted text block. */
export function splitUserContentSegments(blocks: readonly Block[]): UserContentSegment[] {
  const out: UserContentSegment[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push(...splitTextBlock(block.text))
      continue
    }
    if (block.type === 'image') {
      out.push({ type: 'image', block })
      continue
    }
    if (isFileBlock(block)) out.push({ type: 'file', file: block.attachment })
  }
  return out
}

export interface UserContentParts {
  /** Concatenated non-handle text, or null when nothing visible remains. */
  readonly text: string | null
  readonly images: Block[]
  readonly files: FileAttachmentRef[]
}

/** Split blocks without reordering either group. */
export function splitUserBlocks(blocks: readonly Block[]): UserContentParts {
  const text: string[] = []
  const images: Block[] = []
  const files: FileAttachmentRef[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const parsed = parseFileHandle(block.text)
      if (parsed !== null) files.push(parsed.attachment)
      else {
        const cleaned = stripHandles(block.text)
        if (cleaned !== '') text.push(cleaned)
      }
      continue
    }
    if (block.type === 'image') {
      images.push(block)
      continue
    }
    if (isFileBlock(block)) files.push(block.attachment)
  }
  return { text: text.join('') || null, images, files }
}