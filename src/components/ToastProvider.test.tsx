import { useEffect, useRef } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { ToastProvider } from './ToastProvider'
import { useToast } from '../hooks/useToast'
import type { PushOptions } from '../hooks/toastContext'

afterEach(() => cleanup())

/**
 * Minimal harness: pushes one toast on mount, exposes the toast API and
 * captured id via refs so the test can call dismiss() directly.
 */
function Harness({
  kind,
  message,
  opts,
  apiRef,
  idRef,
}: {
  kind: 'info' | 'error' | 'success'
  message: string
  opts?: PushOptions
  apiRef: React.MutableRefObject<ReturnType<typeof useToast>>
  idRef: React.MutableRefObject<string>
}) {
  const api = useToast()
  const fired = useRef(false)
  useEffect(() => {
    if (fired.current) return
    fired.current = true
    apiRef.current = api
    const id = api.show(kind, message, opts)
    idRef.current = id
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

function setup(
  kind: 'info' | 'error' | 'success',
  message: string,
  opts?: PushOptions,
) {
  const apiRef = { current: null as unknown as ReturnType<typeof useToast> }
  const idRef = { current: '' }
  render(
    <ToastProvider>
      <Harness kind={kind} message={message} opts={opts} apiRef={apiRef} idRef={idRef} />
    </ToastProvider>,
  )
  return { api: apiRef, id: idRef }
}

describe('ToastProvider — onDismiss callback', () => {
  it('calls onDismiss exactly once when the toast is dismissed', () => {
    const onDismiss = vi.fn()
    const { api, id } = setup('info', 'hello', { durationMs: 0, onDismiss })

    act(() => api.current.dismiss(id.current))
    act(() => api.current.dismiss(id.current)) // second call is a no-op
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('fires onDismiss on the auto-timeout path too', () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    setup('info', 'bye', { durationMs: 1000, onDismiss })

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(onDismiss).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
