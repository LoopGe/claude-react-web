import type { FileAttachmentRef } from '../attachments.js'
import { parseFileHandle } from '../upload-handle.js'
import { countMatches } from './match.js'

export interface TextSearchSegment {
  readonly type: 'text'
  readonly text: string
}

export interface AttachmentSearchSegment {
  readonly type: 'attachment'
  readonly text: string
  readonly attachment: FileAttachmentRef
}

/** Independent search units. Queries never span two units, so a file name
 * between two text blocks cannot invent a phrase that the UI does not show. */
export type MessageSearchSegment = TextSearchSegment | AttachmentSearchSegment

export type FileHandleTextSegment =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'file'; readonly file: FileAttachmentRef }

const HANDLE_PREFIX = '[File '
const HANDLE_END = 'read it.]'

/** Split generated file handles out of free text at their exact positions.
 * Ordinary text is left byte-for-byte intact; only the handle plumbing moves
 * into a file segment. */
export function splitFileHandleText(text: string): FileHandleTextSegment[] {
  const out: FileHandleTextSegment[] = []
  let consumed = 0
  let searchFrom = 0
  while (searchFrom < text.length) {
    const start = text.indexOf(HANDLE_PREFIX, searchFrom)
    if (start < 0) break
    const end = text.indexOf(HANDLE_END, start)
    if (end < 0) break
    const candidateEnd = end + HANDLE_END.length
    const parsed = parseFileHandle(text.slice(start, candidateEnd))
    if (parsed === null) {
      searchFrom = start + HANDLE_PREFIX.length
      continue
    }
    if (start > consumed) out.push({ type: 'text', text: text.slice(consumed, start) })
    out.push({
      type: 'file',
      file: { id: parsed.attachment.id, name: parsed.attachment.name, size: parsed.attachment.size },
    })
    consumed = candidateEnd
    searchFrom = candidateEnd
  }
  if (consumed < text.length) out.push({ type: 'text', text: text.slice(consumed) })
  return out
}

export function countMessageSearchMatches(segments: readonly MessageSearchSegment[], query: string): number {
  let count = 0
  for (const segment of segments) count += countMatches(segment.text, query)
  return count
}

/** Map a message-local match ordinal back to its independent renderer. */
export function locateMessageSearchMatch(
  segments: readonly MessageSearchSegment[],
  query: string,
  ordinal: number,
): { segmentIndex: number; matchIndex: number } | null {
  if (ordinal < 0) return null
  let remaining = ordinal
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const count = countMatches(segments[segmentIndex].text, query)
    if (remaining < count) return { segmentIndex, matchIndex: remaining }
    remaining -= count
  }
  return null
}
