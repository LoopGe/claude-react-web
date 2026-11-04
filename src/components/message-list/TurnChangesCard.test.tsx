import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { TurnChangedFile, TurnChangesSummary, TurnDiffPayload } from '../../../shared/turn-changes.js'

const hooks = vi.hoisted(() => ({
  summary: null as TurnChangesSummary | null,
  diff: null as TurnDiffPayload | null,
  loading: false,
}))
vi.mock('../../hooks/useTurnChanges', () => ({
  useTurnChanges: () => ({ summary: hooks.summary, loading: hooks.loading }),
  useTurnDiff: () => ({ diff: hooks.diff, loading: false }),
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
  hooks.diff = null
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

  it('previews a file after the hover delay and only then reads its diff', () => {
    vi.useFakeTimers()
    hooks.summary = summaryOf([fileA])
    hooks.diff = { available: true, patch: '@@ -1 +1 @@\n-old\n+new\n', truncated: false, totalLines: 3 }
    renderCard()

    expect(document.querySelector('.turn-changes-preview')).toBeNull()
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'View changes to src/a.ts' }))
    act(() => { vi.advanceTimersByTime(400) })

    expect(document.querySelector('.turn-changes-preview-path')?.textContent).toBe('src/a.ts')
    expect(document.querySelector('.git-diff-row.add')).toBeTruthy()
  })
})