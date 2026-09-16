// Global test setup, wired via `test.setupFiles` in vitest.config.ts.
//
// vitest.config.ts runs with `globals: false`, so @testing-library/react's
// built-in auto-cleanup never registers — RTL only installs its own afterEach
// hook when a *global* `afterEach` already exists. Without this file each
// render stays mounted past the end of its test, so any effect timer whose only
// cancel path is the unmount cleanup — SessionCard's 260ms `.slot-in` timer,
// usePresenceValue's exit timer — survives into vitest's jsdom teardown. Firing
// there calls dispatchSetState with `window` already gone ("ReferenceError:
// window is not defined"), which vitest counts as an unhandled error and exits
// 1 — reddening CI while every assertion in the run still reported passing.
//
// Registered here once instead of per file: 58 of the 114 render-based test
// files never call cleanup() at all, and every one of them was another chance
// to re-introduce that CI-red teardown race.
//
// Pure-logic files run in the node environment (see `environmentMatchGlobs`) and
// have no `document`, so the hook no-ops for them and never imports RTL.
import { afterEach } from 'vitest'

afterEach(async () => {
  if (typeof document === 'undefined') return
  const { cleanup } = await import('@testing-library/react')
  cleanup()
})