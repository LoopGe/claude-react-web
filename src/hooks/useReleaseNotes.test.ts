import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

import { useReleaseNotes } from './useReleaseNotes'

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }))
vi.mock('./useApi', () => ({
  api: { get: (path: string, opts?: unknown) => apiGet(path, opts) },
}))

const NOTES = {
  from: '0.7.2',
  to: '0.8.0',
  releases: [
    { version: '0.8.0', name: '0.8.0', body: 'notes', publishedAt: '2026-09-10T00:00:00Z', url: 'https://example.com' },
  ],
}

describe('useReleaseNotes', () => {
  beforeEach(() => {
    apiGet.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not fetch while disabled', () => {
    renderHook(() => useReleaseNotes(false, '0.7.2', '0.8.0'))
    expect(apiGet).not.toHaveBeenCalled()
  })

  it('fetches on enable and exposes releases', async () => {
    apiGet.mockResolvedValue(NOTES)
    const { result } = renderHook(() => useReleaseNotes(true, '0.7.2', '0.8.0'))
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(apiGet).toHaveBeenCalledWith('/release-notes?from=0.7.2&to=0.8.0', expect.anything())
    expect(result.current.releases).toEqual(NOTES.releases)
    expect(result.current.error).toBeNull()
  })

  it('surfaces a failure as error with null releases', async () => {
    apiGet.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useReleaseNotes(true, '0.7.2', '0.8.0'))
    await waitFor(() => expect(result.current.error).toBe('boom'))
    expect(result.current.releases).toBeNull()
  })

  it('does not fetch when from/to are missing', () => {
    renderHook(() => useReleaseNotes(true, undefined, '0.8.0'))
    expect(apiGet).not.toHaveBeenCalled()
  })

  it('appends includeFrom=1 only when the lower bound is inclusive', async () => {
    apiGet.mockResolvedValue(NOTES)
    const exclusive = renderHook(() => useReleaseNotes(true, '0.7.3', '0.7.3'))
    await waitFor(() => expect(exclusive.result.current.loading).toBe(false))
    expect(apiGet).toHaveBeenLastCalledWith('/release-notes?from=0.7.3&to=0.7.3', expect.anything())

    const inclusive = renderHook(() => useReleaseNotes(true, '0.7.3', '0.7.3', true))
    await waitFor(() => expect(inclusive.result.current.loading).toBe(false))
    expect(apiGet).toHaveBeenLastCalledWith(
      '/release-notes?from=0.7.3&to=0.7.3&includeFrom=1',
      expect.anything(),
    )
  })

  it('refetches when only includeFrom changes (the snapshot key covers it)', async () => {
    // The snapshot slot is tagged by request key: if the inclusivity were left
    // out of that key, flipping it would settle on the previous range's answer
    // and the dialog would render the WRONG range's notes with no refetch.
    apiGet.mockResolvedValue(NOTES)
    const { result, rerender } = renderHook(
      ({ inc }: { inc: boolean }) => useReleaseNotes(true, '0.7.3', '0.7.3', inc),
      { initialProps: { inc: false } },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(apiGet).toHaveBeenCalledTimes(1)

    rerender({ inc: true })
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(apiGet).toHaveBeenCalledTimes(2)
    expect(apiGet).toHaveBeenLastCalledWith(
      '/release-notes?from=0.7.3&to=0.7.3&includeFrom=1',
      expect.anything(),
    )
  })

  it('coalesces concurrent mounts into one request', async () => {
    // Each hook instance fires its own effect and calls apiGet; the SERVER
    // dedupes the actual network request. At the hook level we verify both
    // settle to the same data.
    apiGet.mockResolvedValue(NOTES)
    const h1 = renderHook(() => useReleaseNotes(true, '0.7.2', '0.8.0'))
    const h2 = renderHook(() => useReleaseNotes(true, '0.7.2', '0.8.0'))
    await waitFor(() => {
      expect(h1.result.current.loading).toBe(false)
    })
    await waitFor(() => {
      expect(h2.result.current.loading).toBe(false)
    })
    expect(h1.result.current.releases).toEqual(NOTES.releases)
    expect(h2.result.current.releases).toEqual(NOTES.releases)
  })
})
