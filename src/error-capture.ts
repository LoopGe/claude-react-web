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

/** Install passive window-level error listeners. Idempotent; call once at boot. */
export function installGlobalErrorCapture(): void {
  if ((window as { __crwErrorCaptureInstalled?: boolean }).__crwErrorCaptureInstalled) return
  ;(window as { __crwErrorCaptureInstalled?: boolean }).__crwErrorCaptureInstalled = true

  window.addEventListener(
    'error',
    (e) => {
      // Resource-load failures (img/media/font) surface as an 'error' event
      // with an empty message and a target element; they don't crash the app.
      // A failed <script> chunk, though, genuinely can white-screen, so record
      // it. Everything else is downgraded to a non-fatal warning.
      if (e.message === '' && e.target instanceof Element) {
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
