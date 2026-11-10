import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionSearchPanel } from './SessionSearchPanel'
import type { SessionSearchHit } from '../../shared/session-search'
import type { SessionSearchState } from '../hooks/useSessionSearch'
import type { MessagePreviewState } from '../hooks/useMessagePreview'

const mocks = vi.hoisted(() => ({
  search: null as SessionSearchState | null,
  preview: null as MessagePreviewState | null,
}))
vi.mock('../hooks/useSessionSearch', () => ({
  useSessionSearch: () => mocks.search,
}))
vi.mock('../hooks/useMessagePreview', () => ({
  useMessagePreview: () => mocks.preview,
}))

const HIT_A: SessionSearchHit = {
  seq: 10,
  messageSeq: 10,
  messageUuid: 'a10',
  turnSeq: 8,
  turnNo: 2,
  turnPrompt: 'Fix the search count',
  role: 'assistant',
  timestamp: Date.UTC(2026, 10, 9, 9, 21),
  snippet: 'confirmed: search counts sidechain too',
  matchCount: 1,
}

const HIT_B: SessionSearchHit = {
  seq: 20,
  messageSeq: 20,
  messageUuid: 'u20',
  turnSeq: 18,
  turnNo: 5,
  turnPrompt: 'Sorting',
  role: 'user',
  timestamp: Date.UTC(2026, 10, 9, 9, 41),
  snippet: 'what should search results sort by?',
  matchCount: 1,
}

function renderPanel(
  overrides: Partial<SessionSearchState> = {},
  props: Partial<Parameters<typeof SessionSearchPanel>[0]> = {},
) {
  mocks.search = {
    query: 'search',
    hits: [HIT_A, HIT_B],
    totalHits: 2,
    truncated: false,
    indexStatus: 'ok',
    loading: false,
    error: false,
    retry: vi.fn(),
    ...overrides,
  }
  mocks.preview = {
    page: {
      generation: 0,
      headSeq: 30,
      totalCount: 1,
      startIndex: 20,
      hasMore: false,
      tombstones: [],
      messages: [
        {
          seq: 20,
          uuid: 'u20',
          msg: {
            type: 'user',
            uuid: 'u20',
            message: { role: 'user', content: 'what should search results sort by?' },
          },
        },
      ],
    },
    loading: false,
    error: null,
    retry: vi.fn(),
  }
  const onClose = vi.fn()
  const utils = render(
    <SessionSearchPanel sessionId="s1" initialQuery="search" onClose={onClose} {...props} />,
  )
  return { ...utils, onClose }
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

describe('SessionSearchPanel', () => {
  it('renders hits grouped by turn with the query marked', () => {
    renderPanel()
    expect(screen.getAllByText(/^Turn \d+$/)).toHaveLength(2)
    expect(screen.getAllByRole('option')).toHaveLength(2)
    expect(document.querySelectorAll('mark')).toHaveLength(2)
  })

  it('opens the preview on click and returns to the results', () => {
    renderPanel()
    // The results view stays content-sized; only the preview carries the
    // definite-height class the embedded MessageList needs (see
    // search-panel.css .search-panel.has-preview).
    const panel = document.querySelector('.search-panel') as HTMLElement
    expect(panel.classList.contains('has-preview')).toBe(false)

    fireEvent.click(screen.getAllByRole('option')[1])

    expect(panel.classList.contains('has-preview')).toBe(true)
    expect(screen.getByRole('region', { name: 'Search result preview' })).toBeTruthy()
    expect(screen.getByText('Turn 5')).toBeTruthy()
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Back to results' }))
    expect(panel.classList.contains('has-preview')).toBe(false)
    expect(screen.getByRole('listbox')).toBeTruthy()
  })

  it('moves selection with ArrowDown/ArrowUp and opens the preview on Enter', () => {
    renderPanel()
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.getByRole('region', { name: 'Search result preview' })).toBeTruthy()
    expect(screen.getByText('Turn 5')).toBeTruthy()
  })

  it('hides stale results while the next query is debouncing', () => {
    renderPanel()
    const input = screen.getByRole('textbox')

    fireEvent.change(input, { target: { value: 'other' } })

    expect(screen.getByText('Searching…')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.queryByRole('region', { name: 'Search result preview' })).toBeNull()
  })

  it('starts in the preview when opened from the command palette', () => {
    renderPanel({}, { initialTarget: { kind: 'uuid', uuid: 'u20', query: 'search' } })
    expect(screen.getByRole('region', { name: 'Search result preview' })).toBeTruthy()
    expect(screen.getByText('Message')).toBeTruthy()
  })

  it('shows loading, empty, degraded, and error states', () => {
    renderPanel({ loading: true, hits: [], totalHits: 0 })
    expect(screen.getByText('Searching…')).toBeTruthy()

    renderPanel({ hits: [], totalHits: 0 })
    expect(screen.getByText('No matches')).toBeTruthy()

    renderPanel({ hits: [], totalHits: 0, indexStatus: 'degraded' })
    expect(screen.getByText("This session's history is temporarily unavailable")).toBeTruthy()

    renderPanel({ hits: [], totalHits: 0, error: true })
    expect(screen.getByText('Search failed')).toBeTruthy()
  })

  it('seeds the input from initialQuery and closes from the header button', () => {
    const { onClose } = renderPanel({}, { initialQuery: 'search' })
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('search')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })
})