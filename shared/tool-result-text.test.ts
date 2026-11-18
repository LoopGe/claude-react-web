import { describe, expect, it } from 'vitest'
import { toolResultBodyParts, toolResultTextRuns, type ToolResultPart } from './tool-result-text.js'
import { truncate } from './text.js'
import { formatJson } from './format.js'

const PNG = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
const pngUrl = 'data:image/png;base64,AAAA'
const fileBlock = {
  type: 'file',
  attachment: { id: 'internal', name: 'private.pdf', size: 99, digest: 'b'.repeat(64) },
}

describe('toolResultTextRuns — string content', () => {
  it('truncates a long plain string at 4000 visible chars', () => {
    const content = 'a'.repeat(5000)
    expect(toolResultTextRuns(content)).toEqual([truncate(content, 4000)])
    expect(toolResultTextRuns(content)[0]).toBe('a'.repeat(4000) + '…')
  })

  it('truncates ANSI-bearing content by VISIBLE chars, preserving fitted escapes', () => {
    const content = '\x1b[31m' + 'b'.repeat(4500) + '\x1b[0m'
    const runs = toolResultTextRuns(content)
    expect(runs).toEqual([truncate(content, 4000)])
    expect(runs[0].length).toBeLessThan(content.length)
    expect(runs[0].startsWith('\x1b[31m')).toBe(true)
  })

  it('leaves a short ANSI string untouched', () => {
    const content = '\x1b[32mok\x1b[0m'
    expect(toolResultTextRuns(content)).toEqual([content])
  })

  it('keeps an empty string as one empty run (no formatJson fallback for strings)', () => {
    expect(toolResultBodyParts('')).toEqual([{ kind: 'text', text: '' }])
    expect(toolResultTextRuns('')).toEqual([''])
  })
})

describe('toolResultTextRuns — text buffers', () => {
  it('collapses consecutive text blocks into ONE run joined by \\n\\n', () => {
    const content = [{ type: 'text', text: 'alpha' }, { type: 'text', text: 'beta' }]
    expect(toolResultTextRuns(content)).toEqual(['alpha\n\nbeta'])
    expect(toolResultBodyParts(content)).toEqual([{ kind: 'text', text: 'alpha\n\nbeta' }])
  })

  it('truncates the joined buffer once at 4000 visible chars', () => {
    const content = [{ type: 'text', text: 'a'.repeat(3000) }, { type: 'text', text: 'b'.repeat(3000) }]
    const joined = 'a'.repeat(3000) + '\n\n' + 'b'.repeat(3000)
    expect(toolResultTextRuns(content)).toEqual([truncate(joined, 4000)])
  })

  it('accepts a single text-block object (not wrapped in an array)', () => {
    expect(toolResultTextRuns({ type: 'text', text: 'solo' })).toEqual(['solo'])
  })
})

describe('toolResultBodyParts — interleaved text + image', () => {
  it('flushes a text run at each image run, preserving source order', () => {
    const content = [{ type: 'text', text: 'before' }, PNG, { type: 'text', text: 'after' }]
    const parts: ToolResultPart[] = [
      { kind: 'text', text: 'before' },
      { kind: 'images', srcs: [pngUrl] },
      { kind: 'text', text: 'after' },
    ]
    expect(toolResultBodyParts(content)).toEqual(parts)
    expect(toolResultTextRuns(content)).toEqual(['before', 'after'])
  })

  it('groups consecutive images into one images part', () => {
    const second = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } }
    const content = [PNG, second]
    expect(toolResultBodyParts(content)).toEqual([
      { kind: 'images', srcs: [pngUrl, 'data:image/png;base64,BBBB'] },
    ])
    expect(toolResultTextRuns(content)).toEqual([])
  })

  it('renders an image-only result as just an images part (no text run)', () => {
    expect(toolResultTextRuns([PNG])).toEqual([])
  })
})

describe('toolResultTextRuns — non-text non-image blocks', () => {
  it('serializes a NON-file unknown block with formatJson into the text buffer', () => {
    const block = { type: 'unknown', x: 1 }
    expect(toolResultTextRuns([block])).toEqual([formatJson(block)])
    expect(toolResultBodyParts([block])).toEqual([{ kind: 'text', text: formatJson(block) }])
  })

  it('joins a text block and a non-file unknown block in one run', () => {
    const block = { type: 'unknown', x: 1 }
    expect(toolResultTextRuns([{ type: 'text', text: 'hi' }, block])).toEqual(['hi\n\n' + formatJson(block)])
  })

  it('keeps an invalid image block in the text fallback (no images part)', () => {
    const invalid = { type: 'image', source: { type: 'url', url: 'http://x' } }
    expect(toolResultBodyParts([invalid])).toEqual([{ kind: 'text', text: formatJson(invalid) }])
  })
})

describe('toolResultTextRuns — empty / null shapes', () => {
  it('falls back to formatJson(content) for an empty array', () => {
    expect(toolResultTextRuns([])).toEqual([formatJson([])])
  })

  it('falls back to formatJson(content) for an empty text-only array', () => {
    const content = [{ type: 'text', text: '' }]
    expect(toolResultTextRuns(content)).toEqual([formatJson(content)])
  })

  it('skips null / undefined elements', () => {
    expect(toolResultTextRuns([null, { type: 'text', text: 'survived' }, undefined])).toEqual(['survived'])
  })
})

describe('toolResultTextRuns — internal file blocks are never indexed (privacy)', () => {
  it('indexes only the text summary beside a file block; name/digest/id absent', () => {
    const summary = 'PDF summary: quarterly revenue'
    for (const content of [[{ type: 'text', text: summary }, fileBlock], [fileBlock, { type: 'text', text: summary }]]) {
      expect(toolResultTextRuns(content)).toEqual([summary])
      const serialized = JSON.stringify(toolResultBodyParts(content))
      expect(serialized).not.toContain('private.pdf')
      expect(serialized).not.toContain('b'.repeat(64))
      expect(serialized).not.toContain('internal')
    }
  })

  it('returns NO runs for a file-only array (no formatJson fallback leak)', () => {
    expect(toolResultBodyParts([fileBlock])).toEqual([])
    expect(toolResultTextRuns([fileBlock])).toEqual([])
    expect(toolResultTextRuns([fileBlock, null])).toEqual([])
  })

  it('returns NO runs for a single file-block object', () => {
    expect(toolResultTextRuns(fileBlock)).toEqual([])
  })

  it('a file block contributes nothing and is not a flush boundary', () => {
    const content = [{ type: 'text', text: 'a' }, fileBlock, { type: 'text', text: 'b' }]
    expect(toolResultTextRuns(content)).toEqual(['a\n\nb'])
    expect(toolResultBodyParts(content)).toEqual([{ kind: 'text', text: 'a\n\nb' }])
  })

  it('still falls back to formatJson for genuinely empty content with no file block', () => {
    expect(toolResultTextRuns([])).toEqual(['[]'])
    expect(toolResultTextRuns(null)).toEqual([formatJson(null)])
  })
})