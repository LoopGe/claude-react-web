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

  it('hides git headers in part mode and separates hunks with a gap', () => {
    const onShowFull = vi.fn()
    const twoHunks = [
      '--- a/sample.ts',
      '+++ b/sample.ts',
      '@@ -1,2 +1,2 @@',
      ' same',
      '-old',
      '+new',
      '@@ -10 +10 @@',
      ' ctx2',
      '+added2',
    ].join('\n')
    render(<TurnDiffView text={twoHunks} view="changes" truncated totalLines={10} onShowFull={onShowFull} />)
    // Git's own headers never render in part mode.
    expect(document.querySelectorAll('.turn-review-diff-row.hunk')).toHaveLength(0)
    expect(document.querySelectorAll('.turn-review-diff-row.meta')).toHaveLength(0)
    // The second hunk opens with a visual gap after the first group.
    expect(document.querySelectorAll('.turn-review-diff-hunk-gap')).toHaveLength(1)
    expect(screen.getByText('added2')).toBeTruthy()
    // Content rows render fewer lines than the patch body carries, but the
    // footer speaks like-for-like with the server's totalLines: all patch
    // lines (headers included), fetched 9 of 10.
    expect(screen.getByText(/showing 9 of 10 lines/)).toBeTruthy()
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

  it('opens on the first modification with three lines of margin, and stays put when nothing changed', () => {
    // jsdom lays out nothing; stub offsetTop so the anchor math is
    // deterministic: the first del row sits at 30px inside the (position:
    // relative) container. jsdom offsetHeight is 0, so the margin falls back
    // to 3 × 1px.
    const topSpy = vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: Element) {
      return this.classList.contains('diff-line-del') ? 30 : 0
    })

    const leading = ['--- a/sample.ts', '+++ b/sample.ts', '@@ -1,3 +1,3 @@', ' same', '-old', '+new'].join('\n')
    const { unmount } = render(<TurnDiffView text={leading} view="changes" truncated={false} totalLines={6} />)
    const view = document.querySelector<HTMLElement>('.turn-review-diff-view')!
    // 30 (anchor offsetTop) − 3 (margin) = 27.
    expect(view.scrollTop).toBe(27)
    unmount()

    // A context-only patch has no row to anchor to — no scroll.
    render(<TurnDiffView text="@@ -1 +1 @@\n same" view="changes" truncated={false} totalLines={1} />)
    expect(document.querySelector<HTMLElement>('.turn-review-diff-view')!.scrollTop).toBe(0)

    topSpy.mockRestore()
  })

  it('extends the render chunk to reach the first modification, capped so huge files keep chunking', () => {
    // First modification at displayRow 6000 — beyond the default 5000 chunk,
    // inside the anchor cap: the limit auto-extends so the anchor renders.
    const deep = ['@@ -1,6001 +1,6001 @@',
      ...Array.from({ length: 6000 }, (_, i) => ` pad ${i + 1}`),
      '+deep change',
    ].join('\n')
    render(<TurnDiffView text={deep} view="full-file" truncated={false} totalLines={6002} />)
    expect(document.querySelectorAll('.diff-line')).toHaveLength(6001)
    expect(screen.getByText('deep change')).toBeTruthy()

    // First modification at 20001 — beyond ANCHOR_RENDER_CAP: no extension,
    // the default chunk stands and the anchor is skipped.
    const capped = ['@@ -1,20002 +1,20002 @@',
      ...Array.from({ length: 20001 }, (_, i) => ` pad ${i + 1}`),
      '+out of reach',
    ].join('\n')
    render(<TurnDiffView text={capped} view="full-file" truncated={false} totalLines={20003} />)
    expect(document.querySelectorAll('.diff-line')).toHaveLength(5000 + 6001) // 5000 fresh + 6001 still mounted
    expect(screen.queryByText('out of reach')).toBeNull()
    expect(screen.getByRole('button', { name: /lines remaining/ })).toBeTruthy()
  }, 30_000)

  it('progressively renders files beyond 5000 rows', () => {
    const patch = Array.from({ length: 5001 }, (_, i) => ` line ${i + 1}`).join('\n')
    render(<TurnDiffView text={patch} view="full-file" truncated={false} totalLines={5001} />)
    expect(document.querySelectorAll('.diff-line')).toHaveLength(5000)
    fireEvent.click(screen.getByRole('button', { name: 'Show more (1 lines remaining)' }))
    expect(document.querySelectorAll('.diff-line')).toHaveLength(5001)
    expect(screen.getByText('line 5001')).toBeTruthy()
  }, 15_000)
})
