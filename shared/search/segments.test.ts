import { describe, expect, it } from 'vitest'
import { fileHandleText } from '../upload-handle.js'
import {
  countMessageSearchMatches,
  locateMessageSearchMatch,
} from './segments.js'
import { extractMessageSearchSegments } from './extract.js'

const file = { id: 'upload-1', name: 'report.pdf', size: 42 }

describe('message search segments', () => {
  it('keeps text and top-level attachments in source order', () => {
    const segments = extractMessageSearchSegments({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [
        { type: 'text', text: 'before' },
        { type: 'file', attachment: { ...file, digest: 'a'.repeat(64) } },
        { type: 'text', text: 'after' },
      ] },
    })

    expect(segments).toEqual([
      { type: 'text', text: 'before' },
      { type: 'attachment', text: 'report.pdf', attachment: file },
      { type: 'text', text: 'after' },
    ])
    expect(JSON.stringify(segments)).not.toContain('a'.repeat(64))
  })

  it('recovers each legacy handle at its original text position', () => {
    const handle = fileHandleText(file, '/private/report.pdf')
    const segments = extractMessageSearchSegments({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: `before${handle}after` },
    })

    expect(segments).toEqual([
      { type: 'text', text: 'before' },
      { type: 'attachment', text: 'report.pdf', attachment: file },
      { type: 'text', text: 'after' },
    ])
    expect(JSON.stringify(segments)).not.toContain('/private/report.pdf')
  })

  it('continues past a terminator embedded in a valid JSON filename', () => {
    const tricky = { id: 'upload-tricky', name: 'quarterly read it.] report.pdf', size: 42, digest: 'd'.repeat(64) }
    const handle = fileHandleText(tricky, '/private/quarterly.pdf')
    const segments = extractMessageSearchSegments({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: `before${handle}after` },
    })

    expect(segments).toEqual([
      { type: 'text', text: 'before' },
      { type: 'attachment', text: tricky.name, attachment: { id: tricky.id, name: tricky.name, size: tricky.size } },
      { type: 'text', text: 'after' },
    ])
    expect(countMessageSearchMatches(segments, '/private/quarterly.pdf')).toBe(0)
    expect(countMessageSearchMatches(segments, 'd'.repeat(8))).toBe(0)
  })

  it('counts within segments without allowing a cross-segment phrase match', () => {
    const segments = extractMessageSearchSegments({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [
        { type: 'text', text: 'before' },
        { type: 'file', attachment: file },
        { type: 'text', text: 'after' },
      ] },
    })

    expect(countMessageSearchMatches(segments, 'report')).toBe(1)
    expect(countMessageSearchMatches(segments, 'before report')).toBe(0)
    expect(locateMessageSearchMatch(segments, 'report', 0)).toEqual({ segmentIndex: 1, matchIndex: 0 })
  })

  it('indexes AttachmentRead text summaries but not internal file payloads', () => {
    const segments = extractMessageSearchSegments({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{
        type: 'tool_result',
        tool_use_id: 'read-1',
        content: [
          { type: 'file', attachment: { id: 'internal', name: 'private.pdf', size: 99, digest: 'b'.repeat(64) } },
          { type: 'text', text: 'PDF summary: quarterly revenue' },
        ],
      }] },
    })

    expect(segments).toEqual([{ type: 'text', text: 'PDF summary: quarterly revenue' }])
    expect(countMessageSearchMatches(segments, 'private.pdf')).toBe(0)
    expect(countMessageSearchMatches(segments, 'quarterly revenue')).toBe(1)
  })

  it('does not index file contents, base64, paths, or digests', () => {
    const segments = extractMessageSearchSegments({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{
        type: 'file',
        attachment: {
          id: 'upload-1',
          name: 'report.pdf',
          size: 42,
          digest: 'c'.repeat(64),
          path: '/secret/report.pdf',
          mediaType: 'application/pdf',
          modelForm: { source: { data: 'BASE64PAYLOAD', text: 'ORIGINAL FILE CONTENTS' } },
        },
      }] },
    })

    for (const query of ['ORIGINAL FILE CONTENTS', 'BASE64PAYLOAD', '/secret/report.pdf', 'c'.repeat(64)]) {
      expect(countMessageSearchMatches(segments, query)).toBe(0)
    }
    expect(countMessageSearchMatches(segments, 'report.pdf')).toBe(1)
  })

  it('keeps existing tool diff and system error sources', () => {
    const diff = extractMessageSearchSegments({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Write', input: { content: 'const answer = 42' } }] },
    })
    expect(diff).toEqual([{ type: 'text', text: 'const answer = 42' }])
    expect(extractMessageSearchSegments({ type: 'system', subtype: 'error', error: 'boom' })).toEqual([
      { type: 'text', text: 'boom' },
    ])
  })
})
