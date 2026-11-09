/** Motion suppression — the single app-level predicate that answers "should
 *  decorative motion be suppressed right now?".
 *
 *  Two sources feed it:
 *  - the OS `prefers-reduced-motion: reduce` query;
 *  - the in-app Animation speed = Off preset (`setAppMotionOff`), written by
 *    App whenever the global preference loads or changes.
 *
 *  Every JS/motion animation gate reads `motionSuppressed()` (or the reactive
 *  `useMotionSuppressed()` hook), so one setting covers framer-motion hooks,
 *  FLIP, WAAPI and the reveal helpers. CSS has its own two channels: the
 *  scaled `--motion-duration-*` tokens plus the `[data-motion="off"]`
 *  attribute block (see shared/animation-speed.ts).
 *
 *  The two probes stay separate on purpose: App.tsx's CSS-token write must
 *  know whether the OS preference already owns the stylesheet (in which case
 *  it leaves the tokens alone) independently of the in-app setting. */
import { useSyncExternalStore } from 'react'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

let appMotionOff = false
const listeners = new Set<() => void>()
/** Attached MediaQueryList while at least one subscriber exists. Reused by the
 *  snapshot readers so a render-time probe never allocates a new one. */
let mql: MediaQueryList | null = null
let osListening = false

function notifyMotionPreference(): void {
  for (const listener of listeners) listener()
}

function osMatchMedia(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(REDUCED_MOTION_QUERY)
}

function attachOsListener(): void {
  if (osListening) return
  mql = osMatchMedia()
  if (!mql) return
  mql.addEventListener('change', notifyMotionPreference)
  osListening = true
}

function detachOsListener(): void {
  if (!osListening || !mql) return
  mql.removeEventListener('change', notifyMotionPreference)
  osListening = false
  mql = null
}

/** Whether the OS asks for reduced motion. Pure, non-reactive probe — call it
 *  at the point of use. Safe in non-DOM environments (returns false).
 *
 *  While a subscriber is attached, this reads that MediaQueryList (which is
 *  live) instead of creating a new one: it is the `useSyncExternalStore`
 *  snapshot, so it runs on every render of every subscriber. */
export function osPrefersReducedMotion(): boolean {
  if (mql) return mql.matches
  return osMatchMedia()?.matches ?? false
}

/** Whether decorative motion should be suppressed — the OS preference OR the
 *  in-app Off preset. Pure, non-reactive probe: read it at the point of use
 *  (event handlers, effects). Components that must re-render when the setting
 *  changes use `useMotionSuppressed()` instead. */
export function motionSuppressed(): boolean {
  return appMotionOff || osPrefersReducedMotion()
}

/** Mirror the in-app Animation speed = Off preset into the motion gate. App
 *  calls this from both `globalPrefs` writers before the state update, so
 *  render-phase reads in the same commit already see the new value. */
export function setAppMotionOff(off: boolean): void {
  if (off === appMotionOff) return
  const wasSuppressed = motionSuppressed()
  appMotionOff = off
  // Only notify when the EFFECTIVE answer changed: while the OS already
  // suppresses motion, flipping the in-app preset cannot alter any consumer's
  // rendered result.
  if (motionSuppressed() !== wasSuppressed) notifyMotionPreference()
}

/** Subscribe to any change of the suppression answer (in-app setting or OS
 *  query). Returns an unsubscribe function. */
export function subscribeMotionSuppressed(listener: () => void): () => void {
  listeners.add(listener)
  // Idempotent: retries an earlier attach that found no matchMedia (e.g. a
  // subscriber mounted before the environment installed one).
  attachOsListener()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) detachOsListener()
  }
}

/** Reactive form of `motionSuppressed()` for render-time decisions. */
export function useMotionSuppressed(): boolean {
  return useSyncExternalStore(subscribeMotionSuppressed, motionSuppressed, () => false)
}

/** Reactive form of `osPrefersReducedMotion()`, for decisions that must tell
 *  the OS preference apart from the in-app Off preset (App's CSS-token write
 *  skips under the OS query, but still writes for Off). */
export function useOsPrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotionSuppressed, osPrefersReducedMotion, () => false)
}
