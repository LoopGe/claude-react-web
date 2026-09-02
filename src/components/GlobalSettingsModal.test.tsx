import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ToastProvider } from './ToastProvider'
import { GlobalSettingsModal } from './GlobalSettingsModal'
import { api } from '../hooks/useApi'

vi.mock('../hooks/useApi', () => ({ api: { get: vi.fn(), put: vi.fn() } }))

// jsdom doesn't implement matchMedia; the modal's height-transition and
// exit-presence hooks probe it. Same stub as SettingsPanel/NewSessionDialog.
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
}))

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

describe('GlobalSettingsModal first-party tools section', () => {
  beforeEach(() => {
    vi.mocked(api.put).mockResolvedValue({})
  })

  const openMcpTab = async (config: Record<string, unknown>) => {
    mockGet(config)
    const { container } = render(
      <ToastProvider>
        <GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />
      </ToastProvider>,
    )
    await waitFor(() => expect(screen.getByText('MCP Servers')).toBeTruthy())
    fireEvent.click(screen.getByText('MCP Servers'))
    return container
  }

  const apptoolsRow = (container: HTMLElement) => {
    const row = container.querySelector('.settings-first-party-row')
    expect(row, 'first-party row').toBeDefined()
    return {
      row: row!,
      checkbox: row!.querySelector('input[type="checkbox"]') as HTMLInputElement,
    }
  }

  it('renders one staged row per first-party server from the config map', async () => {
    const container = await openMcpTab({ firstPartyTools: { apptools: { enabled: true } } })
    await waitFor(() => expect(container.textContent).toContain('First-party tools'))
    expect(container.textContent).toContain('apptools')
    expect(apptoolsRow(container).checkbox.checked).toBe(true)
  })

  it('stages toggles locally and saves the structured key on Save', async () => {
    const container = await openMcpTab({ firstPartyTools: { apptools: { enabled: true } } })
    await waitFor(() => expect(container.textContent).toContain('First-party tools'))

    fireEvent.click(apptoolsRow(container).checkbox)
    // Staged — nothing hits the network until Save.
    expect(api.put).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(vi.mocked(api.put)).toHaveBeenCalledWith(
      '/config',
      expect.objectContaining({ firstPartyTools: { apptools: { enabled: false } } }),
    )
  })

  it('hides the section when the global map is empty', async () => {
    const container = await openMcpTab({ firstPartyTools: {} })
    await waitFor(() => expect(screen.getByText('MCP Servers')).toBeTruthy())
    expect(container.textContent).not.toContain('First-party tools')
  })
})
