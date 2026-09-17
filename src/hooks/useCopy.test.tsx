// @vitest-environment jsdom
//
// Covers the single clipboard layer the whole app copies through.
//
// The behaviours worth pinning beyond "it copies":
//   1. A failed write is REPORTED (false + a toast), not swallowed — including
//      when it settles after the affordance unmounted, which is the normal
//      path for a context-menu item (the menu closes on click). The old
//      implementation never surfaced failure at all, so a user whose clipboard
//      was blocked pasted stale content believing the copy had worked.
//   2. It never REJECTS. Every caller `void`s the promise or branches on the
//      result, and this app records unhandled rejections as crashes — so a
//      rejection here would overwrite the crash report the user was copying.
//   3. The legacy execCommand fallback reports execCommand's boolean instead of
//      claiming success unconditionally, and `allowFallback: false` keeps the
//      destructive caller (Composer's Cut) off that unverifiable signal.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, renderHook, act } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { ToastProvider } from '../components/ToastProvider'
import { useToastList } from './useToast'
import type { Toast } from './toastContext'
import { useCopy, writeClipboard } from './useCopy'

// ─ clipboard plumbing ─────────────────────────────────────────────
// jsdom ships neither `navigator.clipboard` nor a working
// `document.execCommand`, so each case installs the shape it needs and
// `afterEach` puts the originals back.

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

/** Install an arbitrary `navigator.clipboard` value. `undefined` is the
 *  "no clipboard at all" case; `{}` is the "defines clipboard but omits
 *  writeText" case that `writeClipboard`'s typeof guard exists for. */
function stubClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true, writable: true })
}

/** Install a clipboard whose `writeText` is the given stub. */
function stubWriteText(writeText: (text: string) => Promise<void>) {
  stubClipboard({ writeText })
}

/** Stub `document.execCommand`. Records what the fallback textarea actually
 *  carried, so a fallback that copies the wrong (or no) text can't pass by
 *  only ever being asserted as "execCommand was called". */
function stubExecCommand(returnValue: boolean) {
  const carried: string[] = []
  const fn = vi.fn(() => {
    carried.push(document.querySelector('textarea')?.value ?? '')
    return returnValue
  })
  Object.defineProperty(document, 'execCommand', { value: fn, configurable: true, writable: true })
  return { fn, carried }
}

function stubExecCommandThrowing() {
  const fn = vi.fn(() => {
    throw new Error('execCommand unavailable')
  })
  Object.defineProperty(document, 'execCommand', { value: fn, configurable: true, writable: true })
  return fn
}

afterEach(() => {
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(navigator as object, 'clipboard')
  Reflect.deleteProperty(document as object, 'execCommand')
  // Restores the `console.warn` spies. Without this an assertion that throws
  // before its own `mockRestore()` would leave the diagnostics under test
  // stubbed for the rest of the file.
  vi.restoreAllMocks()
})

// ── hook harnesses ──────────────────────────────────────────────────

function wrapper({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>
}

/** useCopy plus the live toast list, so a case can assert the inline
 *  `copied` flag and the failure toast in one pass. */
function useCopyWithToasts() {
  const api = useCopy()
  return { ...api, toasts: useToastList() }
}

/** Bare useCopy, for the case that must render OUTSIDE a ToastProvider
 *  (RootErrorBoundary's crash screen). */
function useBareCopy() {
  return useCopy()
}

/** Swallow the expected `[clipboard] …` diagnostics for one case. `afterEach`
 *  restores them. */
function silenceWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {})
}

// ── a tree whose copy consumer can be unmounted independently ───────
// A context-menu item closes its menu on click, so the write settles after the
// affordance is gone. These let a case assert the failure is still reported.
// The probes are written from effects (never during render) so the tree stays
// pure.

type Probe = {
  toasts: Toast[]
  api: { copy: (getValue: () => string) => Promise<boolean> } | null
}

const probe: Probe = { toasts: [], api: null }

function Recorder() {
  const toasts = useToastList()
  useEffect(() => {
    probe.toasts = toasts
  })
  return null
}

function Consumer() {
  const api = useCopy()
  useEffect(() => {
    probe.api = api
  })
  return null
}

function Tree({ showConsumer }: { showConsumer: boolean }) {
  return (
    <ToastProvider>
      <Recorder />
      {showConsumer && <Consumer />}
    </ToastProvider>
  )
}

// ─ writeClipboard ─────────────────────────────────────────────────

