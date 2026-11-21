// server/providers/attachment-types.ts
//
// Provider-seam alias for the neutral attachment contract. The shapes live in
// shared/attachment-types.ts (host-free, imports nothing) so the native
// vocabulary can import them directly; this module re-exports them so seam
// consumers keep their import path.

export type { NativeFileAttachment, NativeFileBlock } from '../../shared/attachment-types.js'
