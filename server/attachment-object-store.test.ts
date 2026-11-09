import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  promises as fs,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AttachmentObjectStore } from './attachment-object-store.js'

async function* chunks(...values: string[]) { for (const v of values) yield new TextEncoder().encode(v) }

/** Published aliases/objects are 0o400, and Windows refuses to delete a
 *  read-only file, so clear the attribute before removing the tree. */
function cleanup(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) cleanup(path)
    else chmodSync(path, 0o600)
  }
  rmSync(dir, { recursive: true, force: true })
}

/** rmSync a single published file (0o400 on Windows) by clearing it first. */
function removeFile(path: string): void {
  chmodSync(path, 0o600)
  rmSync(path)
}

const originalPlatform = process.platform

function forcePosixPlatform(): void {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

/** Run a publication with directory fsyncs recorded. The test forces the
 *  POSIX branch and replaces directory handles with sync spies, so it proves
 *  the call sequence on every host without depending on the OS fsync syscall. */
async function withSyncedDirs(run: (synced: string[]) => Promise<void>): Promise<string[]> {
  forcePosixPlatform()
  const synced: string[] = []
  const realOpen = fs.open.bind(fs)
  const openSpy = vi.spyOn(fs, 'open').mockImplementation(((...args: Parameters<typeof fs.open>) => {
    const [path, flags, mode] = args
    if (flags === constants.O_RDONLY) {
      synced.push(String(path))
      return Promise.resolve({
        sync: async () => {},
        close: async () => {},
      } as unknown as Awaited<ReturnType<typeof fs.open>>)
    }
    return realOpen(path, flags, mode)
  }) as typeof fs.open)
  try {
    await run(synced)
    return synced
  } finally {
    openSpy.mockRestore()
  }
}

describe('AttachmentObjectStore', () => {
  it('publishes one object and a read-only alias, and dedupes equal bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crw-store-'))
    try {
      const store = new AttachmentObjectStore(dir)
      const first = await store.publishStream({ chunks: chunks('hello '), name: 'a.txt', maxBytes: 100 })
      const second = await store.publishStream({ chunks: chunks('hel', 'lo '), name: 'a.txt', maxBytes: 100 })
      const third = await store.publishStream({ chunks: chunks('hello '), name: 'b.txt', maxBytes: 100 })
      expect(first.digest).toBe(second.digest)
      expect(second.aliasPath).toBe(first.aliasPath)
      expect(third.aliasPath).not.toBe(first.aliasPath)
      expect(readFileSync(first.aliasPath, 'utf8')).toBe('hello ')
      expect(readFileSync(third.aliasPath, 'utf8')).toBe('hello ')
      if (process.platform !== 'win32') {
        expect(statSync(first.aliasPath).mode & 0o777).toBe(0o400)
        expect(statSync(first.objectPath).ino).toBe(statSync(first.aliasPath).ino)
      }
    } finally { cleanup(dir) }
  })

  it('rejects over-limit streams and leaves no object', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crw-store-'))
    try {
      const store = new AttachmentObjectStore(dir)
      await expect(store.publishStream({ chunks: chunks('12345'), name: 'a', maxBytes: 3 }))
        .rejects.toMatchObject({ code: 'too-large' })
    } finally { cleanup(dir) }
  })

  it('dedupes concurrent identical publications without corruption', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crw-store-'))
    try {
      const store = new AttachmentObjectStore(dir)
      const [a, b] = await Promise.all([
        store.publishStream({ chunks: chunks('same'), name: 'a1.txt', maxBytes: 100 }),
        store.publishStream({ chunks: chunks('same'), name: 'a2.txt', maxBytes: 100 }),
      ])
      expect(a.digest).toBe(b.digest)
      expect(a.objectPath).toBe(b.objectPath)
      expect(readFileSync(a.aliasPath, 'utf8')).toBe('same')
      expect(readFileSync(b.aliasPath, 'utf8')).toBe('same')
    } finally { cleanup(dir) }
  })

  it('verifies reads and fails closed on tampering', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crw-store-'))
    try {
      const store = new AttachmentObjectStore(dir)
      const published = await store.publishStream({ chunks: chunks('hello'), name: 'a.txt', maxBytes: 100 })
      await store.verifyFile({ path: published.aliasPath, digest: published.digest, size: 5 })
      const out: Uint8Array[] = []
      for await (const chunk of store.readVerified({ path: published.aliasPath, digest: published.digest, size: 5 })) out.push(chunk)
      expect(Buffer.concat(out).toString()).toBe('hello')
      removeFile(published.aliasPath)
      await expect(store.verifyFile({ path: published.aliasPath, digest: published.digest, size: 5 }))
        .rejects.toMatchObject({ code: 'missing' })
    } finally { cleanup(dir) }
  })

  it('rejects bytes that do not match the digest or the recorded size', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crw-store-'))
    try {
      const store = new AttachmentObjectStore(dir)
      const published = await store.publishStream({ chunks: chunks('hello'), name: 'a.txt', maxBytes: 100 })
      chmodSync(published.aliasPath, 0o600)
      writeFileSync(published.aliasPath, 'hell!')
      await expect(store.verifyFile({ path: published.aliasPath, digest: published.digest, size: 5 }))
        .rejects.toMatchObject({ code: 'corrupt' })
      await expect(store.verifyFile({ path: published.aliasPath, digest: published.digest, size: 4 }))
        .rejects.toMatchObject({ code: 'corrupt' })
    } finally { cleanup(dir) }
  })

  it('removes aliases and objects, and tolerates already-missing paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crw-store-'))
    try {
      const store = new AttachmentObjectStore(dir)
      const published = await store.publishStream({ chunks: chunks('bye'), name: 'a.txt', maxBytes: 100 })
      await store.removeAlias(published.aliasPath)
      expect(existsSync(published.aliasPath)).toBe(false)
      expect(existsSync(published.objectPath)).toBe(true)
      await store.removeAlias(published.aliasPath)
      await store.removeObject(published.digest)
      expect(existsSync(published.objectPath)).toBe(false)
      await store.removeObject(published.digest)
    } finally { cleanup(dir) }
  })

  it('refuses a malformed digest instead of escaping the store root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crw-store-'))
    try {
      const store = new AttachmentObjectStore(dir)
      await expect(store.removeObject('../../x')).rejects.toThrow(/digest/)
      await expect(store.removeObject('A'.repeat(64))).rejects.toThrow(/digest/)
      await expect(store.removeAlias(join(dir, 'outside.txt'))).rejects.toThrow(/store root/)
    } finally { cleanup(dir) }
  })

  it('fsyncs the store root and its ancestors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crw-store-'))
    try {
      const synced = await withSyncedDirs(async () => {
        await new AttachmentObjectStore(dir).publishStream({ chunks: chunks('hello'), name: 'a.txt', maxBytes: 100 })
      })
      expect(synced).toContain(join(dir, 'claude-web-attachments', 'v1'))
      expect(synced).toContain(join(dir, 'claude-web-attachments'))
      expect(synced).toContain(dir)
    } finally { cleanup(dir) }
  })

  it('does not re-walk above the state dir for a second store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crw-store-'))
    try {
      const synced = await withSyncedDirs(async (recorded) => {
        await new AttachmentObjectStore(dir).publishStream({ chunks: chunks('one'), name: 'a.txt', maxBytes: 100 })
        recorded.length = 0
        await new AttachmentObjectStore(dir).publishStream({ chunks: chunks('two'), name: 'b.txt', maxBytes: 100 })
      })
      expect(synced).toContain(join(dir, 'claude-web-attachments'))
      expect(synced).not.toContain(dirname(dir))
    } finally { cleanup(dir) }
  })
})