describe('writeClipboard', () => {
  it('writes through navigator.clipboard when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubWriteText(writeText)

    await expect(writeClipboard('hello')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('falls back to execCommand when there is no clipboard at all', async () => {
    stubClipboard(undefined)
    const { fn } = stubExecCommand(true)

    await expect(writeClipboard('hello')).resolves.toBe(true)
    expect(fn).toHaveBeenCalledWith('copy')
  })

  // The guard the docstring calls out: a locked-down webview that defines
  // `navigator.clipboard` but omits `writeText`. Without the typeof check this
  // would throw synchronously and bypass the fallback entirely.
  it('falls back to execCommand when clipboard exists but omits writeText', async () => {
    stubClipboard({})
    const { fn } = stubExecCommand(true)

    await expect(writeClipboard('hello')).resolves.toBe(true)
    expect(fn).toHaveBeenCalledWith('copy')
  })

  it('falls back to execCommand when writeText rejects', async () => {
    stubWriteText(vi.fn().mockRejectedValue(new Error('denied')))
    const { fn } = stubExecCommand(true)
    const warn = silenceWarn()

    await expect(writeClipboard('hello')).resolves.toBe(true)
    expect(fn).toHaveBeenCalledWith('copy')
    // The cause is kept, so a "copy is broken" report has something to work
    // from — the old code dropped it here.
    expect(warn).toHaveBeenCalled()
  })

  // The bug this rewrite fixes: the old fallback fired its success callback
  // unconditionally, so an execCommand that REFUSED the copy still flipped the
  // UI to "Copied!".
  it('reports failure when execCommand refuses the copy', async () => {
    stubClipboard(undefined)
    stubExecCommand(false)

    await expect(writeClipboard('hello')).resolves.toBe(false)
  })

  it('reports failure when execCommand throws', async () => {
    stubClipboard(undefined)
    stubExecCommandThrowing()

    await expect(writeClipboard('hello')).resolves.toBe(false)
  })

  it('removes its fallback textarea even when execCommand throws', async () => {
    stubClipboard(undefined)
    stubExecCommandThrowing()

    await writeClipboard('hello')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('hands the fallback textarea the text it was asked to copy', async () => {
    stubClipboard(undefined)
    const { carried } = stubExecCommand(true)

    await writeClipboard('the exact payload')
    expect(carried).toEqual(['the exact payload'])
  })

  // The destructive caller's guard: the fallback can't verify the write, so a
  // call that would delete text must not be able to reach it.
  describe('allowFallback: false', () => {
    it('refuses instead of falling back when there is no clipboard', async () => {
      stubClipboard(undefined)
      const { fn } = stubExecCommand(true)

      await expect(writeClipboard('hello', { allowFallback: false })).resolves.toBe(false)
      expect(fn).not.toHaveBeenCalled()
    })

    it('still succeeds through a real writeText', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      stubWriteText(writeText)

      await expect(writeClipboard('hello', { allowFallback: false })).resolves.toBe(true)
      expect(writeText).toHaveBeenCalledWith('hello')
    })
  })
})

// ── useCopy ────────────────────────────────────────────────────────

describe('useCopy', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    probe.toasts = []
    probe.api = null
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('flips `copied` for 2s after a successful write', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubWriteText(writeText)
    const { result } = renderHook(useCopyWithToasts, { wrapper })
    expect(result.current.copied).toBe(false)

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.copy(() => 'hello')
    })

    expect(ok).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(result.current.copied).toBe(true)

    act(() => {
      vi.advanceTimersByTime(1999)
    })
    expect(result.current.copied).toBe(true)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current.copied).toBe(false)
  })

  it('leaves `copied` false on a failed write and reports it as a toast', async () => {
    stubWriteText(vi.fn().mockRejectedValue(new Error('denied')))
    stubExecCommand(false)
    silenceWarn()
    const { result } = renderHook(useCopyWithToasts, { wrapper })

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.copy(() => 'hello')
    })

    expect(ok).toBe(false)
    expect(result.current.copied).toBe(false)
    expect(result.current.toasts).toHaveLength(1)
    expect(result.current.toasts[0].kind).toBe('error')
  })

  // Without this, a success followed by a failure leaves "Copied!" lit for the
  // rest of the first copy's 2s window — still claiming the clipboard holds the
  // new value when it holds the old one.
  it('clears a stale `copied` when a later write fails', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubWriteText(writeText)
    silenceWarn()
    const { result } = renderHook(useCopyWithToasts, { wrapper })

    await act(async () => {
      await result.current.copy(() => 'first')
    })
    expect(result.current.copied).toBe(true)

    writeText.mockRejectedValue(new Error('denied'))
    stubExecCommand(false)
    await act(async () => {
      await result.current.copy(() => 'second')
    })

    expect(result.current.copied).toBe(false)
  })

  // A repeat copy must own a FRESH 2s window. Setting an already-true boolean
  // is a React bail-out, so the effect would not re-run and the second copy
  // would inherit the first one's deadline — its confirmation would flash for
  // however little was left.
  it('re-arms the full 2s window on a repeat copy', async () => {
    stubWriteText(vi.fn().mockResolvedValue(undefined))
    const { result } = renderHook(useCopyWithToasts, { wrapper })

    await act(async () => {
      await result.current.copy(() => 'first')
    })
    act(() => {
      vi.advanceTimersByTime(1900)
    })
    expect(result.current.copied).toBe(true)

    await act(async () => {
      await result.current.copy(() => 'second')
    })
    // Past the FIRST copy's deadline, so this can only pass if the window was
    // re-armed.
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(result.current.copied).toBe(true)

    act(() => {
      vi.advanceTimersByTime(1800)
    })
    expect(result.current.copied).toBe(false)
  })

  it('resolves false without toasting when the value is empty', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubWriteText(writeText)
    const { result } = renderHook(useCopyWithToasts, { wrapper })

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.copy(() => '')
    })

    // Nothing to copy is not a clipboard failure — no toast, no write.
    expect(ok).toBe(false)
    expect(writeText).not.toHaveBeenCalled()
    expect(result.current.toasts).toHaveLength(0)
  })

  // A context-menu item closes its menu on click, so the write settles after
  // the affordance is gone. The toast host is global and does not need the
  // consumer alive, so the report must still happen — dropping it there is how
  // the user comes to paste stale content believing the copy worked.
  it('reports a failure that lands after the consumer unmounted', async () => {
    let rejectWrite!: (err: unknown) => void
    stubWriteText(
      vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectWrite = reject
          }),
      ),
    )
    silenceWarn()

    const { rerender } = render(<Tree showConsumer />)
    expect(probe.api).not.toBeNull()

    let pending!: Promise<boolean>
    act(() => {
      pending = probe.api!.copy(() => 'hello')
    })

    rerender(<Tree showConsumer={false} />)

    await act(async () => {
      rejectWrite(new Error('denied'))
      await pending
    })

    expect(probe.toasts.some((t) => t.kind === 'error')).toBe(true)
  })

  // The contract callers rely on (`void copy(...)`, `if (!(await copy(...)))`).
  // A rejection here would reach the app's unhandledrejection listener, which
  // records a crash — clobbering the report the crash screen was copying.
  it('resolves false instead of rejecting when the getter throws', async () => {
    stubWriteText(vi.fn().mockResolvedValue(undefined))
    silenceWarn()
    const { result } = renderHook(useCopyWithToasts, { wrapper })

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.copy(() => {
        throw new Error('cyclic value')
      })
    })

    expect(ok).toBe(false)
    expect(result.current.copied).toBe(false)
    // A throwing getter is a failure, not an empty value: the caller must not
    // be left with silence.
    expect(result.current.toasts).toHaveLength(1)
    expect(result.current.toasts[0].kind).toBe('error')
  })

  // RootErrorBoundary renders its crash screen ABOVE ToastProvider, so
  // `useToast()` would throw there. Reading the show-only context directly
  // (null outside a provider) is what keeps that surface working.
  it('does not throw when rendered outside a ToastProvider', async () => {
    stubWriteText(vi.fn().mockRejectedValue(new Error('denied')))
    stubExecCommand(false)
    silenceWarn()
    const { result } = renderHook(useBareCopy)

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.copy(() => 'hello')
    })

    expect(ok).toBe(false)
    expect(result.current.copied).toBe(false)
  })

  it('clears the in-flight reset timer on unmount', async () => {
    stubWriteText(vi.fn().mockResolvedValue(undefined))
    const { result, unmount } = renderHook(useCopyWithToasts, { wrapper })

    await act(async () => {
      await result.current.copy(() => 'hello')
    })
    // A successful copy shows no toast, so the 2s reset is the only timer.
    expect(vi.getTimerCount()).toBe(1)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})