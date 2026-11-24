// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ToastProvider } from '../components/ToastProvider'
import { useToastList } from './useToast'
import {
  nagDismissValueFor,
  nagValueForDeprecated,
  nagValueForUpdate,
  readNagDismiss,
  writeNagDismiss,
  useUpdateNag,
  type UpdateNagMode,
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

// renderHook's callback has to be a top-level use* function, passed as the hook
// itself: useHarness is a custom hook, and inside one the rule treats an inline
// arrow as a plain callback and reports every hook the arrow calls.
function useNagHarness({
  info,
  onOpenDialog,
}: {
  info: UpdateInfo | null
  onOpenDialog: (mode: UpdateNagMode) => void
}) {
  useUpdateNag(info, onOpenDialog)
  return useToastList()
}

function useHarness(info: UpdateInfo | null, onOpenDialog = vi.fn()) {
  const nag = renderHook(useNagHarness, { wrapper, initialProps: { info, onOpenDialog } })
  return { ...nag, onOpenDialog }
}

describe('useUpdateNag', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('pushes a sticky three-action toast with no dismiss icon', () => {
    const { result } = useHarness(baseInfo())
    expect(result.current).toHaveLength(1)
    const t = result.current[0]
    expect(t.title).toBe('New version available')
    expect(t.message).toContain('0.7.2')
    expect(t.message).toContain('0.8.0')
    expect(t.actions?.map((a) => a.label)).toEqual(['Update', 'Remind me later', 'Skip this version'])
    expect(t.hideDismiss).toBe(true)
    expect(t.onDismiss).toBeUndefined() // no hidden skip-write behind a close
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
    const first = vi.fn()
    const { result, rerender } = useHarness(baseInfo(), first)
    expect(result.current).toHaveLength(1)
    // A new info object with the same version, plus a fresh callback identity —
    // what an inline arrow from the caller amounts to.
    const second = vi.fn()
    rerender({ info: baseInfo({ latest: '0.8.0' }), onOpenDialog: second })
    expect(result.current).toHaveLength(1)
    // The toast still on screen was pushed by the FIRST render; its action must
    // call the LATEST opener — that is what the synced ref is for.
    act(() => {
      result.current[0].actions?.[0].onClick()
    })
    expect(second).toHaveBeenCalledWith('update')
    expect(first).not.toHaveBeenCalled()
  })

  it('Update opens the dialog and writes NOTHING', () => {
    const onOpenDialog = vi.fn()
    const { result } = useHarness(baseInfo(), onOpenDialog)
    act(() => {
      result.current[0].actions?.[0].onClick()
    })
    expect(onOpenDialog).toHaveBeenCalledWith('update')
    expect(readNagDismiss()).toBeNull()
  })

  it('Remind me later closes the reminder and writes NOTHING', () => {
    const { result } = useHarness(baseInfo())
    act(() => {
      result.current[0].actions?.[1].onClick()
    })
    expect(readNagDismiss()).toBeNull()
  })

  it('Skip this version persists the dismiss key', () => {
    const { result } = useHarness(baseInfo())
    act(() => {
      result.current[0].actions?.[2].onClick()
    })
    expect(readNagDismiss()).toBe('0.8.0')
  })

  it('a remount after Remind me later re-nags the same version', () => {
    const first = useHarness(baseInfo())
    act(() => {
      first.result.current[0].actions?.[1].onClick()
    })
    first.unmount()
    // No persistent record was written — a fresh mount (reload / new tab)
    // offers the version again. That is the whole "later" mechanism.
    const second = useHarness(baseInfo())
    expect(second.result.current).toHaveLength(1)
  })

  it('deprecation nag: Skip persists the sentinel, Update writes nothing', () => {
    const onOpenDialog = vi.fn()
    const { result } = useHarness(
      baseInfo({ latest: undefined, hasUpdate: false, deprecated: 'Use 0.9.' }),
      onOpenDialog,
    )
    expect(result.current).toHaveLength(1)
    expect(result.current[0].title).toBe('Version 0.7.2 is deprecated')
    expect(result.current[0].message).toBe('Use 0.9.')
    act(() => {
      result.current[0].actions?.[0].onClick()
    })
    expect(onOpenDialog).toHaveBeenCalledWith('deprecation')
    expect(readNagDismiss()).toBeNull()
    act(() => {
      result.current[0].actions?.[2].onClick()
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

// The dialog's close handler asks this for the value to persist. The behaviour
// it protects is subtle and one-directional: writing a key for a NON-nag mode
// suppresses a real notification later, so the read-only About viewer must
// return null rather than fall through to the deprecation sentinel.
describe('nagDismissValueFor', () => {
  it('returns null for the read-only current viewer', () => {
    expect(nagDismissValueFor('current', baseInfo())).toBeNull()
  })

  it('returns null for any mode that is not a nag', () => {
    expect(nagDismissValueFor('something-new', baseInfo())).toBeNull()
  })

  it('keys the update branch by the offered latest', () => {
    expect(nagDismissValueFor('update', baseInfo({ latest: '0.8.0' })))
      .toBe(nagValueForUpdate('0.8.0'))
  })

  it('falls back to the deprecation sentinel when update has no latest to key on', () => {
    expect(nagDismissValueFor('update', baseInfo({ latest: undefined })))
      .toBe(nagValueForDeprecated('0.7.2'))
  })

  it('keys the deprecation branch by the running version', () => {
    expect(nagDismissValueFor('deprecation', baseInfo({ deprecated: 'old' })))
      .toBe(nagValueForDeprecated('0.7.2'))
  })
})
