import { describe, expect, it } from 'vitest'
import { canReferenceUpload } from './upload-policy.js'

const base = { id: 'u', path: '/p', cwd: '/c', name: 'a', size: 1, uploadedAt: 1, sessionTitle: '' }

describe('canReferenceUpload', () => {
  it('allows the owning session, common uploads, and legacy entries', () => {
    expect(canReferenceUpload({ ...base, sessionId: 's1' }, 's1')).toBe(true)
    expect(canReferenceUpload({ ...base, sessionId: 's2' }, 's1')).toBe(false)
    expect(canReferenceUpload({ ...base, origin: 'common' }, 's1')).toBe(true)
    expect(canReferenceUpload(base, 's1')).toBe(true)
  })
})
