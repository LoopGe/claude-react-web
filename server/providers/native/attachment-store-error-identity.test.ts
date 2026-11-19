// Behavior pin: AttachmentStoreError has ONE neutral definition
// (shared/attachment-store-error.ts). The host object store re-exports it,
// and native instanceof checks must match an error constructed through that
// host re-export path — a duplicated class would silently fall through to
// the generic failure text instead of the code-specific reason.

import { describe, expect, it } from 'vitest'
import { AttachmentStoreError as NeutralAttachmentStoreError } from '../../../shared/attachment-store-error.js'
import { AttachmentStoreError as HostAttachmentStoreError } from '../../attachment-object-store.js'
import { safePdfReadReason } from './pdf-documents.js'

describe('AttachmentStoreError single class identity', () => {
  it('the host re-export is the neutral class itself', () => {
    expect(HostAttachmentStoreError).toBe(NeutralAttachmentStoreError)
  })

  it('native instanceof matches an error constructed via the host re-export', () => {
    const err = new HostAttachmentStoreError('corrupt', 'tampered bytes')
    expect(err instanceof NeutralAttachmentStoreError).toBe(true)
    expect(err.name).toBe('AttachmentStoreError')
    expect(err.code).toBe('corrupt')
    // safePdfReadReason's instanceof branch is a native check site; it must
    // recognize the host-constructed error and map every code it handles.
    expect(safePdfReadReason(err)).toBe('attachment failed integrity verification')
    expect(safePdfReadReason(new HostAttachmentStoreError('missing', 'gone'))).toBe('uploaded file is missing')
    expect(safePdfReadReason(new HostAttachmentStoreError('too-large', 'big'))).toBe('PDF exceeds the 20 MiB document limit')
  })
})
