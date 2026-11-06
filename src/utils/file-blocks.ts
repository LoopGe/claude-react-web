// Split one user message's content blocks into what the UI renders:
// plain text, images, and file references. File references arrive either as
// app-level FileBlocks (live ring/broadcast) or as the handle text the SDK
// persisted (replay/restart); both become the same chip row.

import { isFileBlock, type FileAttachmentRef } from '../../shared/attachments'
import { parseFileHandle, stripFileHandles } from '../../shared/upload-handle'
import type { Block } from '../types'

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