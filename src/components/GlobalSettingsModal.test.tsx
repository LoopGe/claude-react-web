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

describe('GlobalSettingsModal Profiles tab', () => {
  it('renders a Profiles tab', async () => {
    mockGet({})
    render(
      <GlobalSettingsModal
        open
        onClose={() => {}}
        onSaved={() => {}}
      />,
    )
    await waitFor(() => expect(screen.getByText('Profiles')).toBeTruthy())
  })
})
