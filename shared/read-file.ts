// Per-session read-only file content (SDK Query.readFile). Gated by the
// session's Read-permission rules inside the SDK: null means either the read
// was denied or the file is missing (the SDK collapses both to null). The
// server narrows the raw SDK response through coerceReadFileOutput before it
// goes over the wire, so the client always has a guaranteed-clean shape.

// The SDK default cap (1 MB) truncates ordinary screenshots, and a truncated
// base64 payload decodes to an undecodable — broken — image. Previews ask for
// this headroom; the request builder and the "too large" hint must agree on it,
// so it lives beside the result type both sides share.
export const IMAGE_PREVIEW_MAX_BYTES = 5 * 1024 * 1024

export interface FileReadResult {
  /** false = read permission denied or file missing (SDK returned null). */
  available: boolean
  /** The file's current content (available=true and text). */
  contents?: string
  /** True when the content was truncated at the read's maxBytes cap, so the
   *  client can show "file too large, truncated" rather than a full body. */
  truncated?: boolean
  /** UTF-8 text (default) or base64 (binary passthrough). */
  encoding?: 'utf-8' | 'base64'
}

/** Defensive narrowing of an unknown SDK readFile result into FileReadResult.
 *  `{ contents }` → available:true (helpers kept when type-correct); null /
 *  malformed → available:false. Unknown keys are dropped. */
export function coerceReadFileOutput(v: unknown): FileReadResult {
  if (typeof v !== 'object' || v === null) return { available: false }
  const r = v as Record<string, unknown>
  const out: FileReadResult = { available: false }
  if (typeof r.contents === 'string') {
    out.available = true
    out.contents = r.contents
  }
  if (r.truncated === true) out.truncated = true
  if (r.encoding === 'base64') out.encoding = 'base64'
  else if (r.encoding === 'utf-8') out.encoding = 'utf-8'
  return out
}