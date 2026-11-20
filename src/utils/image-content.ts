// The client's read side of the durable image store: one content-route URL
// builder + blob fetch, shared by the render cache (useImageContent) and the
// recall/draft Blob memo (imageDecodeCache). The client supplies only the
// ref id — the server resolves the digest inside its image tree and serves
// verified bytes (404 missing / 500 corrupt, fail-closed).

import { digestOfImageRef } from '../../shared/image-attachment'

/** Content-route path for a `sha256:<digest>` ref id. A malformed id is a
 *  broken reference, not a fetch — surface it loudly. */
export function imageContentPath(refId: string): string {
  const digest = digestOfImageRef(refId)
  if (digest === null) throw new Error(`invalid image attachment id: ${refId}`)
  return `/api/attachments/images/${digest}`
}

/** Fetch the stored bytes for one image ref. Non-2xx is a refusal (missing
 *  or corrupt object, or a network failure) — the caller decides how to
 *  surface it; nothing is cached on failure. */
export async function fetchImageContentBlob(refId: string): Promise<Blob> {
  const res = await fetch(imageContentPath(refId))
  if (!res.ok) throw new Error(`image content request failed (HTTP ${res.status})`)
  return res.blob()
}
