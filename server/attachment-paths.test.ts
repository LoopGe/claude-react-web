import { describe, expect, it } from 'vitest'
import { aliasPathOf, ATTACHMENT_STORE_SUBDIR, attachmentRoot, objectPathOf, sanitizeStoredName } from './attachment-paths.js'

const norm = (p: string) => p.replaceAll('\\', '/')

describe('attachment paths', () => {
  it('roots the store below the state dir', () => {
    expect(norm(attachmentRoot('C:/state'))).toBe('C:/state/claude-web-attachments/v1')
    expect(ATTACHMENT_STORE_SUBDIR).toBe('claude-web-attachments')
  })
  it('derives object and alias paths from the digest', () => {
    const digest = 'ab'.repeat(32)
    expect(norm(objectPathOf('root', digest))).toBe(`root/objects/ab/${digest}`)
    expect(norm(aliasPathOf('root', digest, 'a.txt'))).toBe(`root/files/${digest}/a.txt`)
  })
  it('sanitizes path-like and empty names', () => {
    expect(sanitizeStoredName('C:\\tmp\\a.txt')).toBe('a.txt')
    expect(sanitizeStoredName('../../x')).toBe('x')
    expect(sanitizeStoredName('')).toBe('upload')
  })
})