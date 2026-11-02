// useAppOverlays — PanelOverlay union lifecycle (Task 3).
//
// The four independent overlay states (settings / git / tasks / worktree) are
// replaced by a single `PanelOverlay` discriminated union. These tests pin the
// union contract directly (`openPanelOverlay` / `closePanelOverlay` /
// `panelOverlay`) AND the compatibility adapter the rest of App still consumes
// (the derived `*OpenFor` fields and the existing open/close handler names).
//
// `settingsTabRequest` + its nonce, and `helpOpen` / `helpCommands`, stay
// outside the union by design — verified here so a future refactor cannot
// silently fold them in.
import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  useAppOverlays,
  type PanelOverlay,
  type PanelOverlayKind,
} from './useAppOverlays'

const ALL_KINDS: PanelOverlayKind[] = ['settings', 'git', 'tasks', 'worktree']

type OverlayReturn = ReturnType<typeof useAppOverlays>
type HookResult = { current: OverlayReturn }

/** Read the four derived `*OpenFor` fields as a record so each test can assert
 *  the whole set at once without repeating four lines per kind. */
function openFor(result: HookResult) {
  return {
    settings: result.current.settingsOpenFor,
    git: result.current.gitPanelOpenFor,
    tasks: result.current.tasksPanelOpenFor,
    worktree: result.current.worktreeOpenFor,
  }
}

describe('useAppOverlays — PanelOverlay union', () => {
  it('starts with no overlay open and all derived openFor fields null', () => {
    const { result } = renderHook(() => useAppOverlays())

    expect(result.current.panelOverlay).toBeNull()
    expect(result.current.settingsOpenFor).toBeNull()
    expect(result.current.gitPanelOpenFor).toBeNull()
    expect(result.current.tasksPanelOpenFor).toBeNull()
    expect(result.current.worktreeOpenFor).toBeNull()
  })

  it.each(ALL_KINDS)(
    'openPanelOverlay(%s) sets the union and only the matching derived openFor',
    (kind) => {
      const { result } = renderHook(() => useAppOverlays())
      const sid = `s-${kind}`

      act(() => result.current.openPanelOverlay(kind, sid))

      const expected: PanelOverlay = { kind, sessionId: sid }
      expect(result.current.panelOverlay).toEqual(expected)

      const fields = openFor(result)
      for (const k of ALL_KINDS) {
        expect(fields[k]).toBe(k === kind ? sid : null)
      }
    },
  )

  it('openPanelOverlay replaces the previous overlay so at most one is ever open', () => {
    const { result } = renderHook(() => useAppOverlays())

    act(() => result.current.openPanelOverlay('settings', 's1'))
    expect(result.current.panelOverlay).toEqual({ kind: 'settings', sessionId: 's1' })

    act(() => result.current.openPanelOverlay('git', 's2'))
    expect(result.current.panelOverlay).toEqual({ kind: 'git', sessionId: 's2' })
    expect(result.current.settingsOpenFor).toBeNull()
    expect(result.current.gitPanelOpenFor).toBe('s2')

    act(() => result.current.openPanelOverlay('tasks', 's3'))
    expect(result.current.panelOverlay).toEqual({ kind: 'tasks', sessionId: 's3' })
    expect(result.current.gitPanelOpenFor).toBeNull()
    expect(result.current.tasksPanelOpenFor).toBe('s3')

    act(() => result.current.openPanelOverlay('worktree', 's4'))
    expect(result.current.panelOverlay).toEqual({ kind: 'worktree', sessionId: 's4' })
    expect(result.current.tasksPanelOpenFor).toBeNull()
    expect(result.current.worktreeOpenFor).toBe('s4')

    // After the full cycle, exactly one derived field is non-null.
    const openCount = [
      result.current.settingsOpenFor,
      result.current.gitPanelOpenFor,
      result.current.tasksPanelOpenFor,
      result.current.worktreeOpenFor,
    ].filter((v) => v !== null).length
    expect(openCount).toBe(1)
  })

  it('opening a different kind never leaves both open', () => {
    const { result } = renderHook(() => useAppOverlays())

    act(() => result.current.openPanelOverlay('settings', 's1'))
    act(() => result.current.openPanelOverlay('git', 's2'))

    const nonNull = Object.entries(openFor(result)).filter(([, v]) => v !== null)
    expect(nonNull).toHaveLength(1)
    expect(nonNull[0][0]).toBe('git')
    expect(result.current.gitPanelOpenFor).toBe('s2')
    expect(result.current.settingsOpenFor).toBeNull()
  })

  it('closePanelOverlay clears only a matching kind', () => {
    const { result } = renderHook(() => useAppOverlays())

    act(() => result.current.openPanelOverlay('git', 's1'))

    // Mismatched kind does NOT clear.
    act(() => result.current.closePanelOverlay('settings'))
    expect(result.current.panelOverlay).toEqual({ kind: 'git', sessionId: 's1' })
    expect(result.current.gitPanelOpenFor).toBe('s1')

    // Mismatched kind again — still open.
    act(() => result.current.closePanelOverlay('worktree'))
    expect(result.current.gitPanelOpenFor).toBe('s1')

    // Matching kind clears to null.
    act(() => result.current.closePanelOverlay('git'))
    expect(result.current.panelOverlay).toBeNull()
    expect(result.current.gitPanelOpenFor).toBeNull()
  })

  it('closePanelOverlay on a null union is a no-op', () => {
    const { result } = renderHook(() => useAppOverlays())
    act(() => result.current.closePanelOverlay('settings'))
    expect(result.current.panelOverlay).toBeNull()
  })
})

