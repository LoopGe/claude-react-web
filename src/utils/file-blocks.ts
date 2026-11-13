// Split one user message's content blocks into what the UI renders:
// plain text, images, and file references. File references arrive either as
// app-level FileBlocks (live ring/broadcast) or as the handle text the SDK
// persisted (replay/restart); both become the same chip row.

import { isFileBlock, type FileAttachmentRef } from '../../shared/attachments'
import { parseFileHandle, stripFileHandles } from '../../shared/upload-handle'
import { splitFileHandleText } from '../../shared/search/segments'
import type { Block } from '../types'

export type UserContentSegment =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly block: Block }
  | { readonly type: 'file'; readonly file: FileAttachmentRef }

/** Project user blocks into render order. Unlike splitUserBlocks, this keeps
 * every text/file/image occurrence in place, including handles embedded in a
 * larger persisted text block. */
export function splitUserContentSegments(blocks: readonly Block[]): UserContentSegment[] {
  const out: UserContentSegment[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      for (const segment of splitFileHandleText(block.text)) {
        if (segment.type === 'text') {
          if (segment.text !== '') out.push(segment)
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
        const cleaned = stripFileHandles(block.text)
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