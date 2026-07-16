/** Shared prompt-content fingerprinting for the replay-overlap dedup paths.
 *
 *  Used by:
 *   - the client reducer's no-anchor signature fallback (splitReplayAgainstCache
 *     → promptSequencesEqual), and
 *   - the server's resume-seed uuid-rewrite (promptUuids sidecar desync check).
 *
 *  Lives in shared/ (SDK-agnostic) so both the server (SDKMessage) and the
 *  browser bundle (loose SdkMessage, which does not import the SDK) can call it
 *  without either depending on the other's type root. */

/** Minimal message shape the fingerprint reads. SDK-agnostic. */
export interface PromptFingerprintInput {
  type?: string
  parent_tool_use_id?: string | null
  message?: { content?: unknown }
}

/** A content fingerprint for a top-level user prompt: the prompt's text plus a
 *  digest of its non-text content blocks (images / attachments). Returns null
 *  for non-top-level-prompt frames (non-user, or user frames carrying a
 *  parent_tool_use_id — i.e. tool_result / subagent-internal) so callers can
 *  skip them.
 *
 *  Richer than plain text: folds in a digest of non-text blocks so two prompts
 *  with different images (or same text + different image) get different
 *  fingerprints. Plain-text-only signatures collapse every image-only prompt
 *  onto '' and would false-drop a genuinely different image. */
export function promptContentFingerprint(msg: PromptFingerprintInput): string | null {
  if (msg.type !== 'user') return null
  if (msg.parent_tool_use_id != null) return null
  const content = msg.message?.content
  let text = ''
  const nonText: string[] = []
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (!block || typeof block !== 'object') continue
      const t = block.type
      if (t === 'text' && typeof block.text === 'string') {
        text += block.text
      } else if (t === 'image') {
        const src = block.source as { media_type?: string; data?: string } | undefined
        const media = typeof src?.media_type === 'string' ? src.media_type : ''
        const data = typeof src?.data === 'string' ? src.data : ''
        // media_type + length + head/tail: cheap yet discriminates different
        // images without hashing megabytes of base64 on every comparison.
        nonText.push(`img:${media}:${data.length}:${data.slice(0, 32)}:${data.length > 32 ? data.slice(-32) : ''}`)
      } else {
        nonText.push(String(t ?? 'block'))
      }
    }
  }
  return `${text} ${nonText.join('|')}`
}

/** A short stable hash of a string (djb2 variant, base36). Used to persist a
 *  compact fingerprint digest server-side (the promptUuids sidecar) for desync
 *  detection without storing full prompt text. NOT cryptographic — collision
 *  resistance is incidental, only "different prompts rarely share a hash" is
 *  needed (a collision degrades to positional trust, which is safe). */
export function hashStr(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/** Convenience: the short hash of a prompt's content fingerprint, or null when
 *  the message is not a top-level prompt. The compact form stored in the
 *  promptUuids sidecar. */
export function promptFingerprintHash(msg: PromptFingerprintInput): string | null {
  const fp = promptContentFingerprint(msg)
  return fp == null ? null : hashStr(fp)
}
