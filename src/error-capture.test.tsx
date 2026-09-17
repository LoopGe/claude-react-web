// Verifies the passive error-capture layer:
//   1. RootErrorBoundary catches a child render crash, renders the fallback
//      card, and records message + componentStack (the diagnostic that names
//      the culprit component).
//   2. recordCrash writes to both getLastCrash() and window.__crwLastError.
//   3. installGlobalErrorCapture is idempotent and captures an unhandled
//      promise rejection.
//   4. The window error listener ignores the benign `ResizeObserver loop …`
//      guard report (both accepted wordings) while still recording a genuine
//      uncaught error, and downgrades / records resource-load failures
//      structurally rather than via a `message` that a plain Event never has.

import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { getLastCrash, clearLastCrash, recordCrash, installGlobalErrorCapture } from './error-capture'
import { RootErrorBoundary } from './error-capture-boundary'

function Boom(): never {
  throw new Error('boom')
}

describe('error-capture', () => {
  afterEach(() => {
    clearLastCrash()
    cleanup()
    vi.restoreAllMocks()
  })

  it('RootErrorBoundary catches a child render error and renders the fallback card', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <RootErrorBoundary>
        <Boom />
      </RootErrorBoundary>,
    )
    expect(screen.getByText('Something went wrong')).toBeTruthy()
    expect(screen.getByText(/boom/)).toBeTruthy()
    const crash = getLastCrash()
    expect(crash?.kind).toBe('render')
    expect(crash?.message).toBe('boom')
    expect(crash?.componentStack).toContain('Boom')
    err.mockRestore()
  })

  it('recordCrash writes to getLastCrash and window.__crwLastError', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    recordCrash({ kind: 'uncaught', at: 1, message: 'x', error: new Error('x') })
    expect(getLastCrash()?.message).toBe('x')
    expect(window.__crwLastError?.message).toBe('x')
    err.mockRestore()
  })

  it('installGlobalErrorCapture is idempotent and captures unhandled rejections', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    installGlobalErrorCapture()
    installGlobalErrorCapture() // second call must not double-install
    const win = window as unknown as { __crwErrorCaptureInstalled?: boolean }
    expect(win.__crwErrorCaptureInstalled).toBe(true)

    const reason = new Error('rejected')
    let evt: Event
    try {
      // A real `Promise.reject(reason)` here would itself count as an
      // unhandled rejection in jsdom and trip vitest's unhandled-error check.
      // The capture handler only reads `e.reason`, so a resolved promise is
      // fine for the event payload.
      evt = new PromiseRejectionEvent('unhandledrejection', {
        promise: Promise.resolve(),
        reason,
      })
    } catch {
      evt = new Event('unhandledrejection')
      Object.defineProperty(evt, 'reason', { value: reason })
    }
    window.dispatchEvent(evt)
    expect(getLastCrash()?.kind).toBe('unhandledrejection')
    err.mockRestore()
  })

  it('ignores benign ResizeObserver loop reports instead of recording a crash', () => {
    // Hundreds of these arrive per turn while a layout churns. Recording them
    // floods the console AND overwrites __crwLastError, so the sink stops
    // holding the last real crash — which is the whole point of the layer.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    installGlobalErrorCapture()

    // Both strings the gate accepts: the first is the wording every current
    // engine emits, the second the pre-M84 Chromium one kept for older clients.
    // Neither carries an `error` payload — the shape of a real guard report.
    for (const message of [
      'ResizeObserver loop completed with undelivered notifications.',
      'ResizeObserver loop limit exceeded',
    ]) {
      window.dispatchEvent(new ErrorEvent('error', { message }))
    }

    expect(getLastCrash()).toBeNull()
    expect(err).not.toHaveBeenCalled()

    // Positive control: the listener is attached (installGlobalErrorCapture is
    // idempotent, so this may well be the one a sibling test installed — either
    // way it is live), which is what makes the assertions above evidence that
    // the gate fired rather than that nothing ran.
    window.dispatchEvent(new ErrorEvent('error', { message: 'real boom' }))
    expect(getLastCrash()?.kind).toBe('uncaught')
    expect(getLastCrash()?.message).toBe('real boom')
    err.mockRestore()
  })

  it('still records an error whose message merely starts with the guard text', () => {
    // The `e.error == null` half of the gate: a browser-synthesised guard
    // report carries no error payload, a genuine throw does. Narrowing on the
    // message alone would swallow this — at exactly the moment a white screen
    // is being diagnosed.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    installGlobalErrorCapture()
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'ResizeObserver loop completed with undelivered notifications: re-pin failed',
        error: new Error('re-pin failed'),
      }),
    )
    expect(getLastCrash()?.kind).toBe('uncaught')
    expect(getLastCrash()?.message).toContain('re-pin failed')
    err.mockRestore()
  })

  it('downgrades a resource-load failure instead of recording it as a crash', () => {
    // The failing element dispatches a PLAIN Event — `message` is undefined,
    // not '' — so without the structural check a broken <img>/font falls
    // through to recordCrash and clobbers the crash sink, which is the very
    // pollution this layer exists to avoid. Dispatched non-bubbling; the
    // window capture listener still receives it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    installGlobalErrorCapture()
    const img = document.createElement('img')
    document.body.appendChild(img)
    img.dispatchEvent(new Event('error'))
    expect(getLastCrash()).toBeNull()
    expect(err).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    img.remove()
    warn.mockRestore()
    err.mockRestore()
  })

  it('records a failed <script> chunk with its src — the chunk-load white-screen case', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    installGlobalErrorCapture()
    const script = document.createElement('script')
    script.src = 'https://example.test/dead-chunk.js'
    document.head.appendChild(script)
    // Dispatched synchronously, before any load could be attempted.
    script.dispatchEvent(new Event('error'))
    script.remove()
    // The URL is the whole diagnostic value: it names which chunk died after a
    // deploy, which the generic 'Uncaught error' fallback would discard.
    expect(getLastCrash()?.message).toBe('script load failed: https://example.test/dead-chunk.js')
    err.mockRestore()
  })
})
