// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ToastProvider } from '../components/ToastProvider'
import { useToastList } from './useToast'
import {
  NAG_DISMISS_STORAGE_KEY,
  nagValueForUpdate,
  readNagDismiss,
  writeNagDismiss,
  useUpdateNag,
} from './useUpdateNag'
import type { UpdateInfo } from '../../shared/update-info'

function wrapper({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>
}

function baseInfo(over: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    current: '0.7.2',
    packageName: 'claude-react-web',
    installMethod: 'global',
    latest: '0.8.0',
    hasUpdate: true,
    updateAppliedToDisk: false,
    source: 'npm',
    checkedAt: 1,
    ...over,
  }
}

function useHarness(info: UpdateInfo | null, onOpenDialog = vi.fn()) {
  const nag = renderHook(() => {
    useUpdateNag(info, onOpenDialog)
    return useToastList()
  }, { wrapper })
  return { ...nag, onOpenDialog }
}

describe('useUpdateNag', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('pushes a sticky update toast when a newer version exists', () => {
    const { result } = useHarness(baseInfo())
    expect(result.current).toHaveLength(1)
    const t = result.current[0]
    expect(t.title).toBe('New version available')
    expect(t.message).toContain('0.7.2')
    expect(t.message).toContain('0.8.0')
    expect(t.actionLabel).toBe('Update')
    expect(t.durationMs).toBe(0) // sticky
  })

  it('does not push when isUpdateNagNeeded is false (update on disk)', () => {
    const { result } = useHarness(baseInfo({ updateAppliedToDisk: true }))
    expect(result.current).toHaveLength(0)
  })

  it('does not push while checking', () => {
    const { result } = useHarness(baseInfo({ checking: true }))
    expect(result.current).toHaveLength(0)
  })

  it('does not push when the version was already dismissed', () => {
    writeNagDismiss(nagValueForUpdate('0.8.0'))
    const { result } = useHarness(baseInfo())
    expect(result.current).toHaveLength(0)
  })

  it('re-notifies when a newer latest appears', () => {
    writeNagDismiss(nagValueForUpdate('0.8.0'))
    const { result } = useHarness(baseInfo({ latest: '0.9.0' }))
    expect(result.current).toHaveLength(1)
    expect(result.current[0].message).toContain('0.9.0')
  })

  it('does not re-push on an info identity change with the same values', () => {
    const { result, rerender } = renderHook(
      ({ info }: { info: UpdateInfo }) => {
        useUpdateNag(info, vi.fn())
        return useToastList()
      },
      { wrapper, initialProps: { info: baseInfo() } },
    )
    expect(result.current).toHaveLength(1)
    rerender({ info: baseInfo({ latest: '0.8.0' }) }) // new object, same version
    expect(result.current).toHaveLength(1)
  })

  it('action click opens the dialog and dismissal persists the key', () => {
    const onOpenDialog = vi.fn()
    const { result } = useHarness(baseInfo(), onOpenDialog)
    const t = result.current[0]
    act(() => {
      t.onClick?.()
    })
    expect(onOpenDialog).toHaveBeenCalledWith('update')
    // The provider auto-dismisses after an action click -> onDismiss fires ->
    // key persisted.
    expect(readNagDismiss()).toBe('0.8.0')
  })

  it('toast x (dismiss) persists the key', () => {
    const { result } = useHarness(baseInfo())
    const t = result.current[0]
    act(() => {
      t.onDismiss?.() // simulate the provider firing the callback on x
    })
    expect(readNagDismiss()).toBe('0.8.0')
  })

  it('deprecation nag uses the deprecated sentinel and copy', () => {
    const { result } = useHarness(
      baseInfo({ latest: undefined, hasUpdate: false, deprecated: 'Use 0.9.' }),
    )
    expect(result.current).toHaveLength(1)
    expect(result.current[0].title).toBe('Version 0.7.2 is deprecated')
    expect(result.current[0].message).toBe('Use 0.9.')
    act(() => {
      result.current[0].onClick?.()
    })
    expect(readNagDismiss()).toBe('deprecated:0.7.2')
  })

  it('update nag wins when both update and deprecation apply', () => {
    const { result } = useHarness(
      baseInfo({ deprecated: 'old' }), // latest 0.8.0 > current -> update branch first
    )
    expect(result.current).toHaveLength(1)
    expect(result.current[0].title).toBe('New version available')
  })
})
