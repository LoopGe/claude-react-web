// Neutral attachment-store error contract: the error codes, the error class,
// and the verified-read input shape. The class has a SINGLE definition here —
// the host object store throws it and native readers instanceof-check it, so
// both sides must resolve the same class identity. This module imports
// nothing, so it is safe to import from both host and host-free code.

export type AttachmentStoreErrorCode = 'too-large' | 'write-failed' | 'corrupt' | 'missing'

export class AttachmentStoreError extends Error {
  constructor(
    readonly code: AttachmentStoreErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'AttachmentStoreError'
  }
}

export interface VerifyFileInput {
  path: string
  digest: string
  size: number
  signal?: AbortSignal
}
