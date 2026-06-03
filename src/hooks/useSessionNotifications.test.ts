// Verifies the three-state dispatch in useSessionNotifications:
//   - skip    → window focused AND looking at this session: nothing fires.
//   - toast   → window focused, looking elsewhere: in-app toast fires,
//               desktop notify does NOT.
//   - desktop → window not focused: desktop notify fires, toast does NOT.
// Both `maybeNotify` (turn complete) and `maybePermissionNotify` are covered.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { RefObject } from 'react'
import type { SessionInfo } from '../types'

// --- Mocks for the two surfaces the hook dispatches to ------------------
const notify = vi.fn()
vi.mock('./useNotifications', () => ({
  useNotifications: () => ({
    enabled: true,
    permission: 'granted',
    toggle: vi.fn(),
    notify,
  }),
}))

const toastInfo = vi.fn()
const toastError = vi.fn()
vi.mock('./useToast', () => ({
  useToast: () => ({
    info: toastInfo,
    error: toastError,
    success: vi.fn(),
    show: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

// Import AFTER the mocks so the hook picks up the mocked modules.
import { useSessionNotifications } from './useSessionNotifications'

function ref<T>(value: T): RefObject<T> {
  return { current: value }
}

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return { id: 's1', title: 'Session One', working: false, ...overrides } as SessionInfo
}

function setFocus(windowFocused: boolean) {
  vi.spyOn(document, 'hasFocus').mockReturnValue(windowFocused)
}

function setup(focusedId: string | null) {
  const handleSelect = vi.fn()
  const { result } = renderHook(() =>
    useSessionNotifications({
      focusedIdRef: ref<string | null>(focusedId),
      sessionsRef: ref<SessionInfo[]>([makeSession()]),
      handleSelectRef: ref(handleSelect),
    }),
  )
  return { api: result.current, handleSelect }
}

describe('useSessionNotifications — three-state dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('maybeNotify (turn complete)', () => {
    it('skips entirely when window focused AND watching this session', () => {
      setFocus(true)
      const { api } = setup('s1')
      api.seedWorkingState('s1', true) // arm the falling edge
      api.maybeNotify(makeSession({ working: false }))
      expect(notify).not.toHaveBeenCalled()
      expect(toastInfo).not.toHaveBeenCalled()
    })

    it('fires an in-app toast (not desktop) when focused on a different session', () => {
      setFocus(true)
      const { api, handleSelect } = setup('other')
      api.seedWorkingState('s1', true)
      api.maybeNotify(makeSession({ working: false }))
      expect(notify).not.toHaveBeenCalled()
      expect(toastInfo).toHaveBeenCalledTimes(1)
      const [msg, opts] = toastInfo.mock.calls[0]
      expect(msg).toContain('Session One')
      // onClick should jump to the session.
      opts.onClick()
      expect(handleSelect).toHaveBeenCalledWith('s1')
    })

    it('uses toast.error when the completed turn carries an error', () => {
      setFocus(true)
      const { api } = setup('other')
      api.seedWorkingState('s1', true)
      api.maybeNotify(makeSession({ working: false, error: 'boom' } as Partial<SessionInfo>))
      expect(toastError).toHaveBeenCalledTimes(1)
      expect(toastInfo).not.toHaveBeenCalled()
    })

    it('falls back to a desktop notification when the window is not focused', () => {
      setFocus(false)
      const { api } = setup('s1')
      api.seedWorkingState('s1', true)
      api.maybeNotify(makeSession({ working: false }))
      expect(notify).toHaveBeenCalledTimes(1)
      expect(toastInfo).not.toHaveBeenCalled()
    })

    it('only fires on the falling edge (working true→false)', () => {
      setFocus(false)
      const { api } = setup('other')
      api.seedWorkingState('s1', false)
      api.maybeNotify(makeSession({ working: true })) // rising edge — no fire
      expect(notify).not.toHaveBeenCalled()
      expect(toastInfo).not.toHaveBeenCalled()
    })
  })

  describe('maybePermissionNotify', () => {
    it('fires a sticky in-app toast (durationMs:0) when focused elsewhere', () => {
      setFocus(true)
      const { api, handleSelect } = setup('other')
      api.maybePermissionNotify('s1', 'Bash')
      expect(notify).not.toHaveBeenCalled()
      expect(toastInfo).toHaveBeenCalledTimes(1)
      const [msg, opts] = toastInfo.mock.calls[0]
      expect(msg).toContain('needs permission')
      expect(opts.durationMs).toBe(0)
      opts.onClick()
      expect(handleSelect).toHaveBeenCalledWith('s1')
    })

    it('skips when focused on the requesting session', () => {
      setFocus(true)
      const { api } = setup('s1')
      api.maybePermissionNotify('s1', 'Bash')
      expect(notify).not.toHaveBeenCalled()
      expect(toastInfo).not.toHaveBeenCalled()
    })

    it('falls back to a requireInteraction desktop notification when unfocused', () => {
      setFocus(false)
      const { api } = setup('s1')
      api.maybePermissionNotify('s1', 'Bash')
      expect(toastInfo).not.toHaveBeenCalled()
      expect(notify).toHaveBeenCalledTimes(1)
      expect(notify.mock.calls[0][0].requireInteraction).toBe(true)
    })
  })
})
