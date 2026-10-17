// Unit tests for useOpenPathCapability — the per-page-load probe that tells
// the project popover whether this browser sits on the machine running the
// server (only then do the Reveal-in-Finder / Open-in-Terminal buttons make
// sense; see server/routes/open-path.ts for the server-side gate).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))

vi.mock('../hooks/useApi', () => ({ api: { get: getMock, post: vi.fn() } }))

const { useOpenPathCapability, __resetOpenPathCapabilityForTest } = await import(
  './useOpenPathCapability'
)

/** The hook's value is rendered into the DOM (an outer-variable assignment
 *  during render would violate the react-hooks purity rules the repo lints
 *  on): 'pending' → probe in flight, 'local' / 'remote' → settled. */
function Probe() {
  const local = useOpenPathCapability()
  return <div data-testid="cap">{local === null ? 'pending' : local ? 'local' : 'remote'}</div>
}

function capText(): string {
  return document.querySelector('[data-testid="cap"]')!.textContent
}

beforeEach(() => {
  getMock.mockClear()
  __resetOpenPathCapabilityForTest()
})

describe('useOpenPathCapability', () => {
  it('returns null while the probe is in flight, then the server answer', async () => {
    let resolve!: (v: { local: boolean }) => void
    getMock.mockImplementation(() => new Promise((r) => (resolve = r)))
    render(<Probe />)
    expect(capText()).toBe('pending')
    resolve({ local: true })
    await waitFor(() => expect(capText()).toBe('local'))
    cleanup()
  })

  it('caches one probe for the page lifetime (second mount does not refetch)', async () => {
    getMock.mockResolvedValue({ local: false })
    render(<Probe />)
    await waitFor(() => expect(capText()).toBe('remote'))
    expect(getMock).toHaveBeenCalledTimes(1)
    cleanup()
    render(<Probe />)
    expect(getMock).toHaveBeenCalledTimes(1)
    expect(capText()).toBe('remote')
    cleanup()
  })

  it('maps a failed probe to false (buttons hidden) but retries on the next mount', async () => {
    getMock.mockRejectedValueOnce(new Error('network down'))
    render(<Probe />)
    await waitFor(() => expect(capText()).toBe('remote'))
    expect(getMock).toHaveBeenCalledTimes(1)
    cleanup()
    // Next mount probes again — the failure was NOT cached.
    getMock.mockResolvedValue({ local: true })
    render(<Probe />)
    await waitFor(() => expect(capText()).toBe('local'))
    expect(getMock).toHaveBeenCalledTimes(2)
  })
})
