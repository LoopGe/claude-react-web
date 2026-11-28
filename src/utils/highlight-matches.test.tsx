import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderMatchMarks } from './highlight-matches'

function marks(text: string, query: string, opts?: { caseSensitive?: boolean }) {
  const { container } = render(<div>{renderMatchMarks(text, query, opts)}</div>)
  return {
    root: container.firstElementChild as HTMLElement,
    marked: Array.from(container.querySelectorAll('mark')).map((el) => el.textContent),
  }
}

describe('renderMatchMarks', () => {
  it('returns the text unchanged without a query or a match', () => {
    expect(marks('hello world', '')).toEqual({
      root: expect.objectContaining({ textContent: 'hello world' }),
      marked: [],
    })
    expect(marks('hello world', 'absent')).toEqual({
      root: expect.objectContaining({ textContent: 'hello world' }),
      marked: [],
    })
  })

  it('marks every case-insensitive occurrence and preserves the full text', () => {
    const { root, marked } = marks('Search results: search again', 'search')
    expect(marked).toEqual(['Search', 'search'])
    expect(root.textContent).toBe('Search results: search again')
  })

  it('treats regex metacharacters in the query literally', () => {
    const { marked } = marks('a.b axb', 'a.b')
    expect(marked).toEqual(['a.b'])
  })

  it('marks adjacent occurrences without dropping characters', () => {
    const { root, marked } = marks('aaaa', 'aa')
    expect(marked).toEqual(['aa', 'aa'])
    expect(root.textContent).toBe('aaaa')
  })

  it('honours caseSensitive', () => {
    const { marked } = marks('Search search', 'Search', { caseSensitive: true })
    expect(marked).toEqual(['Search'])
  })

  it('lights only the activeIdx range with search-hl-active', () => {
    const { container } = render(<div>{renderMatchMarks('tick tick tick', 'tick', { activeIdx: 1 })}</div>)
    const all = container.querySelectorAll('mark.search-hl')
    const active = container.querySelectorAll('mark.search-hl-active')
    expect(all).toHaveLength(3)
    expect(active).toHaveLength(1)
    expect(all[1].classList.contains('search-hl-active')).toBe(true)
  })

  it('no active mark when activeIdx is undefined or out of range', () => {
    const { container } = render(<div>{renderMatchMarks('tick tick', 'tick', { activeIdx: 5 })}</div>)
    expect(container.querySelectorAll('mark.search-hl-active')).toHaveLength(0)
  })
})