describe('useAppOverlays — compatibility adapter', () => {
  it.each([
    ['settings', 'handleOpenSettings', 'handleCloseSettings', 'settingsOpenFor'],
    ['git', 'handleOpenGitPanel', 'handleCloseGitPanel', 'gitPanelOpenFor'],
    ['tasks', 'handleOpenTasksPanel', 'handleCloseTasksPanel', 'tasksPanelOpenFor'],
    ['worktree', 'handleOpenWorktree', 'handleCloseWorktree', 'worktreeOpenFor'],
  ] as const)(
    '%s handler opens the union and the kind-specific close clears only it',
    (kind, openName, closeName, field) => {
      const { result } = renderHook(() => useAppOverlays())

      const open = result.current[openName] as (id: string) => void
      const close = result.current[closeName] as () => void

      act(() => open('sid'))
      expect(result.current.panelOverlay).toEqual({ kind, sessionId: 'sid' })
      expect(result.current[field]).toBe('sid')

      // A different kind's close must not affect this overlay.
      const otherClose =
        kind === 'settings'
          ? result.current.handleCloseGitPanel
          : result.current.handleCloseSettings
      act(() => otherClose())
      expect(result.current[field]).toBe('sid')
      expect(result.current.panelOverlay).toEqual({ kind, sessionId: 'sid' })

      // The matching close clears.
      act(() => close())
      expect(result.current.panelOverlay).toBeNull()
      expect(result.current[field]).toBeNull()
    },
  )

  it('each open handler replaces the previous overlay (mutual exclusion preserved)', () => {
    const { result } = renderHook(() => useAppOverlays())

    act(() => result.current.handleOpenSettings('s1'))
    expect(result.current.settingsOpenFor).toBe('s1')

    act(() => result.current.handleOpenGitPanel('s2'))
    expect(result.current.settingsOpenFor).toBeNull()
    expect(result.current.gitPanelOpenFor).toBe('s2')

    act(() => result.current.handleOpenTasksPanel('s3'))
    expect(result.current.gitPanelOpenFor).toBeNull()
    expect(result.current.tasksPanelOpenFor).toBe('s3')

    act(() => result.current.handleOpenWorktree('s4'))
    expect(result.current.tasksPanelOpenFor).toBeNull()
    expect(result.current.worktreeOpenFor).toBe('s4')
  })
})

