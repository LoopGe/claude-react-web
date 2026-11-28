import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SessionProfileSelect } from './SessionProfileSelect'
import { api } from '../hooks/useApi'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))

vi.mock('../hooks/useProfiles', () => ({ useProfiles: () => ({
  profiles: [
    { id: 'a', name: 'A', isActive: true, baseUrl: '', modelList: [], recapModel: '', commitMessageModel: '' },
    { id: 'b', name: 'B', isActive: false, baseUrl: '', modelList: [], recapModel: '', commitMessageModel: '' },
  ],
  activeProfileId: 'a',
}) }))
vi.mock('../hooks/useApi', () => ({ api: { post: vi.fn() } }))
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
  apiErrorToastOpts: () => undefined,
}))

describe('SessionProfileSelect', () => {
  it('POSTs the chosen profile + apply mode', async () => {
    vi.mocked(api.post).mockResolvedValue({ session: { id: 's1', profileId: 'b' } })
    const onSessionUpdate = vi.fn()
    render(<SessionProfileSelect session={{ id: 's1', profileId: 'a' } as never} onSessionUpdate={onSessionUpdate} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } })
    fireEvent.click(screen.getByText('Restart now'))
    await vi.waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/sessions/s1/profile', { profileId: 'b', apply: 'now' })
    })
  })

  // Regression: a failed switch (e.g. the server's 502 when the restart
  // itself fails) used to be a silently swallowed rejection — the button
  // click had zero visible effect. The error must surface as a toast and the
  // controls must stay usable for a retry.
  it('surfaces a failed switch as an error toast, not silence', async () => {
    toastError.mockClear()
    vi.mocked(api.post).mockRejectedValue(
      Object.assign(new Error('restart failed: API error: 429 quota exceeded'), { status: 502 }),
    )
    const onSessionUpdate = vi.fn()
    render(<SessionProfileSelect session={{ id: 's1', profileId: 'a' } as never} onSessionUpdate={onSessionUpdate} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } })
    fireEvent.click(screen.getByText('Restart now'))
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError.mock.calls[0][0]).toContain('429')
    expect(onSessionUpdate).not.toHaveBeenCalled()
    // Retry stays possible: the in-flight disable is released on failure.
    expect((screen.getByText('Restart now') as HTMLButtonElement).disabled).toBe(false)
  })

  it('disables both actions while the switch is in flight', async () => {
    toastError.mockClear()
    let resolvePost: (v: unknown) => void = () => {}
    vi.mocked(api.post).mockReturnValue(new Promise((r) => { resolvePost = r }) as never)
    render(<SessionProfileSelect session={{ id: 's1', profileId: 'a' } as never} onSessionUpdate={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } })
    fireEvent.click(screen.getByText('Restart now'))
    await vi.waitFor(() => {
      expect((screen.getByText('Restart now') as HTMLButtonElement).disabled).toBe(true)
    })
    expect((screen.getByText('Apply next restart') as HTMLButtonElement).disabled).toBe(true)
    resolvePost({ session: { id: 's1', profileId: 'b' } })
    // The action row survives here (the mocked onSessionUpdate never updates
    // the session prop), so the button MUST exist and be re-enabled — a
    // busy latch stuck true after success is a real regression.
    await vi.waitFor(() => {
      expect((screen.getByText('Restart now') as HTMLButtonElement).disabled).toBe(false)
    })
  })
})
