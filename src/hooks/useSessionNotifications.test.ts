// Verifies the three-state dispatch in useSessionNotifications:
//   - skip    → window focused AND looking at this session: nothing fires.
//   - toast   → window focused, looking elsewhere: in-app toast fires,
//               desktop notify does NOT.
//   - desktop → window not focused: desktop notify fires, toast does NOT.
// Both `maybeNotify` (turn complete) and `maybePermissionNotify` are covered.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { RefObject } from 'react'
import type { SessionInfo } from '../types'

// --- Mocks for the two surfaces the hook dispatches to ------------------
// notify / notifyWithActions return `true` = "a notification was actually
// displayed" — the production hook gates its close bookkeeping on that.
const notify = vi.fn().mockReturnValue(true)
const notifyWithActions = vi.fn().mockReturnValue(true)
const closeByTag = vi.fn().mockResolvedValue(undefined)
vi.mock('./useNotifications', () => ({
  useNotifications: () => ({
    enabled: true,
    permission: 'granted',
    toggle: vi.fn(),
    notify,
    notifyWithActions,
    closeByTag,
  }),
}))

const toastInfo = vi.fn().mockReturnValue('toast-1')
const toastError = vi.fn()
const toastDismiss = vi.fn()
vi.mock('./useToast', () => ({
  useToast: () => ({
    info: toastInfo,
    error: toastError,
    success: vi.fn(),
    show: vi.fn(),
    dismiss: toastDismiss,
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

let hasFocusSpy: ReturnType<typeof vi.spyOn> | null = null
function setFocus(windowFocused: boolean) {
  // Re-spying on an already-spied function stacks a second tinyspy and
  // mockRestore only peels one layer. Switch the existing spy instead.
  if (hasFocusSpy) {
    hasFocusSpy.mockReturnValue(windowFocused)
    return
  }
  hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(windowFocused)
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
  afterEach(() => {
    // setFocus's spy must not leak into the next test — a leftover
    // mockReturnValue would silently flip presentation() for tests that
    // don't call setFocus themselves.
    hasFocusSpy?.mockRestore()
    hasFocusSpy = null
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
      // Structured toast: session name is the title, completion is the body.
      expect(opts.title).toContain('Session One')
      expect(msg).toBe('Turn complete')
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
      const [msg, opts] = toastError.mock.calls[0]
      expect(msg).toBe('boom')
      expect(opts.title).toContain('Session One')
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
      // Structured: "needs permission" is the title, the tool is the body.
      expect(opts.title).toContain('needs permission')
      expect(msg).toBe('Approve or deny: Bash')
      expect(opts.durationMs).toBe(0)
      opts.onClick()
      expect(handleSelect).toHaveBeenCalledWith('s1')
    })

    it('uses question wording (not "needs permission") for AskUserQuestion', () => {
      setFocus(true)
      const { api } = setup('other')
      api.maybePermissionNotify('s1', 'a question', 'question')
      expect(toastInfo).toHaveBeenCalledTimes(1)
      const [msg, opts] = toastInfo.mock.calls[0]
      expect(opts.title).toContain('is asking a question')
      expect(opts.title).not.toContain('needs permission')
      expect(opts.actionLabel).toBe('Answer')
      expect(msg).toBe('Open to answer')
    })

    it('uses question wording in the desktop fallback too', () => {
      setFocus(false)
      const { api } = setup('s1')
      api.maybePermissionNotify('s1', 'a question', 'question')
      expect(notify).toHaveBeenCalledTimes(1)
      const arg = notify.mock.calls[0][0]
      expect(arg.title).toContain('is asking a question')
      expect(arg.title).not.toContain('needs permission')
      expect(arg.body).not.toContain('Approve or deny')
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

  describe('maybeCliNotify (CLI notification frames)', () => {
    const n = { text: 'Claude is waiting for your input', priority: 'medium' as const, key: 'idle' }

    it('skips when focused on the notifying session', () => {
      setFocus(true)
      const { api } = setup('s1')
      api.maybeCliNotify('s1', n)
      expect(notify).not.toHaveBeenCalled()
      expect(toastInfo).not.toHaveBeenCalled()
    })

    it('fires a transient (non-sticky) toast with the CLI text when focused elsewhere', () => {
      setFocus(true)
      const { api, handleSelect } = setup('other')
      api.maybeCliNotify('s1', n)
      expect(notify).not.toHaveBeenCalled()
      expect(toastInfo).toHaveBeenCalledTimes(1)
      const [msg, opts] = toastInfo.mock.calls[0]
      // Structured: session name is the title, the CLI text is the body.
      expect(opts.title).toContain('Session One')
      expect(msg).toBe('Claude is waiting for your input')
      // NOT sticky like permission toasts — default 8s, no durationMs:0.
      expect(opts.durationMs).toBe(8000)
      opts.onClick()
      expect(handleSelect).toHaveBeenCalledWith('s1')
    })

    it('honors the CLI-suggested timeout and clamps it into a sane range', () => {
      setFocus(true)
      const { api } = setup('other')
      api.maybeCliNotify('s1', { ...n, timeoutMs: 500 })
      expect(toastInfo.mock.calls[0][1].durationMs).toBe(2000) // clamped up
      api.maybeCliNotify('s1', { ...n, timeoutMs: 120_000 })
      expect(toastInfo.mock.calls[1][1].durationMs).toBe(30_000) // clamped down
    })

    it('fires a desktop notification with a key-tagged dedup tag when unfocused', () => {
      setFocus(false)
      const { api } = setup('s1')
      api.maybeCliNotify('s1', n)
      expect(toastInfo).not.toHaveBeenCalled()
      expect(notify).toHaveBeenCalledTimes(1)
      const arg = notify.mock.calls[0][0]
      expect(arg.body).toBe('Claude is waiting for your input')
      expect(arg.tag).toBe('s1:cli:idle')
      // medium priority → quiet (silent), unlike a permission request's
      // requireInteraction.
      expect(arg.silent).toBe(true)
      expect(arg.requireInteraction).toBeUndefined()
    })

    it('is loud (not silent) for immediate/high priority on the desktop path', () => {
      setFocus(false)
      const { api } = setup('s1')
      api.maybeCliNotify('s1', { ...n, priority: 'immediate' })
      expect(notify).toHaveBeenCalledTimes(1)
      expect(notify.mock.calls[0][0].silent).toBe(false)
    })
  })

  describe('dismissPermissionToast / pruneSession close the OS notification', () => {
    it('dismissPermissionToast closes the OS notification tagged :perm when one was shown', () => {
      // Desktop path (window unfocused) → OS notification with the :perm tag.
      setFocus(false)
      const { api } = setup('s1')
      api.maybePermissionNotify('s1', 'Bash')
      expect(notify).toHaveBeenCalledTimes(1)
      api.dismissPermissionToast('s1')
      expect(closeByTag).toHaveBeenCalledWith('s1:perm')
    })

    it('dismissPermissionToast skips closeByTag when no OS notification was shown (hot-path guard)', () => {
      // Toast path (window focused, other session) → in-app toast only,
      // no OS notification. closeByTag would be a wasted getNotifications IPC.
      setFocus(true)
      const { api } = setup('other')
      api.maybePermissionNotify('s1', 'Bash')
      expect(toastInfo).toHaveBeenCalledTimes(1)
      api.dismissPermissionToast('s1')
      expect(closeByTag).not.toHaveBeenCalled()
    })

    it('dismissPermissionToast dismisses the sticky in-app toast when one is live', () => {
      setFocus(true)
      const { api } = setup('other')
      // Arm a sticky permission toast so permLiveRef has an entry.
      api.maybePermissionNotify('s1', 'Bash')
      api.dismissPermissionToast('s1')
      expect(toastDismiss).toHaveBeenCalledWith('toast-1')
    })

    it('pruneSession dismisses the sticky in-app toast so a deleted session leaves no lingering toast', () => {
      setFocus(true)
      const { api } = setup('other')
      api.maybePermissionNotify('s1', 'Bash')
      api.pruneSession('s1')
      expect(toastDismiss).toHaveBeenCalledWith('toast-1')
    })

    it('pruneSession also closes the OS notification so a deleted session leaves no lingering toast', () => {
      setFocus(false)
      const { api } = setup('s1')
      api.maybePermissionNotify('s1', 'Bash')
      api.pruneSession('s1')
      expect(closeByTag).toHaveBeenCalledWith('s1:perm')
    })

    it('closes the OS notification for the notifyWithActions path (permission with id + action buttons)', () => {
      // This is the production hot path for actionable permissions —
      // SW showNotification with Allow/Deny buttons. Must reach closeByTag
      // just like the plain fallback.
      setFocus(false)
      const { api } = setup('s1')
      api.maybePermissionNotify('s1', 'Bash', 'permission', 'pid-1', { cmd: 'ls' })
      expect(notifyWithActions).toHaveBeenCalledTimes(1)
      expect(notify).not.toHaveBeenCalled()
      api.dismissPermissionToast('s1')
      expect(closeByTag).toHaveBeenCalledWith('s1:perm')
    })

    it('switching from desktop to toast presentation tears down the prior OS notification', () => {
      // focusedId is 'other' throughout, so the same session is never the
      // one on screen — toast mode is reachable when the window is focused.
      const { api } = setup('other')
      // First request unfocused → OS notification.
      setFocus(false)
      api.maybePermissionNotify('s1', 'Bash', 'permission', 'pA', { cmd: 'ls' })
      expect(notifyWithActions).toHaveBeenCalledTimes(1)
      // Second request arrives while the user is in-app on another session
      // → toast presentation. The stale OS toast (whose Allow/Deny buttons
      // target the superseded pA) must be torn down.
      setFocus(true)
      api.maybePermissionNotify('s1', 'Bash', 'permission', 'pB', { cmd: 'rm' })
      expect(toastInfo).toHaveBeenCalledTimes(1)
      expect(closeByTag).toHaveBeenCalledWith('s1:perm')
    })

    it('switching from toast to desktop presentation dismisses the prior sticky toast', () => {
      setFocus(true)
      const { api } = setup('other')
      api.maybePermissionNotify('s1', 'Bash')
      expect(toastInfo).toHaveBeenCalledTimes(1)
      // User alt-tabs away; a new request arrives → desktop presentation.
      setFocus(false)
      api.maybePermissionNotify('s1', 'Bash', 'permission', 'pB', { cmd: 'rm' })
      expect(notifyWithActions).toHaveBeenCalledTimes(1)
      // The prior sticky toast must not linger.
      expect(toastDismiss).toHaveBeenCalledWith('toast-1')
    })

    it('does not arm the OS close path when notify reports nothing was displayed', () => {
      // Notifications disabled / browser permission revoked: notify()
      // short-circuits and returns false. We must not record osShown, or
      // dismissPermissionToast would pay a getNotifications IPC to close
      // nothing.
      notifyWithActions.mockReturnValueOnce(false)
      setFocus(false)
      const { api } = setup('s1')
      api.maybePermissionNotify('s1', 'Bash', 'permission', 'pA', { cmd: 'ls' })
      expect(notifyWithActions).toHaveBeenCalledTimes(1)
      api.dismissPermissionToast('s1')
      expect(closeByTag).not.toHaveBeenCalled()
    })

    it('same-surface OS replacement does NOT call closeByTag (tag-coalescing owns it)', () => {
      // desktop → desktop is the SAME surface under the SAME tag. Calling
      // closeByTag here would be an async close racing an immediate re-show
      // of the same tag — closeByTag's epoch guard would (correctly) refuse
      // to close anything, so the call is pure waste. OS tag-coalescing
      // replaces the toast; that is the intended mechanism.
      setFocus(false)
      const { api } = setup('s1')
      api.maybePermissionNotify('s1', 'Bash', 'permission', 'pA', { cmd: 'ls' })
      expect(notifyWithActions).toHaveBeenCalledTimes(1)
      api.maybePermissionNotify('s1', 'Bash', 'permission', 'pB', { cmd: 'rm' })
      expect(notifyWithActions).toHaveBeenCalledTimes(2)
      expect(closeByTag).not.toHaveBeenCalled()
    })
  })
})
