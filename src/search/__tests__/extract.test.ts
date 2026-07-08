import { describe, it, expect } from 'vitest'
import { extractPlainText, extractMessagePlainText, extractToolUseDiffText } from '../extract'
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

  it('extracts tool_result content for searchability', () => {
    const msg = {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'x', content: 'bash output here' },
          { type: 'image', source: {} },
        ],
      },
    } as unknown as SdkMessage
    expect(extractMessagePlainText(msg)).toBe('bash output here')
  })

  it('extracts tool_result with nested text blocks', () => {
    const msg = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'x',
            content: [
              { type: 'text', text: 'line one' },
              { type: 'text', text: 'line two' },
            ],
          },
        ],
      },
    } as unknown as SdkMessage
    expect(extractMessagePlainText(msg)).toBe('line one\n\nline two')
  })

  it('skips non-text, non-tool_result blocks', () => {
    const msg = {
      type: 'user',
      message: {
        content: [
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

// ── tool_use diff extraction ───────────────────────────────────────

describe('extractToolUseDiffText', () => {
  it('Edit: del+add lines only (eq excluded), in unified order', () => {
    // old="a\nb\nc", new="a\nB\nc" → eq a, del b, add B, eq c → "b\nB"
    expect(extractToolUseDiffText(
      { old_string: 'a\nb\nc', new_string: 'a\nB\nc' },
      'Edit',
    )).toBe('b\nB')
  })

  it('MultiEdit: concatenates each edit del+add with blank-line separator', () => {
    expect(extractToolUseDiffText(
      { edits: [
        { old_string: 'x', new_string: 'y' },
        { old_string: 'p\nq', new_string: 'p\nQ' },
      ] },
      'MultiEdit',
    )).toBe('x\ny\n\nq\nQ')
  })

  it('Write: full content', () => {
    expect(extractToolUseDiffText({ content: 'line1\nline2' }, 'Write')).toBe('line1\nline2')
  })

  it('NotebookEdit: new_source (replace/insert)', () => {
    expect(extractToolUseDiffText({ new_source: 'cell code', edit_mode: 'replace' }, 'NotebookEdit')).toBe('cell code')
  })

  it('NotebookEdit delete mode: nothing indexed', () => {
    expect(extractToolUseDiffText({ new_source: 'cell code', edit_mode: 'delete' }, 'NotebookEdit')).toBe('')
  })

  it('non-diff tools (Bash/Read/Grep) contribute nothing', () => {
    expect(extractToolUseDiffText({ command: 'ls', file_path: 'a' }, 'Bash')).toBe('')
    expect(extractToolUseDiffText({ file_path: 'a' }, 'Read')).toBe('')
    expect(extractToolUseDiffText({ pattern: 'x' }, 'Grep')).toBe('')
  })

  it('defensive: missing/malformed fields → empty', () => {
    expect(extractToolUseDiffText({}, 'Edit')).toBe('')
    expect(extractToolUseDiffText({ old_string: 5 }, 'Edit')).toBe('')
    expect(extractToolUseDiffText(null, 'Edit')).toBe('')
  })
})

describe('extractMessagePlainText tool_use integration', () => {
  it('Edit tool_use contributes its del+add text between text blocks', () => {
    const msg = {
      type: 'assistant',
      message: { content: [
        { type: 'text', text: 'editing now' },
        { type: 'tool_use', name: 'Edit', input: { old_string: 'foo\nbar', new_string: 'foo\nBAR' } },
        { type: 'text', text: 'done' },
      ] },
    } as unknown as SdkMessage
    // text "editing now" + Edit del+add "bar\nBAR" + text "done", \n\n joined.
    expect(extractMessagePlainText(msg)).toBe('editing now\n\nbar\nBAR\n\ndone')
  })

  it('Write tool_use contributes its content', () => {
    const msg = {
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', name: 'Write', input: { file_path: 'a.ts', content: 'export const x = 1' } },
      ] },
    } as unknown as SdkMessage
    expect(extractMessagePlainText(msg)).toBe('export const x = 1')
  })
})
