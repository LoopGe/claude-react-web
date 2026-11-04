import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { TurnChangedFile, TurnChangesSummary, TurnDiffPayload } from '../../shared/turn-changes.js'

const hooks = vi.hoisted(() => ({
  summary: null as TurnChangesSummary | null,
  diffs: {} as Record<number, TurnDiffPayload | null>,
}))
vi.mock('../hooks/useTurnChanges', () => ({
  useTurnChanges: () => ({ summary: hooks.summary, loading: false }),
  useTurnDiff: (_sessionId: string, _resultUuid: string, index: number) => ({
    diff: hooks.diffs[index] ?? null,
    loading: false,
  }),
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
})

describe('TurnChangesPanel', () => {
  it('starts on the requested file and follows the file list', () => {
    render(<TurnChangesPanel sessionId="s" resultUuid="r" initialIndex={1} onClose={vi.fn()} />)
    expect(screen.getByText('Turn changes')).toBeTruthy()
    expect(document.querySelector('.git-diff-row.add .git-diff-body')?.textContent).toBe('b')

    fireEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }))
    expect(document.querySelector('.git-diff-row.add .git-diff-body')?.textContent).toBe('a')
  })

  it('shows a note for a binary file instead of a diff', () => {
    hooks.summary = summaryOf([{ ...fileA, binary: true, additions: 0, deletions: 0 }])
    hooks.diffs = { 0: { available: true, reason: 'binary' } }
    render(<TurnChangesPanel sessionId="s" resultUuid="r" initialIndex={0} onClose={vi.fn()} />)
    expect(screen.getByText('Binary file')).toBeTruthy()
    expect(document.querySelector('.git-diff-row')).toBeNull()
  })

  it('closes from the header button', () => {
    const onClose = vi.fn()
    render(<TurnChangesPanel sessionId="s" resultUuid="r" initialIndex={0} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close turn changes' }))
    expect(onClose).toHaveBeenCalled()
  })
})