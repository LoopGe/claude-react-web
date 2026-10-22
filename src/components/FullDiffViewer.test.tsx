// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FullDiffViewer, FULL_DIFF_CHUNK_CHARS } from './FullDiffViewer'

// Overlay pulls useExitPresence/prefersReducedMotion → matchMedia, which
// happy-dom lacks. Same stub Overlay.test.tsx uses.

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('FullDiffViewer', () => {
  it('renders the fetched body and reveals it in chunks on demand', async () => {
    // Three chunks' worth of distinct markers so we can see which are shown.
    const body =
      'CHUNK1-'.padEnd(FULL_DIFF_CHUNK_CHARS, '1') +
      'CHUNK2-'.padEnd(FULL_DIFF_CHUNK_CHARS, '2') +
      'CHUNK3-END'
    render(
      <FullDiffViewer open onClose={vi.fn()} name="big.diff" fetchText={() => Promise.resolve(body)} />,
    )
    await screen.findByText(/chunk1/i)
    const pre = () => screen.getByTestId('full-diff-body').textContent ?? ''
    expect(pre()).toContain('CHUNK1-')
    expect(pre()).not.toContain('CHUNK2-')
    expect(pre()).not.toContain('CHUNK3-END')

    fireEvent.click(screen.getByRole('button', { name: /show more/i }))
    await waitFor(() => expect(pre()).toContain('CHUNK2-'))
    expect(pre()).not.toContain('CHUNK3-END')

    fireEvent.click(screen.getByRole('button', { name: /show more/i }))
    await waitFor(() => expect(pre()).toContain('CHUNK3-END'))
    expect(screen.queryByRole('button', { name: /show more/i })).toBeNull()
  })

  it('surfaces a fetch failure instead of an empty view', async () => {
    render(
      <FullDiffViewer
        open
        onClose={vi.fn()}
        name="big.diff"
        fetchText={() => Promise.reject(new Error('boom'))}
      />,
    )
    await screen.findByText(/boom/)
  })
})
