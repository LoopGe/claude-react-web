// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DiffView } from './DiffView'

// DiffView mounts useOverlayScrollbar (MutationObserver + rAF). happy-dom
// provides both; nothing else needs stubbing here.

afterEach(cleanup)

const TEXT = 'diff --git a/f b/f\n@@ -1 +1 @@\n-x\n+y\n'

describe('DiffView', () => {
  it('offers a View full diff action on the truncation marker and forwards the click', () => {
    const onShowFull = vi.fn()
    render(<DiffView text={TEXT} truncated totalLines={900} onShowFull={onShowFull} />)
    fireEvent.click(screen.getByRole('button', { name: /view full diff/i }))
    expect(onShowFull).toHaveBeenCalledTimes(1)
  })

  it('renders no full-diff action when the body is complete', () => {
    render(<DiffView text={TEXT} truncated={false} totalLines={4} onShowFull={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /view full diff/i })).toBeNull()
  })

  it('renders no full-diff action when no handler is wired', () => {
    render(<DiffView text={TEXT} truncated totalLines={900} />)
    expect(screen.queryByRole('button', { name: /view full diff/i })).toBeNull()
  })
})
