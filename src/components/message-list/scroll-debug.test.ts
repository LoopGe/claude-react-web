// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scrollDebug } from './scroll-debug'
import {
  DEFAULT_TRACE_RECORD_OPTIONS,
  resetTraceDiagnosticsForTests,
  startTraceDiagnostics,
  traceDiagnosticsSnapshot,
} from '../../client-debug/trace-diagnostics'

beforeEach(() => {
  resetTraceDiagnosticsForTests()
  localStorage.clear()
  delete (window as unknown as { __scrollLogV2?: unknown }).__scrollLogV2
  vi.spyOn(console, 'debug').mockImplementation(() => {})
})

afterEach(() => {
  resetTraceDiagnosticsForTests()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('scrollDebug trace forwarding', () => {
  it('does not build a payload while console and Record are both off', () => {
    const payload = vi.fn(() => ({ before: 1 }))
    scrollDebug('pin', payload)

    expect(payload).not.toHaveBeenCalled()
    expect(traceDiagnosticsSnapshot().events).toEqual([])
  })

  it('forwards to Record without enabling console or the legacy in-page mirror', () => {
    startTraceDiagnostics({ ...DEFAULT_TRACE_RECORD_OPTIONS, visual: false })

    scrollDebug('pin', () => ({ before: 10, after: 20 }))

    expect(traceDiagnosticsSnapshot().events).toHaveLength(1)
    expect(traceDiagnosticsSnapshot().events[0]).toMatchObject({
      track: 'scroll',
      name: 'pin',
      args: { before: 10, after: 20 },
    })
    expect(console.debug).not.toHaveBeenCalled()
    expect((window as unknown as { __scrollLogV2?: unknown }).__scrollLogV2).toBeUndefined()
  })

  it('keeps the existing console and mirror behind their own flag', () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 1_000)
    localStorage.setItem('crw:debug:scroll', '1')

    scrollDebug('pin', () => ({ before: 10 }))

    expect(traceDiagnosticsSnapshot().events).toEqual([])
    expect(console.debug).toHaveBeenCalledWith('[scroll] pin', { before: 10 })
    expect((window as unknown as { __scrollLogV2?: unknown[] }).__scrollLogV2).toHaveLength(1)
  })
})
