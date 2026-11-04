import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { TurnChangedFile, TurnChangesSummary } from '../../../shared/turn-changes.js'

const hooks = vi.hoisted(() => ({
  summary: null as TurnChangesSummary | null,
  loading: false,
}))
vi.mock('../../hooks/useTurnChanges', () => ({
  useTurnChanges: () => ({ summary: hooks.summary, loading: hooks.loading }),
}))

import { TurnChangesCard } from './TurnChangesCard'
import { TurnChangesProvider } from './turn-changes-context'

const fileA: TurnChangedFile = { path: 'src/a.ts', display: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 }
const fileB: TurnChangedFile = { path: 'src/b.ts', display: 'src/b.ts', status: 'added', additions: 1, deletions: 0 }

function summaryOf(files: TurnChangedFile[]): TurnChangesSummary {
  return {
    resultUuid: 'r1', assistantUuid: 'a1', files, total: files.length,
    added: files.reduce((sum, file) => sum + file.additions, 0),
    deleted: files.reduce((sum, file) => sum + file.deletions, 0),
  }
}

function renderCard(open = vi.fn()) {
  return {
    open,
    ...render(
      <TurnChangesProvider value={{ openTurnReview: open }}>
        <TurnChangesCard sessionId="s1" resultUuid="r1" />
      </TurnChangesProvider>,
    ),
  }
}

beforeEach(() => {
  hooks.summary = null
  hooks.loading = false
})
afterEach(() => vi.useRealTimers())

describe('TurnChangesCard', () => {
  it('renders nothing without a summary or for an empty turn', () => {
    const { container, unmount } = renderCard()
    expect(container.firstChild).toBeNull()
    unmount()

    hooks.summary = summaryOf([])
    const empty = renderCard()
    expect(empty.container.firstChild).toBeNull()
  })

  it('lists files, folds past four, and opens the clicked index', async () => {
    const files = Array.from({ length: 6 }, (_, index) => ({
      ...fileA,
      path: `src/f${index}.ts`,
      display: `src/f${index}.ts`,
    }))
    hooks.summary = summaryOf(files)
    const { open } = renderCard()

    expect(screen.getByText('Edited 6 files')).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(4)

    fireEvent.click(screen.getByRole('button', { name: 'View changes to src/f1.ts' }))
    expect(open).toHaveBeenCalledWith('r1', 1)

    fireEvent.click(screen.getByRole('button', { name: 'Show all 6' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(6)
  })

  it('renders a single file as the header only', () => {
    hooks.summary = summaryOf([fileA])
    renderCard()
    expect(screen.queryByRole('listitem')).toBeNull()
    expect(screen.getByText('Edited a.ts')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View changes to src/a.ts' })).toBeTruthy()
  })

  it('labels a binary file instead of counts', () => {
    hooks.summary = summaryOf([{ ...fileA, binary: true, additions: 0, deletions: 0 }, fileB])
    renderCard()
    expect(screen.getByText('binary')).toBeTruthy()
  })

  it('opens no preview on hover; clicking opens the review', () => {
    vi.useFakeTimers()
    hooks.summary = summaryOf([fileA])
    const { open } = renderCard()

    const button = screen.getByRole('button', { name: 'View changes to src/a.ts' })
    // Body element count is the class-agnostic guard: a future hover preview
    // under any markup (inline or portal) would have to mount something.
    const bodyCount = document.body.querySelectorAll('*').length
    fireEvent.mouseEnter(button)
    // Past the old 400ms hover delay: nothing may appear.
    act(() => { vi.advanceTimersByTime(400) })
    expect(document.body.querySelectorAll('*').length).toBe(bodyCount)

    fireEvent.click(button)
    expect(open).toHaveBeenCalledWith('r1', 0)
  })
})