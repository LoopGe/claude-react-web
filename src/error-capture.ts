/**
 * Passive error capture — logic only, no React components. The React piece
 * lives in error-capture-boundary.tsx so that file exports only the component
 * (react-refresh/only-export-components).
 *
 * Installed once at the root (src/main.tsx) so that an intermittent crash —
 * e.g. the "refresh white screen" — leaves a readable trail instead of a blank
 * page. Three layers:
 *
 *   1. `RootErrorBoundary` (error-capture-boundary.tsx) wraps the whole
 *      provider tree. A render/hook crash anywhere below it is caught,
 *      recorded (message + stack + the component stack that names the
 *      culprit), and rendered as a visible error card instead of unmounting
 *      to white.
 *   2. React 19 `createRoot` callbacks (`onUncaughtError` / `onRecoverableError`)
 *      catch what the boundary can't — errors thrown in the boundary itself,
 *      and recoverable hydration mismatches.
 *   3. `window` `error` / `unhandledrejection` listeners catch everything
 *      outside React's render path (event handlers, async, module init).
 *
 * Steady-state cost is ~zero: every hook only fires when an error actually
 * occurs. The last crash is always inspectable at `window.__crwLastError` and
 * via `getLastCrash()`.
 */

import type { RootOptions } from 'react-dom/client'

export type CrashKind = 'render' | 'uncaught' | 'unhandledrejection' | 'recoverable'

export interface CrashRecord {
  kind: CrashKind
  at: number
  message: string
  stack?: string
  componentStack?: string
  error: unknown
}

declare global {
  interface Window {
    /** Last crash captured by the error-capture layer, if any. */
    __crwLastError?: CrashRecord
  }
}

let lastCrash: CrashRecord | null = null

/** The most recent crash, or null if none has been captured. */
export function getLastCrash(): CrashRecord | null {
  return lastCrash
}

export function clearLastCrash(): void {
  lastCrash = null
  delete window.__crwLastError
}

function messageOf(e: unknown): string {
  // JSON.stringify(undefined) returns undefined (not a string), so nullish
  // and JSON-less values (functions, symbols) must fall back to String(e).
  if (e == null) return String(e)
  if (e instanceof Error) return e.message || String(e)
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e) ?? String(e)
  } catch {
    return String(e)
  }
}

function stackOf(e: unknown): string | undefined {
  return e instanceof Error ? e.stack : undefined
}

/** Build a CrashRecord from an arbitrary thrown value. */
export function crashFrom(kind: CrashKind, error: unknown): CrashRecord {
  return { kind, at: Date.now(), message: messageOf(error), stack: stackOf(error), error }
}

/** Record a crash to the console and the `__crwLastError` sink. */
export function recordCrash(crash: CrashRecord): CrashRecord {
  lastCrash = crash
  window.__crwLastError = crash
  console.error(
    `[error-capture] ${crash.kind}: ${crash.message}`,
    crash.componentStack ? `\ncomponentStack:\n${crash.componentStack}` : '',
    crash.stack ? `\nstack:\n${crash.stack}` : '',
    crash.error,
  )
  return crash
}

// ── Layer 3: window-level listeners ─────────────────────────────────

/**
 * Browser-generated reports that arrive on the `window` error channel but are
 * NOT crashes, so they must never reach `recordCrash`.
 *
 * `ResizeObserver loop …` is a spec-mandated guard: an observer's callback
 * changed an observed element's size, so the browser aborts that delivery and
 * re-delivers next frame. Nothing broke and there is nothing to recover — the
 * event exists only so a *developer* can learn the layout is churning. It is
 * not thrown from JS (hence no `stack`) and cannot be a render crash.
 *
 * Why this needs an explicit gate rather than being filtered downstream: the
 * layer's whole value is that `__crwLastError` holds the LAST crash — the one
 * that produced the intermittent refresh-white-screen. A churning layout emits
 * this event hundreds of times per turn, so every one of them used to (a) print
 * a `[error-capture] uncaught:` line, burying real errors, and (b) overwrite
 * the crash sink, leaving the recorded "last error" permanently meaningless.
 *
 * Both halves of the test are deliberate:
 *
 *   - The message match is unavoidably coupled to browser strings, because
 *     that is what every engine keys the report to. `completed with undelivered
 *     notifications` is the wording Chromium, WebKit and Gecko all emit today;
 *     `limit exceeded` is pre-M84 Chromium, kept for older clients.
 *   - `e.error == null` separates a real guard report — synthesised by the
 *     browser, carrying no error payload — from a genuine throw, which always
 *     sets one. The flood logs bear that shape out: the recorded crash's
 *     `error` printed as the ErrorEvent itself, i.e. `e.error ?? e` took the
 *     event. Without this half, a real error that merely *begins* with the
 *     guard wording — a layout wrapper throwing `ResizeObserver loop …: re-pin
 *     failed`, say — would be swallowed at exactly the moment a white screen is
 *     being diagnosed. It reflects engine behaviour rather than a spec
 *     guarantee, so it rides *alongside* the wording match, never in place of
 *     it.
 */
const BENIGN_ERROR_EVENT = /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/

function isBenignErrorEvent(e: ErrorEvent): boolean {
  return e.error == null && BENIGN_ERROR_EVENT.test(e.message)
}

/** Install passive window-level error listeners. Idempotent; call once at boot. */
export function installGlobalErrorCapture(): void {
  if ((window as { __crwErrorCaptureInstalled?: boolean }).__crwErrorCaptureInstalled) return
  ;(window as { __crwErrorCaptureInstalled?: boolean }).__crwErrorCaptureInstalled = true

  window.addEventListener(
    'error',
    (e) => {
      // A benign layout guard report, not a crash — see BENIGN_ERROR_EVENT.
      //
      // Deliberately NOT preventDefault()'d. The browser's own line for this
      // event was absent from the flood logs this gate was written from, and
      // cancelling is not portable anyway — Gecko builds the event with
      // cancelable=false, so it would silently no-op there while looking like a
      // fix. Should the browser's own report ever appear, preventDefault() in
      // this branch is the lever.
      if (isBenignErrorEvent(e)) return
      // Resource-load failures (img/media/font) arrive as a plain Event, not an
      // ErrorEvent — so `message` is `undefined` (never '') and the failing
      // element is the `target`. They don't crash the app, so they're
      // downgraded; a failed <script> chunk genuinely can white-screen, so it is
      // recorded with the URL that died.
      if (!e.message && e.target instanceof Element) {
        const tag = e.target.tagName.toLowerCase()
        if (tag === 'script') {
          recordCrash({
            kind: 'uncaught',
            at: Date.now(),
            message: `script load failed: ${(e.target as HTMLScriptElement).src || '(inline)'}`,
            error: e.target,
          })
        } else {
          console.warn(`[error-capture] resource load failed: <${tag}>`)
        }
        return
      }
      recordCrash({
        ...crashFrom('uncaught', e.error ?? e),
        message: e.message || 'Uncaught error',
      })
    },
    { capture: true },
  )

  window.addEventListener('unhandledrejection', (e) => {
    recordCrash(crashFrom('unhandledrejection', e.reason))
  })
}

// ── Layer 2: createRoot callbacks ───────────────────────────────────

/** React 19 createRoot options: catch errors the boundary can't. */
export const rootCallbacks: RootOptions = {
  onUncaughtError(error, errorInfo) {
    recordCrash({ ...crashFrom('uncaught', error), componentStack: errorInfo.componentStack })
  },
  onRecoverableError(error, errorInfo) {
    recordCrash({ ...crashFrom('recoverable', error), componentStack: errorInfo.componentStack })
  },
}
