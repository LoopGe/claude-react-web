// Verifies the passive error-capture layer:
//   1. RootErrorBoundary catches a child render crash, renders the fallback
//      card, and records message + componentStack (the diagnostic that names
//      the culprit component).
//   2. recordCrash writes to both getLastCrash() and window.__crwLastError.
//   3. installGlobalErrorCapture is idempotent and captures an unhandled
//      promise rejection.

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
})
