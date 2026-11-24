// splitFrontmatter: the markdown preview's metadata split. A leading `---`
// opens a frontmatter block ONLY when a closing delimiter line exists — a
// lone leading horizontal rule is markdown and must pass through untouched.

import { describe, it, expect } from 'vitest'
import { splitFrontmatter } from './frontmatter'

describe('splitFrontmatter', () => {
  it('splits a leading --- block with a closing --- line', () => {
    expect(splitFrontmatter('---\ntitle: x\n---\nbody')).toEqual({
      frontmatter: 'title: x',
      body: 'body',
    })
  })

  it('keeps multi-line frontmatter verbatim and the body after the close', () => {
    expect(splitFrontmatter('---\ntitle: x\ntags:\n  - a\n  - b\n---\n\n# Hi')).toEqual({
      frontmatter: 'title: x\ntags:\n  - a\n  - b',
      body: '\n# Hi',
    })
  })

  it('accepts the ... closing variant', () => {
    expect(splitFrontmatter('---\ntitle: x\n...\nbody')).toEqual({
      frontmatter: 'title: x',
      body: 'body',
    })
  })

  it('handles CRLF line endings', () => {
    expect(splitFrontmatter('---\r\ntitle: x\r\n---\r\nbody')).toEqual({
      frontmatter: 'title: x',
      body: 'body',
    })
  })

  it('does not eat a leading horizontal rule with no closing delimiter', () => {
    const contents = '---\n\n# Hello\n\nsome text'
    expect(splitFrontmatter(contents)).toEqual({ frontmatter: null, body: contents })
  })

  it('ignores a --- block that is not at the very start', () => {
    const contents = 'intro\n---\ntitle: x\n---\nbody'
    expect(splitFrontmatter(contents)).toEqual({ frontmatter: null, body: contents })
  })

  it('requires the closing delimiter to be a whole line', () => {
    const contents = '---\ntitle: x\n----\nbody'
    expect(splitFrontmatter(contents)).toEqual({ frontmatter: null, body: contents })
  })

  it('splits an empty frontmatter block', () => {
    expect(splitFrontmatter('---\n---\nbody')).toEqual({ frontmatter: '', body: 'body' })
  })

  it('splits when the closing delimiter ends the file', () => {
    expect(splitFrontmatter('---\ntitle: x\n---')).toEqual({ frontmatter: 'title: x', body: '' })
  })

  it('returns plain content unchanged', () => {
    const contents = '# Hello\n\ntext'
    expect(splitFrontmatter(contents)).toEqual({ frontmatter: null, body: contents })
  })
})