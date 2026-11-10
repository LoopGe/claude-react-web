import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionSearchDialog } from './SessionSearchDialog'
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
  turnPrompt: '把搜索修一下',
  role: 'assistant',
  timestamp: Date.UTC(2026, 10, 9, 9, 21),
  snippet: '确认了：搜索计数把 sidechain 也算进去了',
  matchCount: 1,
}

const HIT_B: SessionSearchHit = {
  seq: 20,
  messageSeq: 20,
  messageUuid: 'u20',
  turnSeq: 18,
  turnNo: 5,
  turnPrompt: '排序',
  role: 'user',
  timestamp: Date.UTC(2026, 10, 9, 9, 41),
  snippet: '搜索结果的排序应该按什么？',
  matchCount: 1,
}

function renderDialog(
  overrides: Partial<SessionSearchState> = {},
  props: Partial<Parameters<typeof SessionSearchDialog>[0]> = {},
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
    <SessionSearchDialog
      open
      sessionId="s1"
      initialQuery="搜索"
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

describe('SessionSearchDialog', () => {
  it('renders hits grouped by turn with the query marked', () => {
    renderDialog()
    expect(screen.getAllByText(/^第 \d+ 轮$/)).toHaveLength(2)
    expect(screen.getAllByRole('option')).toHaveLength(2)
    expect(document.querySelectorAll('mark')).toHaveLength(2)
  })

  it('moves selection with ArrowDown/ArrowUp and selects on Enter', () => {
    const { onSelect } = renderDialog()
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ turnNo: 5 }))
  })

  it('shows loading, empty, degraded, and error states', () => {
    renderDialog({ loading: true, hits: [], totalHits: 0 })
    expect(screen.getByText('搜索中…')).toBeTruthy()

    renderDialog({ hits: [], totalHits: 0 })
    expect(screen.getByText('没有找到匹配')).toBeTruthy()

    renderDialog({ hits: [], totalHits: 0, indexStatus: 'degraded' })
    expect(screen.getByText('这段会话的历史暂时无法读取')).toBeTruthy()

    renderDialog({ hits: [], totalHits: 0, error: true })
    expect(screen.getByText('搜索失败')).toBeTruthy()
  })

  it('seeds the input from initialQuery and closes on Escape', () => {
    const { onClose } = renderDialog({}, { initialQuery: '搜索' })
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('搜索')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})