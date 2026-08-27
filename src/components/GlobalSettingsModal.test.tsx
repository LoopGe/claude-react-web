import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { GlobalSettingsModal } from './GlobalSettingsModal'
import { api } from '../hooks/useApi'

vi.mock('../hooks/useApi', () => ({ api: { get: vi.fn(), put: vi.fn() } }))

afterEach(() => { cleanup() })

// api.get is called for both /config/full and /mcp-config — route by URL.
function mockGet(config: Record<string, unknown>) {
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url === '/mcp-config') return Promise.resolve({ servers: [] })
    return Promise.resolve(config)
  })
}

describe('GlobalSettingsModal Model Groups tab', () => {
  it('lists a Model Groups tab', async () => {
    mockGet({ modelList: ['m1'], modelGroups: [] })
    render(
      <GlobalSettingsModal
        open
        onClose={() => {}}
        onSaved={() => {}}
      />,
    )
    await waitFor(() => expect(screen.getByText('Model Groups')).toBeTruthy())
  })

  it('PUTs modelGroups on save', async () => {
    mockGet({
      modelList: ['m1'],
      modelGroups: [{ id: 'g1', name: 'G1', opus: 'm1', main: 'opus' }],
    })
    vi.mocked(api.put).mockResolvedValue({ ok: true })
    render(<GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />)
    await waitFor(() => expect(screen.getAllByText('Model Groups').length).toBeGreaterThan(0))
    // Save button — the modal footer's primary action.
    const save = screen.getByRole('button', { name: /save/i })
    save.click()
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        '/config',
        expect.objectContaining({ modelGroups: [{ id: 'g1', name: 'G1', opus: 'm1', main: 'opus' }] }),
      ),
    )
  })
})
