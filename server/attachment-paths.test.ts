import { afterEach, describe, expect, it } from 'vitest'
import {
  aliasPathOf,
  ATTACHMENT_STORE_SUBDIR,
  attachmentRoot,
  isInsideAttachmentRoot,
  objectPathOf,
  sameStoredPath,
  sanitizeStoredName,
} from './attachment-paths.js'

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
  it('caps stored names at 255 UTF-8 bytes', () => {
    expect(sanitizeStoredName('中'.repeat(300))).toBe('中'.repeat(85))
    expect(sanitizeStoredName('😀'.repeat(100))).toBe('😀'.repeat(63))
    expect(sanitizeStoredName('a'.repeat(254) + '.b')).toBe('a'.repeat(254))
    expect(sanitizeStoredName('a'.repeat(255) + '.b')).toBe('a'.repeat(255))
    expect(Buffer.byteLength(sanitizeStoredName('中'.repeat(300)), 'utf8')).toBeLessThanOrEqual(255)
    // A name that is nothing but trimmed characters still falls back.
    expect(sanitizeStoredName('.'.repeat(220))).toBe('upload')
  })

  it('keeps the reserved-name prefix after byte truncation', () => {
    expect(sanitizeStoredName('CON')).toBe('_CON')
    expect(sanitizeStoredName('CON.' + 'a'.repeat(300))).toBe('_CON.' + 'a'.repeat(250))
  })
  it('prefixes Windows reserved device stems', () => {
    expect(sanitizeStoredName('CON')).toBe('_CON')
    expect(sanitizeStoredName('CON.txt')).toBe('_CON.txt')
    expect(sanitizeStoredName('NUL')).toBe('_NUL')
    expect(sanitizeStoredName('com1.tar.gz')).toBe('_com1.tar.gz')
    expect(sanitizeStoredName('lpt9.log')).toBe('_lpt9.log')
    // Only a full reserved stem is a device name.
    expect(sanitizeStoredName('console.txt')).toBe('console.txt')
    expect(sanitizeStoredName('com0.txt')).toBe('com0.txt')
  })
})

describe('sameStoredPath', () => {
  const originalPlatform = process.platform
  const on = (platform: NodeJS.Platform) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  }
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  it('folds case on win32 and darwin', () => {
    on('win32')
    expect(sameStoredPath('C:\\state\\files\\A.txt', 'C:\\state\\files\\a.txt')).toBe(true)
    on('darwin')
    expect(sameStoredPath('/state/files/A.txt', '/state/files/a.txt')).toBe(true)
  })

  it('compares exactly elsewhere', () => {
    on('linux')
    expect(sameStoredPath('/state/files/a.txt', '/state/files/a.txt')).toBe(true)
    expect(sameStoredPath('/state/files/A.txt', '/state/files/a.txt')).toBe(false)
  })

  it('normalizes path separators before comparing', () => {
    on('win32')
    expect(sameStoredPath('C:\\state\\files\\a.txt', 'C:/state/files/a.txt')).toBe(true)
  })
})

describe('isInsideAttachmentRoot', () => {
  it('accepts paths below the store root only', () => {
    const root = attachmentRoot('C:/state')
    expect(isInsideAttachmentRoot(root, `${root}/files/${'a'.repeat(64)}/a.txt`)).toBe(true)
    expect(isInsideAttachmentRoot(root, root)).toBe(false)
    expect(isInsideAttachmentRoot(root, `${root}-evil/files/a.txt`)).toBe(false)
    expect(isInsideAttachmentRoot(root, 'C:/state/claude-web-uploads/a.txt')).toBe(false)
    // A leaf that merely starts with dots is still a child, not an escape.
    expect(isInsideAttachmentRoot(root, `${root}/..foo`)).toBe(true)
    expect(isInsideAttachmentRoot(root, `${root}/../outside.txt`)).toBe(false)
  })
})
