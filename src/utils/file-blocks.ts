// Split one user message's content blocks into what the UI renders:
// plain text, images, and file references. File references arrive either as
// app-level FileBlocks (live ring/broadcast) or as the handle text the SDK
// persisted (replay/restart); both become the same chip row.

import { isFileBlock, type FileAttachmentRef } from '../../shared/attachments'
import { parseFileHandle } from '../../shared/upload-handle'
import { stripHandles } from '../../shared/attachment-handle'
import { splitFileHandleText } from '../../shared/search/segments'
import { MENTION_PATTERN_G, parseFileMention } from '../../shared/file-mention'
import type { Block } from '../types'

export type UserContentSegment =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly block: Block }
  | { readonly type: 'file'; readonly file: FileAttachmentRef }
  | { readonly type: 'mention'; readonly text: string; readonly path: string; readonly dir: boolean }

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

/** Project user blocks into render order. Unlike splitUserBlocks, this keeps
 * every text/file/image/mention occurrence in place, including handles
 * embedded in a larger persisted text block. Mentions split AFTER the file
 * handle split, so a handle's own text is never re-scanned. */
export function splitUserContentSegments(blocks: readonly Block[]): UserContentSegment[] {
  const out: UserContentSegment[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      for (const segment of splitFileHandleText(block.text)) {
        if (segment.type === 'text') {
          // Bash-mode synthetic frames carry machine XML (<bash-input>…) that
          // BashMessage parses by tag; a `@run` inside the command or stdout is
          // code/output, not a user reference, so the tags must stay intact.
          if (segment.text.includes('<bash-input>')) {
            if (segment.text !== '') out.push(segment)
            continue
          }
          out.push(...splitMentionText(segment.text))
        } else {
          out.push(segment)
        }
      }
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