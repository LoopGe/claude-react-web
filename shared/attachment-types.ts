// Neutral resolved-attachment shape, referenced by the provider seam and the
// native session log. This module imports nothing, so it is safe to import
// from both host and host-free code.

/** Server/provider-only attachment metadata. The browser-facing FileBlock
 *  deliberately never gains the registry path or observed media type. */
export interface ResolvedFileAttachment {
  id: string
  name: string
  size: number
  digest: string
  /** Registry-owned, read-only alias path; never a caller-supplied path. */
  path: string
  /** Server-observed type. PDF eligibility additionally requires a magic check. */
  mediaType?: string
}

/** A resolved attachment as the native provider persists and projects it:
 *  the registry metadata plus the assigned model-facing form. Lives here
 *  (neutral, imports nothing) so the host-free native vocabulary can speak
 *  it; the provider seam (server/providers/attachment-types.ts) re-exports
 *  it for its consumers. */
export interface NativeFileAttachment extends ResolvedFileAttachment {
  /** Assigned once before the occurrence is first persisted; never rewritten. */
  modelForm: 'handle' | 'pdf-document'
}

export interface NativeFileBlock {
  type: 'file'
  attachment: NativeFileAttachment
}