describe('useAppOverlays — openSettingsTab deep-link', () => {
  it('opens settings and produces a fresh nonce with the correct sessionId/tab', () => {
    const { result } = renderHook(() => useAppOverlays())

    expect(result.current.settingsTabRequest).toBeNull()

    act(() => result.current.openSettingsTab('s1', 'mcp'))
    expect(result.current.settingsOpenFor).toBe('s1')
    expect(result.current.panelOverlay).toEqual({ kind: 'settings', sessionId: 's1' })
    expect(result.current.settingsTabRequest).toEqual({
      sessionId: 's1',
      tab: 'mcp',
      nonce: 1,
    })

    // A second call for a different tab produces a strictly greater nonce —
    // the SettingsPanel re-apply contract keys on the nonce, not the tab value,
    // so a stale request must never be reused.
    act(() => result.current.openSettingsTab('s1', 'context'))
    expect(result.current.settingsTabRequest).toEqual({
      sessionId: 's1',
      tab: 'context',
      nonce: 2,
    })
    expect(result.current.settingsTabRequest!.nonce).toBeGreaterThan(1)

    // A third call for a different session updates sessionId too.
    act(() => result.current.openSettingsTab('s2', 'plugins'))
    expect(result.current.settingsTabRequest).toEqual({
      sessionId: 's2',
      tab: 'plugins',
      nonce: 3,
    })
  })

  it('preserves overlay mutual-exclusion semantics (replaces a non-settings overlay)', () => {
    const { result } = renderHook(() => useAppOverlays())

    act(() => result.current.handleOpenGitPanel('g1'))
    expect(result.current.gitPanelOpenFor).toBe('g1')

    act(() => result.current.openSettingsTab('s1', 'mcp'))
    // Settings is now the sole overlay; git was replaced.
    expect(result.current.panelOverlay).toEqual({ kind: 'settings', sessionId: 's1' })
    expect(result.current.settingsOpenFor).toBe('s1')
    expect(result.current.gitPanelOpenFor).toBeNull()
    // And the deep-link request landed alongside the overlay transition.
    expect(result.current.settingsTabRequest).toEqual({
      sessionId: 's1',
      tab: 'mcp',
      nonce: 1,
    })
  })
})

describe('useAppOverlays — non-union state stays outside', () => {
  it('helpOpen / helpCommands are independent of the overlay union', () => {
    const { result } = renderHook(() => useAppOverlays())

    expect(result.current.helpOpen).toBe(false)
    expect(result.current.helpCommands).toEqual([])

    act(() => result.current.openPanelOverlay('settings', 's1'))
    act(() => result.current.showHelpWithCommands([{ name: '/x' } as never]))

    expect(result.current.helpOpen).toBe(true)
    expect(result.current.helpCommands).toHaveLength(1)
    // The help state did not touch the overlay.
    expect(result.current.panelOverlay).toEqual({ kind: 'settings', sessionId: 's1' })

    // toggleShortcutHelp(currentlyOpen=true) flips help closed. The existing
    // contract intentionally RETAINS helpCommands on close (only the
    // open-via-shortcut path clears them), so assert only the open flip and the
    // overlay independence — not the command list.
    act(() => result.current.toggleShortcutHelp(true))
    expect(result.current.helpOpen).toBe(false)
    // Closing help did not touch the overlay either.
    expect(result.current.panelOverlay).toEqual({ kind: 'settings', sessionId: 's1' })
  })

  it('settingsTabRequest starts null and is only set by openSettingsTab', () => {
    const { result } = renderHook(() => useAppOverlays())

    expect(result.current.settingsTabRequest).toBeNull()

    // Opening the settings overlay via the plain handler does NOT fabricate a
    // tab request — only openSettingsTab may produce one.
    act(() => result.current.handleOpenSettings('s1'))
    expect(result.current.settingsTabRequest).toBeNull()
    expect(result.current.settingsOpenFor).toBe('s1')

    act(() => result.current.openSettingsTab('s1', 'mcp'))
    expect(result.current.settingsTabRequest).not.toBeNull()
  })
})
