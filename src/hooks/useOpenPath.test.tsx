// Unit tests for useOpenPath — the shared launch helper behind the project
// popover buttons and the session context-menu "Open in …" items. It owns
// the in-flight guard (one launch at a time per consumer) and normalizes
// transport failures into a plain outcome so callers choose their own
// presentation (inline error vs toast).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup, waitFor, act } from '@testing-library/react'
import { useState } from 'react'

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }))

vi.mock('../hooks/useApi', () => ({ api: { get: vi.fn(), post: postMock } }))

const { useOpenPath } = await import('./useOpenPath')

interface Outcome {
  ok: boolean
  message?: string
}

/** Renders the hook state into the DOM; button click drives `open`. */
function Harness({ path }: { path: string }) {
  const { open, pending } = useOpenPath()
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  return (
    <div>
      <div data-testid="pending">{pending ?? 'idle'}</div>
      <button
        type="button"
        onClick={async () => {
          const o = await open('vscode', path)
          setOutcome(o)
        }}
      >
        open
      </button>
      <div data-testid="outcome">{outcome === null ? 'none' : outcome.ok ? 'ok' : `fail:${outcome.message}`}</div>
    </div>
  )
}

beforeEach(() => {
  postMock.mockReset()
})

describe('useOpenPath', () => {
  it('POSTs {path, target} and reports success', async () => {
    postMock.mockResolvedValue({ ok: true })
    const { container } = render(<Harness path="/tmp/proj" />)
    await act(async () => {
      container.querySelector('button')!.click()
    })
    expect(postMock).toHaveBeenCalledWith('/open-path', { path: '/tmp/proj', target: 'vscode' })
    expect(document.querySelector('[data-testid="outcome"]')!.textContent).toBe('ok')
  })

  it('exposes the in-flight target while the request is pending', async () => {
    let release!: (v: unknown) => void
    postMock.mockImplementation(() => new Promise((r) => (release = r)))
    const { container } = render(<Harness path="/tmp/proj" />)
    let promise!: Promise<Outcome>
    act(() => {
      promise = (async () => {
        container.querySelector('button')!.click()
        return undefined as never
      })()
    })
    // The click handler runs async; wait a tick for pending to flip.
    await waitFor(() => expect(document.querySelector('[data-testid="pending"]')!.textContent).toBe('vscode'))
    release({ ok: true })
    await waitFor(() => expect(document.querySelector('[data-testid="pending"]')!.textContent).toBe('idle'))
    await promise
    cleanup()
  })

  it('guards two open() calls fired in the same tick (closure-stale pending)', async () => {
    // The in-flight guard must be synchronous: two calls before React commits
    // setPending would both read the stale `pending` from the render closure
    // and both POST — the exact double-launch the hook exists to prevent.
    function SyncDoubleHarness() {
      const { open } = useOpenPath()
      const [, setLog] = useState<string[]>([])
      return (
        <button
          type="button"
          onClick={() => {
            void open('vscode', '/a').then((o) => setLog((l) => [...l, `a:${o.ok ? 'ok' : 'fail'}`]))
            void open('zed', '/b').then((o) => setLog((l) => [...l, `b:${o.ok ? 'ok' : 'fail'}`]))
          }}
        />
      )
    }
    let release!: (v: unknown) => void
    postMock.mockImplementation(() => new Promise((r) => (release = r)))
    const { container } = render(<SyncDoubleHarness />)
    await act(async () => {
      container.querySelector('button')!.click()
    })
    expect(postMock).toHaveBeenCalledTimes(1)
    release({ ok: true })
    cleanup()
  })

  it('refuses a second launch while one is pending (no duplicate POST)', async () => {
    let release!: (v: unknown) => void
    postMock.mockImplementation(() => new Promise((r) => (release = r)))
    function DoubleHarness() {
      const { open, pending } = useOpenPath()
      const [log, setLog] = useState<string[]>([])
      const record = (label: string, o: Outcome) => setLog((l) => [...l, `${label}:${o.ok ? 'ok' : 'fail'}`])
      return (
        <div>
          <div data-testid="pending">{pending ?? 'idle'}</div>
          <button
            type="button"
            onClick={() => void open('vscode', '/a').then((o) => record('first', o))}
          />
          <button
            type="button"
            onClick={() => void open('zed', '/b').then((o) => record('second', o))}
          />
          <div data-testid="log">{log.join(' ')}</div>
        </div>
      )
    }
    const { container } = render(<DoubleHarness />)
    const buttons = container.querySelectorAll('button')
    await act(async () => {
      buttons[0]!.click()
    })
    expect(postMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      buttons[1]!.click()
    })
    expect(postMock).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-testid="log"]')!.textContent).toBe('second:fail')
    release({ ok: true })
    cleanup()
  })

  it('maps a non-2xx refusal to {ok:false} with the server message', async () => {
    postMock.mockRejectedValue(Object.assign(new Error('failed to open /x: boom'), { status: 500 }))
    const { container } = render(<Harness path="/x" />)
    await act(async () => {
      container.querySelector('button')!.click()
    })
    expect(document.querySelector('[data-testid="outcome"]')!.textContent).toContain('fail:')
    expect(document.querySelector('[data-testid="outcome"]')!.textContent).toContain('boom')
  })

  it('maps a transport failure to {ok:false} without throwing', async () => {
    postMock.mockRejectedValue(new TypeError('fetch failed'))
    const { container } = render(<Harness path="/x" />)
    await act(async () => {
      container.querySelector('button')!.click()
    })
    expect(document.querySelector('[data-testid="outcome"]')!.textContent).toContain('fetch failed')
  })
})
