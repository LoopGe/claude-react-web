import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeFileHandleText, projectNativeMessages, publicNativeHistoryLine } from './attachment-projection.js'
import type { NativeFileAttachment } from './session-log/format.js'
import type { RawLine } from '../../history-reader.js'
import { aliasPathOf, attachmentRoot } from '../../attachment-paths.js'
import { UploadStore } from '../../upload-store.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) }
})

const dirs: string[] = []
afterEach(async () => {
  vi.mocked(createReadStream).mockRestore()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const attachment: NativeFileAttachment = {
  id: 'upload-1', name: 'notes.txt', size: 123, digest: 'abcdef0123456789'.repeat(4),
  path: '/private/registry/notes.txt', mediaType: 'text/plain', modelForm: 'handle',
}
const options = { stateDir: '/state' }

describe('native attachment projection', () => {
  it('uses stable metadata and conditional AttachmentRead guidance', () => {
    const first = nativeFileHandleText(attachment)
    expect(first).toBe(nativeFileHandleText(attachment))
    expect(first).toContain('Upload id: upload-1')
    expect(first).toContain('Name: notes.txt')
    expect(first).toContain('Size: 123 bytes')
    expect(first).toContain('Digest: abcdef01')
    expect(first).toContain('Read-only path: /private/registry/notes.txt')
    expect(first).toContain('If AttachmentRead is available in the current turn')
    expect(first).toContain('current tool configuration cannot read the attachment content; enable AttachmentRead')
    expect(first).toContain('Do not pass this path to Read')
    expect(first).toContain('include the upload id')
    expect(first).toContain('Copy the attachment to a writable location before modifying it')
  })

  it('projects direct and tool_result files on every round without mutating canonical history', async () => {
    const history = [{
      role: 'user',
      content: [
        { type: 'file', attachment },
        { type: 'text', text: 'prompt' },
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'summary' }, { type: 'file', attachment }] },
      ],
    }]
    const canonicalBefore = structuredClone(history)

    const first = await projectNativeMessages(history, options, new AbortController().signal) as Array<{ content: Array<{ type: string; text?: string; content?: Array<{ type: string }> }> }>
    const second = await projectNativeMessages(history, options, new AbortController().signal) as typeof first

    expect(history).toEqual(canonicalBefore)
    expect(first).not.toBe(second)
    expect(first[0]).not.toBe(second[0])
    expect(first[0].content.map((block) => block.type)).toEqual(['text', 'text', 'tool_result'])
    expect(first[0].content[0].text).toBe(nativeFileHandleText(attachment))
    expect(first[0].content[2].content?.map((block) => block.type)).toEqual(['text', 'text'])
    expect(JSON.stringify(first)).not.toContain('"type":"file"')
    first[0].content[1].text = 'changed request copy'
    expect((history[0].content[1] as { text: string }).text).toBe('prompt')
  })

  it('public recovery exposes only top-level public FileBlocks and keeps tool_result text summaries', () => {
    const line = {
      type: 'user', uuid: 'u1', message: { role: 'user', content: [
        { type: 'file', attachment },
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'read notes.txt' }, { type: 'file', attachment }] },
      ] },
    } as RawLine
    const projected = publicNativeHistoryLine(line)
    expect(JSON.stringify(projected)).not.toContain('/private/registry')
    expect(JSON.stringify(projected)).not.toContain('modelForm')
    expect(JSON.stringify(projected)).not.toContain('mediaType')
    expect(projected.message!.content).toEqual([
      { type: 'file', attachment: { id: attachment.id, name: attachment.name, size: attachment.size, digest: attachment.digest } },
      { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'read notes.txt' }] },
    ])
    expect(((line.message as { content: Array<{ attachment: unknown }> }).content[0]).attachment).toBe(attachment)
  })

  it('projects verified PDF document blocks on every round and rejects a modified alias', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'pdf-projection-state-'))
    const cwd = await mkdtemp(join(tmpdir(), 'pdf-projection-cwd-'))
    dirs.push(stateDir, cwd)
    const bytes = Buffer.from('%PDF-1.4\nverified body')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const path = aliasPathOf(attachmentRoot(stateDir), digest, 'document.pdf')
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, bytes)
    const uploadStore = new UploadStore({ stateDir })
    uploadStore.record([{
      id: 'pdf-1', path, cwd, name: 'document.pdf', size: bytes.length, digest,
      uploadedAt: 1, sessionTitle: '', sessionId: 'session-1',
    }])
    const pdfAttachment: NativeFileAttachment = {
      id: 'pdf-1', name: 'document.pdf', size: bytes.length, digest, path,
      mediaType: 'application/pdf', modelForm: 'pdf-document',
    }
    const history = [{
      role: 'user',
      content: [
        { type: 'file', attachment: pdfAttachment },
        { type: 'tool_result', tool_use_id: 'read-1', content: [{ type: 'file', attachment: pdfAttachment }] },
      ],
    }]
    const before = structuredClone(history)
    const opts = { stateDir, uploadStore }

    const first = await projectNativeMessages(history, opts, new AbortController().signal) as Array<{
      content: Array<{ type: string; source?: { data: string }; title?: string; context?: string; content?: Array<{ type: string }> }>
    }>
    expect(first[0].content[0]).toMatchObject({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') },
      title: 'document.pdf',
      context: 'Upload id: pdf-1',
    })
    expect(first[0].content[0].source?.data).not.toContain('\n')
    expect(first[0].content[1].content?.[0].type).toBe('document')
    expect(history).toEqual(before)
    expect(JSON.stringify(history)).not.toContain(bytes.toString('base64'))

    await projectNativeMessages(history, opts, new AbortController().signal)
    // Two direct + two tool-result projections each perform a fresh verified read.
    expect(vi.mocked(createReadStream).mock.calls).toHaveLength(4)

    await writeFile(path, '%PDF-1.4\ntampered body')
    const failure = await projectNativeMessages(history, opts, new AbortController().signal).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/integrity|read/i)
    expect((failure as Error).message).not.toContain(path)
    expect(history).toEqual(before)
  })
})
