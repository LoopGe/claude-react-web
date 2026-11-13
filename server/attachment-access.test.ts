import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveAuthorizedAttachment } from './attachment-access.js'
import { aliasPathOf, attachmentRoot } from './attachment-paths.js'
import { UploadStore, UPLOAD_SUBDIR } from './upload-store.js'
import type { ResolvedFileAttachment } from './agent-message.js'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function fixture(kind: 'content' | 'legacy' | 'common') {
  const stateDir = await mkdtemp(join(tmpdir(), 'attachment-access-state-'))
  const cwd = await mkdtemp(join(tmpdir(), 'attachment-access-cwd-'))
  dirs.push(stateDir, cwd)
  const digest = 'a'.repeat(64)
  const root = kind === 'content'
    ? attachmentRoot(stateDir)
    : join(kind === 'legacy' ? cwd : stateDir, UPLOAD_SUBDIR)
  const path = kind === 'content' ? aliasPathOf(root, digest, 'notes.txt') : join(root, 'notes.txt')
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, 'notes')
  const store = new UploadStore({ stateDir })
  store.record([{ id: 'upload-1', path, cwd, name: 'notes.txt', size: 4, digest, uploadedAt: 1, sessionTitle: '' }])
  const occurrence: ResolvedFileAttachment = { id: 'upload-1', name: 'notes.txt', size: 4, digest, path }
  return { stateDir, cwd, store, occurrence, path }
}

describe('resolveAuthorizedAttachment', () => {
  it.each(['content', 'legacy', 'common'] as const)('accepts a registry-backed %s upload root', async (kind) => {
    const fx = await fixture(kind)
    await expect(resolveAuthorizedAttachment(fx.occurrence, {
      uploadStore: fx.store, stateDir: fx.stateDir,
    })).resolves.toEqual(fx.occurrence)
  })

  it('rejects occurrence metadata that disagrees with the current registry entry', async () => {
    const fx = await fixture('content')
    await expect(resolveAuthorizedAttachment({ ...fx.occurrence, path: join(fx.cwd, 'other.txt') }, {
      uploadStore: fx.store, stateDir: fx.stateDir,
    })).rejects.toThrow('attachment does not match its registry entry: upload-1')
    await expect(resolveAuthorizedAttachment({ ...fx.occurrence, size: 5 }, {
      uploadStore: fx.store, stateDir: fx.stateDir,
    })).rejects.toThrow('attachment does not match its registry entry: upload-1')
  })

  it('rejects a missing registry id and a non-regular target without leaking paths', async () => {
    const fx = await fixture('legacy')
    await expect(resolveAuthorizedAttachment({ ...fx.occurrence, id: 'foreign' }, {
      uploadStore: fx.store, stateDir: fx.stateDir,
    })).rejects.toThrow('unknown upload: foreign')

    await rm(fx.path)
    await mkdir(fx.path)
    const failure = resolveAuthorizedAttachment(fx.occurrence, {
      uploadStore: fx.store, stateDir: fx.stateDir,
    })
    await expect(failure).rejects.toThrow('uploaded file is not a regular file: notes.txt')
    await expect(failure).rejects.not.toThrow(fx.path)
  })
})
