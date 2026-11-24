// @vitest-environment happy-dom
// FrontmatterFields: lazy yaml parse → key/value field list. Parse failure or
// a non-object document is a proven contract state → verbatim <pre> fallback
// (the same view as the loading state, so the chunk never blanks the preview).

import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { FrontmatterFields } from './FrontmatterFields'

// Warm the lazy chunk once so each test's import('yaml') resolves from the
// module cache in microtasks — the fallback assertions below flush with act()
// and must not race a cold module transform.
beforeAll(async () => {
  await import('yaml')
})

async function flush() {
  await act(async () => {})
}

describe('FrontmatterFields', () => {
  it('shows the verbatim source while the yaml chunk loads', () => {
    render(<FrontmatterFields source="title: x" />)
    const pre = document.body.querySelector('pre.frontmatter-verbatim')
    expect(pre?.textContent).toBe('title: x')
    expect(document.body.querySelector('.frontmatter-fields')).toBeNull()
  })

  it('renders key/value rows for a valid YAML mapping', async () => {
    render(<FrontmatterFields source={'title: My note\ndraft: false\nwords: 120'} />)
    await screen.findByText('My note')
    expect(screen.getByText('title').tagName).toBe('DT')
    expect(screen.getByText('My note').tagName).toBe('DD')
    expect(screen.getByText('false').tagName).toBe('DD')
    expect(screen.getByText('120').tagName).toBe('DD')
    expect(document.body.querySelector('pre.frontmatter-verbatim')).toBeNull()
  })

  it('renders nested values readably, never [object Object]', async () => {
    render(<FrontmatterFields source={'author:\n  name: Ada\n  tags: [a, b]'} />)
    const value = await screen.findByText(/"name": "Ada"/)
    expect(value.tagName).toBe('DD')
    expect(value.textContent).toContain('"tags"')
    expect(document.body.textContent).not.toContain('[object Object]')
  })

  it('falls back to the verbatim source for invalid YAML', async () => {
    const source = 'title: [unclosed'
    render(<FrontmatterFields source={source} />)
    await flush()
    expect(document.body.querySelector('pre.frontmatter-verbatim')?.textContent).toBe(source)
    expect(document.body.querySelector('.frontmatter-fields')).toBeNull()
  })

  it('falls back to the verbatim source for a non-object document', async () => {
    const source = '- a\n- b'
    render(<FrontmatterFields source={source} />)
    await flush()
    expect(document.body.querySelector('pre.frontmatter-verbatim')?.textContent).toBe(source)
    expect(document.body.querySelector('.frontmatter-fields')).toBeNull()
  })
})