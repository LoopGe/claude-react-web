import { describe, expect, it } from 'vitest'
import { nativeFileHandleText, projectNativeMessages, publicNativeHistoryLine } from './attachment-projection.js'
import type { NativeFileAttachment } from './session-log/format.js'
import type { RawLine } from '../../history-reader.js'

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
})
