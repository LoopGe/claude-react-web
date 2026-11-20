// Single decision point for stripping generated attachment handles from
// preview/plain-text extraction.
//
// The handle primitives stay siblings: shared/upload-handle.ts (file handles)
// and shared/image-handle.ts (image handles) each own their grammar and do not
// import each other. This module composes them, so every extractor that reads
// raw SDK text strips all handle kinds through one call; a future attachment
// handle type extends this function instead of each extraction site.
//
// File handles strip first: a file handle is removed atomically even when its
// quoted name or path embeds text shaped like another handle.

import { stripFileHandles } from './upload-handle'
import { stripImageHandles } from './image-handle'

/**
 * Remove every generated file- and image-handle occurrence from free text,
 * leaving the user's own text (trimmed). Never throws; malformed handles
 * survive as raw text. On text with no image handle the result is exactly
 * `stripFileHandles(text)`.
 */
export function stripHandles(text: string): string {
  return stripImageHandles(stripFileHandles(text))
}
