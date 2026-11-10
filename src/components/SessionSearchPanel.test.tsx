import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionSearchPanel } from './SessionSearchPanel'
import type { SessionSearchHit } from '../../shared/session-search'
import type { SessionSearchState } from '../hooks/useSessionSearch'

const mocks = vi.hoisted(() => ({ state: null as SessionSearchState | null }))
vi.mock('../hooks/useSessionSearch', () => ({
  useSessionSearch: () => mocks.state,
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
  mocks.state = {
    hits: [HIT_A, HIT_B],
    totalHits: 2,
    truncated: false,
    indexStatus: 'ok',
    loading: false,
    error: false,
    retry: vi.fn(),
    ...overrides,
  }
  const onClose = vi.fn()
  const onSelect = vi.fn()
  const utils = render(
    <SessionSearchPanel
      sessionId="s1"
      initialQuery="search"
      onClose={onClose}
      onSelect={onSelect}
      {...props}
    />,
  )
  return { ...utils, onClose, onSelect }
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

  it('moves selection with ArrowDown/ArrowUp and selects on Enter', () => {
    const { onSelect } = renderPanel()
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ turnNo: 5 }))
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