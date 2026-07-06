// Reproduces the regression introduced by the groupsLoaded gate: a session
// opened (via sidebar click → App state) in the window between sessionsLoaded
// and groupsLoaded must still be written to the URL hash once init runs.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useSessionUrl } from './useSessionUrl'

beforeEach(() => {
  // Start from a clean URL (no deep-link hash) for every case.
  history.replaceState(null, '', location.pathname + location.search)
})

describe('useSessionUrl', () => {
  it('writes the hash for a session opened between sessionsLoaded and groupsLoaded', () => {
    const onOpenSession = vi.fn()
    const onFocusPanel = vi.fn()
    // Hold stable array references, matching useState semantics: openIds
    // keeps the same reference across renders that don't call setOpenIds.
    // Passing a fresh `['x']` literal each rerender would artificially
    // re-run the write effect (Object.is dep check) and mask the bug.
    const empty: string[] = []
    const xIds: string[] = ['x']
    const { rerender } = renderHook(
      (props) => useSessionUrl(props),
      {
        initialProps: {
          sessionsLoaded: false,
          groupsLoaded: false,
          openIds: empty,
          focusedId: null as string | null,
          maxOpen: 3,
          onOpenSession,
          onFocusPanel,
        },
      },
    )

    // Sessions snapshot arrives; ui-state still loading → init deferred.
    rerender({ sessionsLoaded: true, groupsLoaded: false, openIds: empty, focusedId: null, maxOpen: 3, onOpenSession, onFocusPanel })
    // User clicks a sidebar session: App state updates openIds/focusedId.
    // (openIds reference changes here, as a real setOpenIds(['x']) would.)
    rerender({ sessionsLoaded: true, groupsLoaded: false, openIds: xIds, focusedId: 'x', maxOpen: 3, onOpenSession, onFocusPanel })
    // ui-state lands → init runs. No deep-link hash, so the read effect
    // returns early without touching openIds. openIds keeps its reference
    // (no further setOpenIds), so the write effect's deps are unchanged —
    // yet the hash must still be flushed for the session opened above.
    rerender({ sessionsLoaded: true, groupsLoaded: true, openIds: xIds, focusedId: 'x', maxOpen: 3, onOpenSession, onFocusPanel })

    expect(location.hash).toBe('#x')
  })

  it('does not clear a deep-link hash before init runs (init deferred on groupsLoaded)', () => {
    // The commit's original fix: while init waits for groupsLoaded, the
    // write effect must NOT run writeHash([], null) and clobber the URL.
    const onOpenSession = vi.fn()
    const onFocusPanel = vi.fn()
    const empty: string[] = []
    history.replaceState(null, '', '#a+b')

    const { rerender } = renderHook(
      (props) => useSessionUrl(props),
      {
        initialProps: {
          sessionsLoaded: false, groupsLoaded: false, openIds: empty,
          focusedId: null as string | null, maxOpen: 3, onOpenSession, onFocusPanel,
        },
      },
    )
    // sessionsLoaded arrives, ui-state still loading → init deferred, hash
    // must survive even though openIds is still [].
    rerender({ sessionsLoaded: true, groupsLoaded: false, openIds: empty, focusedId: null, maxOpen: 3, onOpenSession, onFocusPanel })
    expect(location.hash).toBe('#a+b')
  })

  it('opens the deep-link ids once groupsLoaded arrives', () => {
    const onOpenSession = vi.fn()
    const onFocusPanel = vi.fn()
    const empty: string[] = []
    history.replaceState(null, '', '#a+b~a')

    const { rerender } = renderHook(
      (props) => useSessionUrl(props),
      {
        initialProps: {
          sessionsLoaded: false, groupsLoaded: false, openIds: empty,
          focusedId: null as string | null, maxOpen: 3, onOpenSession, onFocusPanel,
        },
      },
    )
    rerender({ sessionsLoaded: true, groupsLoaded: false, openIds: empty, focusedId: null, maxOpen: 3, onOpenSession, onFocusPanel })
    expect(onOpenSession).not.toHaveBeenCalled()
    rerender({ sessionsLoaded: true, groupsLoaded: true, openIds: empty, focusedId: null, maxOpen: 3, onOpenSession, onFocusPanel })
    expect(onOpenSession).toHaveBeenCalledWith('a')
    expect(onOpenSession).toHaveBeenCalledWith('b')
    expect(onFocusPanel).toHaveBeenCalledWith('a')
  })
})
