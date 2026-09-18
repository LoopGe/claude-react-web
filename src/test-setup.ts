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

// ── WAAPI `cancel()` rejection shim ──────────────────────────────────
//
// Per the Web Animations spec, `Animation.cancel()` rejects the animation's
// `finished` promise with an AbortError. happy-dom implements that, but its
// `finished` is a MUTABLE field that `play()` re-creates whenever the playback
// state is `idle` or `finished`. A library that bound its handler to the
// promise it read at creation time — motion does exactly this, in
// AsyncMotionValueAnimation's `animation.finished.then(...).catch(noop)` —
// therefore ends up holding a stale promise after any pause/play cycle, and
// the rejection lands on a fresh one that nobody observes.
//
// That is what turned the jsdom → happy-dom switch into a red CI run with
// every assertion still green: vitest counts unhandled rejections as errors and
// exits 1, so 19 "AbortError: The animation was canceled." errors failed the
// build while 4276/4276 tests passed. The cancel sites were motion's own exit
// animations (Overlay's motion mode, used by Composer and
// UploadsManagerDialog), which no app-level change can reach.
//
// Attaching a no-op handler to the animation's OWN current promises before
// delegating keeps those rejections observed without changing cancel()'s
// semantics — a consumer that does await `finished` still sees the AbortError.
// It is narrow in that only the two promises cancel() itself rejects are
// drained, so a genuine unhandled rejection anywhere else still fails the run.
//
// The flip side is worth stating plainly, because it is a real loss: happy-dom's
// `Element.animate()` builds its instances from this same prototype, so the shim
// ALSO drains real app-level `el.animate()` handles. A future component that
// cancels one without draining it would look green here while still logging an
// unhandled rejection in a real browser. ChatEmptyState's raw handle is a real
// instance of exactly that bug; it is fixed at its own call site, and its test
// stubs `animate` with a plain object — bypassing this shim entirely — so the
// test still fails if that app-level drain is ever removed.
//
// Guarded on WAAPI actually being present, so the node-environment files and
// the jsdom ones (store.test.ts pins itself back with a pragma) are untouched.
const animationProto = typeof Animation === 'undefined' ? undefined : Animation.prototype
if (typeof animationProto?.cancel === 'function') {
  const originalCancel = animationProto.cancel
  animationProto.cancel = function (this: Animation) {
    this.finished?.catch(() => {})
    this.ready?.catch(() => {})
    return originalCancel.call(this)
  }
}

afterEach(async () => {
  if (typeof document === 'undefined') return
  const { cleanup } = await import('@testing-library/react')
  cleanup()
})