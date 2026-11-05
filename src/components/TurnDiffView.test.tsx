import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TurnDiffView } from './TurnDiffView'

const dualPatch = [
  '--- a/sample.ts',
  '+++ b/sample.ts',
  '@@ -1,2 +1,2 @@',
  ' same',
  '-old',
  '+new',
].join('\n')

describe('TurnDiffView', () => {
  it('renders Edit-style dual gutters and hides patch headers in full-file mode', () => {
    render(<TurnDiffView text={dualPatch} view="full-file" truncated={false} totalLines={5} />)

    expect(document.querySelector('.turn-review-diff-row.hunk')).toBeNull()
    expect(document.querySelector('.turn-review-diff-row.meta')).toBeNull()
    const context = document.querySelector('.diff-line-ctx')!
    expect(context.querySelector('.diff-line-gutter-old')?.textContent).toBe('1')
    expect(context.querySelector('.diff-line-gutter-new')?.textContent).toBe('1')

    const deleted = document.querySelector('.diff-line-del')!
    expect(deleted.querySelector('.diff-line-gutter-old')?.textContent).toBe('2')
    expect(deleted.querySelector('.diff-line-gutter-new')?.textContent).toBe('')
    expect(deleted.querySelector('.diff-line-marker')?.textContent).toBe('-')

    const added = document.querySelector('.diff-line-add')!
    expect(added.querySelector('.diff-line-gutter-old')?.textContent).toBe('')
    expect(added.querySelector('.diff-line-gutter-new')?.textContent).toBe('2')
    expect(added.querySelector('.diff-line-marker')?.textContent).toBe('+')
  })

  it('keeps hunk headers and the complete-diff action in changes mode', () => {
    const onShowFull = vi.fn()
    render(<TurnDiffView text={dualPatch} view="changes" truncated totalLines={8} onShowFull={onShowFull} />)
    expect(document.querySelectorAll('.turn-review-diff-row.hunk')).toHaveLength(1)
    expect(document.querySelectorAll('.turn-review-diff-row.meta')).toHaveLength(2)
    expect(screen.getByText(/showing 6 of 8 lines/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View full diff' }))
    expect(onShowFull).toHaveBeenCalledOnce()
  })

  it('retains aligned blank gutters and sizes each column independently', () => {
    const additions = Array.from({ length: 10 }, (_, i) => `+line ${i + 1}`).join('\n')
    render(<TurnDiffView text={`@@ -1,0 +1,10 @@\n${additions}`} view="full-file" truncated={false} totalLines={11} />)
    const first = document.querySelector('.diff-line-add')!
    const oldGutter = first.querySelector<HTMLElement>('.diff-line-gutter-old')!
    const newGutter = first.querySelector<HTMLElement>('.diff-line-gutter-new')!
    expect(oldGutter.textContent).toBe('')
    expect(oldGutter.style.minWidth).toBe('1ch')
    expect(newGutter.style.minWidth).toBe('2ch')
  })

  it('progressively renders files beyond 5000 rows', () => {
    const patch = Array.from({ length: 5001 }, (_, i) => ` line ${i + 1}`).join('\n')
    render(<TurnDiffView text={patch} view="full-file" truncated={false} totalLines={5001} />)
    expect(document.querySelectorAll('.diff-line')).toHaveLength(5000)
    fireEvent.click(screen.getByRole('button', { name: 'Show more (1 lines remaining)' }))
    expect(document.querySelectorAll('.diff-line')).toHaveLength(5001)
    expect(screen.getByText('line 5001')).toBeTruthy()
  }, 15_000)
})
