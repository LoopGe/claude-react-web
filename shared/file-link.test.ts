// Markdown file-link parsing (docs/resource-tabs-research.md §14 Phase 2).
// A link opens a resource when it names a path (relative or absolute) with an
// optional GitHub-style `#L10` / `#L10-L20` range. External URLs, other
// schemes, and non-line fragments are left to the browser.

import { describe, it, expect } from 'vitest'
import { parseFileLink } from './file-link'

describe('parseFileLink', () => {
  it('parses a plain relative path', () => {
    expect(parseFileLink('src/a.ts')).toEqual({ path: 'src/a.ts' })
  })

  it('parses a single line and a range', () => {
    expect(parseFileLink('src/a.ts#L10')).toEqual({ path: 'src/a.ts', line: 10 })
    expect(parseFileLink('src/a.ts#L10-L20')).toEqual({
      path: 'src/a.ts',
      line: 10,
      endLine: 20,
    })
    expect(parseFileLink('src/a.ts#l10-l20')).toEqual({
      path: 'src/a.ts',
      line: 10,
      endLine: 20,
    })
  })

  it('parses a bare line anchor (resolved against the previewed file)', () => {
    expect(parseFileLink('#L7')).toEqual({ path: '', line: 7 })
  })

  it('rejects external URLs and other schemes', () => {
    expect(parseFileLink('https://example.com/a.ts')).toBeNull()
    expect(parseFileLink('mailto:a@b.c')).toBeNull()
    expect(parseFileLink('data:text/plain,hi')).toBeNull()
    expect(parseFileLink('file:///etc/passwd')).toBeNull()
    expect(parseFileLink('//cdn.example.com/a.ts')).toBeNull()
  })

  it('decodes percent-encoded path characters', () => {
    expect(parseFileLink('src/my%20file.ts#L2')).toEqual({ path: 'src/my file.ts', line: 2 })
  })

  it('opens the file for a section anchor (dropping the fragment)', () => {
    expect(parseFileLink('src/a.ts#section')).toEqual({ path: 'src/a.ts' })
    expect(parseFileLink('#section')).toBeNull()
  })

  it('rejects invalid line ranges and empty links', () => {
    expect(parseFileLink('src/a.ts#L0')).toBeNull()
    expect(parseFileLink('src/a.ts#L20-L10')).toBeNull()
    expect(parseFileLink('')).toBeNull()
  })

  it('accepts Windows absolute paths despite the drive-letter colon', () => {
    expect(parseFileLink('C:\\repo\\a.ts')).toEqual({ path: 'C:\\repo\\a.ts' })
    expect(parseFileLink('C:/repo/a.ts#L3')).toEqual({ path: 'C:/repo/a.ts', line: 3 })
  })
})