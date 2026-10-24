import { describe, expect, it } from 'vitest'
import { resetCompletion } from './reset-completion'

describe('resetCompletion — how the /clear|/handoff POST continuation finishes the X→Y swap', () => {
  it('swaps when the server created Y and X still hosts an open panel', () => {
    expect(resetCompletion({ oldId: 'x', newId: 'y', panelOpen: true })).toBe('swap')
  })

  it('tears X down when the server created Y but the panel closed mid-wait', () => {
    // /handoff's summarize leg widens the window from ~100ms to tens of
    // seconds. swapSession needs an open panel, so the swap is skipped — but
    // the client must NOT no-op: the clearingIds guard swallowed
    // session-removed(X) (X is still in `sessions`) and session-created(Y)
    // parked Y behind an evicting pending marker that only swapSession
    // consumes. Leaving both in place yields a clickable ghost X and an
    // invisible Y. teardownRemovedSession is the shared path that evicts X
    // and lets Y surface.
    expect(resetCompletion({ oldId: 'x', newId: 'y', panelOpen: false })).toBe('teardown')
  })

  it('no-ops when the server short-circuited (newId === oldId)', () => {
    // Another clear was already in flight, or the server's `clearing` flag is
    // stuck — X is still the live session. No swap, no teardown.
    expect(resetCompletion({ oldId: 'x', newId: 'x', panelOpen: true })).toBe('noop')
    expect(resetCompletion({ oldId: 'x', newId: 'x', panelOpen: false })).toBe('noop')
  })
})
