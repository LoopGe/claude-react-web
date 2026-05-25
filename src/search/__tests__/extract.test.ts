import { describe, it, expect } from 'vitest'
import { extractPlainText, extractMessagePlainText } from '../extract'
import type { SdkMessage } from '../../types'

describe('extractPlainText', () => {
  it('strips inline emphasis', () => {
    expect(extractPlainText('**hello** world')).toBe('hello world')
    expect(extractPlainText('*hello* _world_')).toBe('hello world')
  })

  it('strips inline code backticks', () => {
    expect(extractPlainText('use `foo()` to call')).toBe('use foo() to call')
  })

  it('strips link syntax, keeping the text', () => {
    expect(extractPlainText('see [docs](https://example.com)')).toBe('see docs')
  })

  it('strips heading markers and inserts a newline before the heading', () => {
    expect(extractPlainText('# Title\n\nbody')).toBe('Title\nbody')
    expect(extractPlainText('intro\n\n## sub\n\nmore')).toBe('intro\nsub\nmore')
  })

  it('flattens lists', () => {
    expect(extractPlainText('- one\n- two\n- three')).toBe('one\ntwo\nthree')
  })

  it('keeps fenced code block contents', () => {
    const md = '```js\nconst x = 1\nconsole.log(x)\n```'
    const out = extractPlainText(md)
    expect(out).toContain('const x = 1')
    expect(out).toContain('console.log(x)')
    // The fence markers themselves are gone.
    expect(out).not.toContain('```')
  })

  it('flattens paragraphs with a single newline separator', () => {
    expect(extractPlainText('first\n\nsecond')).toBe('first\nsecond')
  })

  it('does not insert a separator for purely inline formatting', () => {
    // The whole point of the cross-node fix: "**hello** world" must
    // flatten to a single string so a phrase query matches.
    expect(extractPlainText('**hello** world')).toBe('hello world')
    expect(extractPlainText('*a* *b* *c*')).toBe('a b c')
  })

  it('returns empty string for empty input', () => {
    expect(extractPlainText('')).toBe('')
  })
})

describe('extractMessagePlainText', () => {
  it('returns null when no text content is present', () => {
    expect(extractMessagePlainText({ type: 'user' } as SdkMessage)).toBeNull()
    expect(extractMessagePlainText({ type: 'user', message: { content: [] } } as unknown as SdkMessage)).toBeNull()
  })

  it('handles string content', () => {
    const msg = { type: 'user', message: { content: 'Hello **world**' } } as SdkMessage
    expect(extractMessagePlainText(msg)).toBe('Hello world')
  })

  it('joins multiple text blocks with a double newline', () => {
    const msg = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'first **block**' },
          { type: 'tool_use', name: 'X', input: {} },
          { type: 'text', text: '_second_ block' },
        ],
      },
    } as unknown as SdkMessage
    expect(extractMessagePlainText(msg)).toBe('first block\n\nsecond block')
  })

  it('skips non-text blocks per the design decision', () => {
    const msg = {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'x', content: 'should not be searchable' },
          { type: 'image', source: {} },
        ],
      },
    } as unknown as SdkMessage
    expect(extractMessagePlainText(msg)).toBeNull()
  })

  it('falls back to msg.error for system error frames', () => {
    const msg = { type: 'system', subtype: 'error', error: 'boom' } as unknown as SdkMessage
    expect(extractMessagePlainText(msg)).toBe('boom')
  })
})
