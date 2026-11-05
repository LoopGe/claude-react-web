import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { TurnChangedFile, TurnChangesSummary, TurnDiffPayload } from '../../shared/turn-changes.js'

const hooks = vi.hoisted(() => ({
  summary: null as TurnChangesSummary | null,
  diffs: {} as Record<number, TurnDiffPayload | null>,
  diffLoading: false,
  diffCalls: [] as Array<{ index: number; opts?: { full?: boolean; view?: 'changes' | 'full-file' } }>,
}))
const apiMocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../hooks/useApi', () => ({ api: { get: apiMocks.get } }))
vi.mock('../hooks/useTurnChanges', () => ({
  useTurnChanges: () => ({ summary: hooks.summary, loading: false }),
  useTurnDiff: (_sessionId: string, _resultUuid: string, index: number, opts?: { full?: boolean; view?: 'changes' | 'full-file' }) => {
    hooks.diffCalls.push({ index, opts })
    return {
      diff: hooks.diffs[index] ?? null,
      loading: hooks.diffLoading,
    }
  },
}))

import { TurnChangesPanel } from './TurnChangesPanel'

const fileA: TurnChangedFile = { path: 'src/a.ts', display: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 }
const fileB: TurnChangedFile = { path: 'src/b.ts', display: 'src/b.ts', status: 'added', additions: 1, deletions: 0 }

function summaryOf(files: TurnChangedFile[]): TurnChangesSummary {
  return {
    resultUuid: 'r', assistantUuid: 'a', files, total: files.length,
    added: files.reduce((sum, file) => sum + file.additions, 0),
    deleted: files.reduce((sum, file) => sum + file.deletions, 0),
  }
}

const patch = (line: string): TurnDiffPayload => ({
  available: true, patch: `@@ -1 +1 @@\n-old\n+${line}\n`, truncated: false, totalLines: 3,
})

beforeEach(() => {
  hooks.summary = summaryOf([fileA, fileB])
  hooks.diffs = { 0: patch('a'), 1: patch('b') }
  hooks.diffLoading = false
  hooks.diffCalls = []
})

describe('TurnChangesPanel', () => {
  it('defaults to Full file and preserves it while following the file list', () => {
    render(<TurnChangesPanel sessionId="s" resultUuid="r" initialIndex={1} onClose={vi.fn()} />)
    expect(screen.getByText('Turn changes')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Full file' }).getAttribute('aria-pressed')).toBe('true')
    expect(hooks.diffCalls.at(-1)).toEqual({ index: 1, opts: { view: 'full-file', full: true } })
    expect(document.querySelector('.diff-line-add .diff-line-text')?.textContent).toBe('b')

    fireEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }))
    expect(hooks.diffCalls.at(-1)).toEqual({ index: 0, opts: { view: 'full-file', full: true } })
    expect(document.querySelector('.diff-line-add .diff-line-text')?.textContent).toBe('a')
  })

  it('switches to Changes and preserves that view across files', () => {
    render(<TurnChangesPanel sessionId="s" resultUuid="r" initialIndex={0} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /^Changes$/ }))
    expect(screen.getByRole('button', { name: /^Changes$/ }).getAttribute('aria-pressed')).toBe('true')
    expect(hooks.diffCalls.at(-1)).toEqual({ index: 0, opts: { view: 'changes', full: false } })

    fireEvent.click(screen.getByRole('button', { name: /src\/b\.ts/ }))
    expect(hooks.diffCalls.at(-1)).toEqual({ index: 1, opts: { view: 'changes', full: false } })
  })

  it('shows a note for a binary file instead of a diff', () => {
    hooks.summary = summaryOf([{ ...fileA, binary: true, additions: 0, deletions: 0 }])
    hooks.diffs = { 0: { available: true, reason: 'binary' } }
    render(<TurnChangesPanel sessionId="s" resultUuid="r" initialIndex={0} onClose={vi.fn()} />)
    expect(screen.getByText('Binary file')).toBeTruthy()
    expect(document.querySelector('.turn-review-diff-row')).toBeNull()
  })

  it('opens the complete diff from the independent turn diff view', async () => {
    hooks.diffs = { 0: { ...patch('a'), truncated: true, totalLines: 4 } }
    apiMocks.get.mockResolvedValue({
      available: true,
      patch: '@@ -1 +1 @@\n-old\n+full a\n',
      truncated: false,
      totalLines: 3,
    })
    render(<TurnChangesPanel sessionId="s" resultUuid="r" initialIndex={0} onClose={vi.fn()} />)

    expect(screen.queryByRole('button', { name: 'View full diff' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Changes$/ }))
    const showFull = screen.getByRole('button', { name: 'View full diff' })
    expect(showFull.closest('.turn-review-diff-view')).not.toBeNull()
    fireEvent.click(showFull)

    expect((await screen.findByTestId('full-diff-body')).textContent).toContain('+full a')
    expect(apiMocks.get.mock.calls[0]?.[0]).toContain('view=changes&full=1')
  })

  it('shows a loading note instead of a missing comparison while the view loads', () => {
    hooks.diffLoading = true
    render(<TurnChangesPanel sessionId="s" resultUuid="r" initialIndex={0} onClose={vi.fn()} />)
    expect(screen.getByText('Loading comparison…')).toBeTruthy()
    expect(screen.queryByText('No comparison available.')).toBeNull()
  })

  it('closes from the header button', () => {
    const onClose = vi.fn()
    render(<TurnChangesPanel sessionId="s" resultUuid="r" initialIndex={0} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close turn changes' }))
    expect(onClose).toHaveBeenCalled()
  })
})