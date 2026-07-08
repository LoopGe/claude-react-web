import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render as rtlRender, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { ToastProvider } from './ToastProvider'
import { ResetConfigDialog } from './ResetConfigDialog'

function render(ui: React.ReactElement) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>)
}

beforeEach(() => { localStorage.clear() })
afterEach(() => cleanup())

describe('ResetConfigDialog', () => {
  it('renders the three groups and is closed when open=false', () => {
    render(<ResetConfigDialog open={false} onClose={() => {}} />)
    expect(screen.queryByRole('dialog', { name: 'Clear configuration & data' })).toBeNull()
  })

  it('toggles server items and clears them on confirm', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ results: { snippets: { ok: true } }, deletedSessionIds: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    // Keep the dialog mounted after close so we can assert the toast.
    const onClose = vi.fn()
    render(<ResetConfigDialog open onClose={onClose} />)
    fireEvent.click(screen.getByLabelText(/snippets/i))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /clear selected/i }))
    })
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/config/reset'), expect.anything())
    expect(onClose).toHaveBeenCalled()
  })

  it('requires two-step confirm for danger items', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ results: { sessions: { ok: true } }, deletedSessionIds: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    const onClose = vi.fn()
    render(<ResetConfigDialog open onClose={onClose} />)
    fireEvent.click(screen.getByLabelText(/sessions/i))
    // First click does NOT fire the request — enters confirm gate.
    fireEvent.click(screen.getByRole('button', { name: /clear selected/i }))
    expect(fetchMock).not.toHaveBeenCalled()
    // Type 'reset' + confirm.
    fireEvent.change(screen.getByPlaceholderText(/reset/i), { target: { value: 'reset' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
    })
    expect(fetchMock).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('browser-data parent is tri-state over its three children', () => {
    render(<ResetConfigDialog open onClose={() => {}} />)
    const parent = screen.getByRole('checkbox', { name: /browser data/i }) as HTMLInputElement
    const inputHistory = screen.getByRole('checkbox', { name: /input history/i }) as HTMLInputElement
    // Check parent → all children checked.
    fireEvent.click(parent)
    expect(inputHistory.checked).toBe(true)
    // Uncheck one child → parent indeterminate.
    fireEvent.click(inputHistory)
    expect(parent.indeterminate).toBe(true)
  })
})
