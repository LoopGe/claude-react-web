// Unit tests for useOpenPathApps — the per-page-load availability probe for
// the brand "Open in …" targets (GET /open-path/apps). Mirrors the caching
// contract of useOpenPathCapability: one fetch per page, a failed probe is
// NOT cached (next mount retries), and the value is rendered into the DOM by
// the probe component to respect render purity.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))

vi.mock('../hooks/useApi', () => ({ api: { get: getMock, post: vi.fn() } }))

const { useOpenPathApps, __resetOpenPathAppsForTest } = await import('./useOpenPathApps')

function Probe() {
  const apps = useOpenPathApps()
  return <div data-testid="apps">{apps === null ? 'pending' : apps.join(',')}</div>
}

function appsText(): string {
  return document.querySelector('[data-testid="apps"]')!.textContent
}

beforeEach(() => {
  getMock.mockClear()
  __resetOpenPathAppsForTest()
})

describe('useOpenPathApps', () => {
  it('returns null while the probe is in flight, then the server answer', async () => {
    let resolve!: (v: { apps: string[] }) => void
    getMock.mockImplementation(() => new Promise((r) => (resolve = r)))
    render(<Probe />)
    expect(appsText()).toBe('pending')
    resolve({ apps: ['vscode', 'zed'] })
    await waitFor(() => expect(appsText()).toBe('vscode,zed'))
    cleanup()
  })

  it('caches one probe for the page lifetime (second mount does not refetch)', async () => {
    getMock.mockResolvedValue({ apps: [] })
    render(<Probe />)
    await waitFor(() => expect(appsText()).toBe(''))
    expect(getMock).toHaveBeenCalledTimes(1)
    cleanup()
    render(<Probe />)
    expect(getMock).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('maps a failed probe to "nothing available" but retries on the next mount', async () => {
    getMock.mockRejectedValueOnce(new Error('network down'))
    render(<Probe />)
    await waitFor(() => expect(appsText()).toBe(''))
    expect(getMock).toHaveBeenCalledTimes(1)
    cleanup()
    getMock.mockResolvedValue({ apps: ['vscode'] })
    render(<Probe />)
    await waitFor(() => expect(appsText()).toBe('vscode'))
    expect(getMock).toHaveBeenCalledTimes(2)
  })

  it('drops non-string entries the server answer may carry', async () => {
    getMock.mockResolvedValue({ apps: ['vscode', 42, null, 'zed'] })
    render(<Probe />)
    await waitFor(() => expect(appsText()).toBe('vscode,zed'))
    cleanup()
  })

  it('treats a malformed answer like a failure: empty now, retried on next mount', async () => {
    // A 200 with a reshaped body (proxy error page, mid-restart server) must
    // not cache [] as the page-lifetime answer — only a well-formed answer
    // persists, mirroring the transport-failure retry semantics.
    getMock.mockResolvedValueOnce({ apps: 'not-an-array' })
    render(<Probe />)
    await waitFor(() => expect(appsText()).toBe(''))
    expect(getMock).toHaveBeenCalledTimes(1)
    cleanup()
    getMock.mockResolvedValue({ apps: ['vscode'] })
    render(<Probe />)
    await waitFor(() => expect(appsText()).toBe('vscode'))
    expect(getMock).toHaveBeenCalledTimes(2)
  })
})
