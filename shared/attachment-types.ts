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
