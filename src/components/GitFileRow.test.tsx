import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { GitFileRow } from './GitFileRow'

vi.stubGlobal('matchMedia', () => ({
  matches: false,
  media: '',
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
}))

const PATH = 'src/components/some/deeply/nested/file.tsx'

function renderRow(overrides: Partial<React.ComponentProps<typeof GitFileRow>> = {}) {
  return render(
    <GitFileRow
      status="M"
      path={PATH}
      insertions={1}
      deletions={0}
      fetchStarted={false}
      onFetchStart={vi.fn()}
      onFetchReset={vi.fn()}
      diff={{ data: null, loading: false, error: null }}
      fetchFullText={vi.fn().mockResolvedValue('')}
      {...overrides}
    />,
  )
}

describe('GitFileRow path hover', () => {
  it('shows the full path on hover and drops the native title', () => {
    vi.useFakeTimers()
    try {
      const { container } = renderRow()
      const toggle = container.querySelector('.git-file-row-toggle') as HTMLElement
      expect(toggle.getAttribute('title')).toBeNull()
      fireEvent.pointerEnter(toggle)
      act(() => {
        vi.advanceTimersByTime(200)
      })
      const pop = document.querySelector('.hover-pop')
      expect(pop?.getAttribute('role')).toBe('tooltip')
      expect(pop?.textContent).toContain(PATH)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the rename source and destination together', () => {
    vi.useFakeTimers()
    try {
      const { container } = renderRow({ renamedFrom: 'src/old-name.tsx' })
      const toggle = container.querySelector('.git-file-row-toggle') as HTMLElement
      fireEvent.pointerEnter(toggle)
      act(() => {
        vi.advanceTimersByTime(200)
      })
      expect(document.querySelector('.hover-pop')?.textContent).toContain(
        `src/old-name.tsx → ${PATH}`,
      )
    } finally {
      vi.useRealTimers()
    }
  })
})