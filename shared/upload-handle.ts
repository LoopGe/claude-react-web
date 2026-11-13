// The model-facing reference for one uploaded file.
//
// The SDK has no file content block, so a FileBlock becomes this deterministic
// text when it crosses into the provider request. The same text is written to
// the SDK transcript; `parseFileHandle` recovers the structured reference for
// replay/restart, with no separate sidecar. Keep the format stable: a parser
// failure degrades to showing the raw text, never to a broken message.

import type { FileAttachmentRef } from './attachments'

/** One parsed handle: the file reference plus its read-only host path. */
export interface ParsedFileHandle {
  readonly attachment: FileAttachmentRef
  readonly path: string
}

const PREFIX = '[File '
const SUFFIX = '. Read that path with your file tools'

/**
 * Build the deterministic handle text for one file occurrence.
 * @param ref - upload reference (id/name/size/digest).
 * @param path - absolute read-only host path of the stored copy.
 */
export function fileHandleText(ref: FileAttachmentRef, path: string): string {
  const parts = [`${ref.size} bytes`]
  if (ref.digest !== undefined) parts.push(`sha256:${ref.digest.slice(0, 8)}`)
  parts.push(`upload:${ref.id}`)
  const identity = `File ${JSON.stringify(ref.name)} (${parts.join(', ')})`
  return `[${identity}: verbatim read-only copy saved at ${JSON.stringify(path)}${SUFFIX} when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]`
}

/** Read one JSON string literal starting at `start` (which must be a quote). */
function readQuoted(input: string, start: number): { value: string; end: number } | null {
  if (input[start] !== '"') return null
  let escaped = false
  for (let i = start + 1; i < input.length; i++) {
    const ch = input[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      try {
        return { value: JSON.parse(input.slice(start, i + 1)) as string, end: i + 1 }
      } catch {
        return null
      }
    }
  }
  return null
}

/**
 * Recover one file reference from a handle text block.
 * @param text - a text block from a user message.
 * @returns the structured reference, or null when the text is not a handle.
 */
export function parseFileHandle(text: string): ParsedFileHandle | null {
  if (!text.startsWith(PREFIX)) return null
  const name = readQuoted(text, PREFIX.length)
  if (name === null) return null
  const meta = /^ \((\d+) bytes(?:, sha256:[a-f0-9]{8})?(?:, upload:([^)]+))?\): verbatim read-only copy saved at /.exec(text.slice(name.end))
  if (meta === null) return null
  const id = meta[2]
  if (id === undefined) return null
  const pathStart = name.end + meta[0].length
  const path = readQuoted(text, pathStart)
  if (path === null) return null
  if (!text.startsWith(SUFFIX, path.end)) return null
  return {
    attachment: { id, name: name.value, size: Number(meta[1]) },
    path: path.value,
  }
}

const HANDLE_END = 'read it.]'

/** Parse a handle at a known prefix, trying later structural terminators when
 * the marker appears inside the JSON filename or path. `end` is exclusive. */
export function parseFileHandleAt(
  text: string,
  start: number,
): { handle: ParsedFileHandle; end: number } | null {
  if (!text.startsWith(PREFIX, start)) return null
  let end = text.indexOf(HANDLE_END, start)
  while (end !== -1) {
    const candidateEnd = end + HANDLE_END.length
    const handle = parseFileHandle(text.slice(start, candidateEnd))
    if (handle !== null) return { handle, end: candidateEnd }
    end = text.indexOf(HANDLE_END, candidateEnd)
  }
  return null
}

/**
 * Remove every generated handle occurrence from free text, leaving the user's
 * own text. Used by previews/recaps/plain-text extractors that read raw SDK
 * content instead of the structured FileBlock.
 */
export function stripFileHandles(text: string): string {
  let result = text
  let index = result.indexOf(PREFIX)
  while (index !== -1) {
    const parsed = parseFileHandleAt(result, index)
    if (parsed !== null) {
      result = result.slice(0, index) + result.slice(parsed.end)
      // Restart at the same offset: the next handle (if any) shifted here.
      index = result.indexOf(PREFIX, index)
    } else {
      index = result.indexOf(PREFIX, index + PREFIX.length)
    }
  }
  return result.trim()
}