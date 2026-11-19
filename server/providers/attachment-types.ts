// server/providers/attachment-types.ts
//
// Neutral attachment contract shared by the provider seam and the native
// session log. Imports nothing provider-specific.

import type { ResolvedFileAttachment } from '../agent-message.js'

export interface NativeFileAttachment extends ResolvedFileAttachment {
  /** Assigned once before the occurrence is first persisted; never rewritten. */
  modelForm: 'handle' | 'pdf-document'
}

export interface NativeFileBlock {
  type: 'file'
  attachment: NativeFileAttachment
}
