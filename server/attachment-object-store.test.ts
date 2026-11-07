import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
})