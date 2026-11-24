import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { UpdateInfo } from '../../shared/update-info'

const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('./useApi', () => ({
  api: { get: (...a: unknown[]) => mocks.get(...a), post: vi.fn() },
}))

// WS hub mock: capture the global listener so tests can emit frames.
let listener: ((frame: unknown) => void) | null = null
let hubPresent = true
vi.mock('./useWsHub', () => ({
  useOptionalWsHub: () =>
    hubPresent
      ? {
          addListener: (fn: (frame: unknown) => void) => {
            listener = fn
            return () => { listener = null }
          },
        }
      : null,
}))

import { useUpdateInfo } from './useUpdateInfo'

const BASE: UpdateInfo = {
  current: '1.0.0',
  packageName: 'claude-react-web',
  installMethod: 'global',
  hasUpdate: false,
  source: 'npm',
}
const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({ ...BASE, ...over })

const OVERLAYS = {
  repoUrl: 'https://github.com/LoopGe/claude-react-web',
  claudeCli: { ok: true, version: '2.1.311' },
  agentSdk: { version: '0.3.311' },
} as const

const emitFrame = (frameInfo: UpdateInfo) => {
  act(() => { listener?.({ kind: 'update-info', info: frameInfo }) })
}

beforeEach(() => {
  mocks.get.mockReset()
  listener = null
  hubPresent = true
})

describe('useUpdateInfo — live update-info frames', () => {
  it('a frame with a newer latest updates info without a fetch', async () => {
    mocks.get.mockResolvedValue(info({ latest: '1.1.0', hasUpdate: true, checkedAt: 100 }))
    const { result } = renderHook(() => useUpdateInfo(true))
    await waitFor(() => expect(result.current.info?.latest).toBe('1.1.0'))
    const callsAfterMount = mocks.get.mock.calls.length

    emitFrame(info({ latest: '1.2.0', hasUpdate: true, checkedAt: 200 }))
    expect(result.current.info?.latest).toBe('1.2.0')
    expect(mocks.get.mock.calls.length).toBe(callsAfterMount)
    cleanup()
  })

  it('a frame preserves the GET-set overlays', async () => {
    mocks.get.mockResolvedValue(info({ latest: '1.1.0', checkedAt: 100, ...OVERLAYS }))
    const { result } = renderHook(() => useUpdateInfo(true))
    await waitFor(() => expect(result.current.info?.latest).toBe('1.1.0'))

    emitFrame(info({ latest: '1.2.0', checkedAt: 200 }))
    expect(result.current.info?.repoUrl).toBe(OVERLAYS.repoUrl)
    expect(result.current.info?.claudeCli).toEqual(OVERLAYS.claudeCli)
    expect(result.current.info?.agentSdk).toEqual(OVERLAYS.agentSdk)
    cleanup()
  })

  it('a late GET with an older checkedAt does not regress latest', async () => {
    mocks.get.mockImplementation(async (path: string) =>
      path.includes('force=1')
        ? info({ latest: '1.1.0', hasUpdate: true, checkedAt: 200, ...OVERLAYS })
        : info({ latest: '1.2.0', hasUpdate: true, checkedAt: 300 }),
    )
    const { result } = renderHook(() => useUpdateInfo(true))
    await waitFor(() => expect(result.current.info?.latest).toBe('1.2.0'))

    act(() => { result.current.refresh() })
    await waitFor(() => expect(result.current.refreshing).toBe(false))
    expect(result.current.info?.latest).toBe('1.2.0') // fenced
    expect(result.current.info?.repoUrl).toBe(OVERLAYS.repoUrl) // overlays still merged
    cleanup()
  })

  it('unregisters the listener on unmount', async () => {
    mocks.get.mockResolvedValue(info())
    const { unmount } = renderHook(() => useUpdateInfo(true))
    await waitFor(() => expect(listener).not.toBeNull())
    unmount()
    expect(listener).toBeNull()
    cleanup()
  })

  it('works over REST alone when no hub is mounted', async () => {
    hubPresent = false
    mocks.get.mockResolvedValue(info({ latest: '1.1.0', checkedAt: 100 }))
    const { result } = renderHook(() => useUpdateInfo(true))
    await waitFor(() => expect(result.current.info?.latest).toBe('1.1.0'))
    cleanup()
  })

  it('does not subscribe while disabled — the first-run wizard sees no frames', async () => {
    mocks.get.mockResolvedValue(info({ latest: '1.1.0', checkedAt: 100 }))
    const { result, rerender } = renderHook(({ enabled }) => useUpdateInfo(enabled), {
      initialProps: { enabled: false },
    })
    // No listener while disabled: the always-on seed frame must not set info
    // (and arm the nag) over the setup wizard.
    expect(listener).toBeNull()
    expect(result.current.info).toBeNull()
    expect(mocks.get).not.toHaveBeenCalled()

    rerender({ enabled: true })
    await waitFor(() => expect(listener).not.toBeNull())
    emitFrame(info({ latest: '1.2.0', checkedAt: 200 }))
    expect(result.current.info?.latest).toBe('1.2.0')
    cleanup()
  })
})