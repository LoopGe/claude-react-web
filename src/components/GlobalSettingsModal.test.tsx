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

// api.get is called for /config/full, /mcp-config and /first-party-tools — route by URL.
function mockGet(config: Record<string, unknown>, fpServers: unknown[] = [apptoolsInfo]) {
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url === '/mcp-config') return Promise.resolve({ servers: [] })
    if (url === '/first-party-tools') return Promise.resolve({ servers: fpServers })
    return Promise.resolve(config)
  })
}

// Static registry listing as GET /first-party-tools serves it.
const apptoolsInfo = {
  name: 'apptools',
  description: 'First-party git tools bound to the session cwd',
  tools: [
    { name: 'git_status', description: 'Show git working-tree status.', readOnly: true },
    { name: 'git_stage', description: 'Stage files into the index.', readOnly: false },
  ],
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

  const openMcpTab = async (config: Record<string, unknown>, fpServers?: unknown[]) => {
    mockGet(config, fpServers)
    const { container } = render(
      <ToastProvider>
        <GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />
      </ToastProvider>,
    )
    await waitFor(() => expect(screen.getByText('MCP Servers')).toBeTruthy())
    fireEvent.click(screen.getByText('MCP Servers'))
    return container
  }

  /** The apptools card + its staged ON/OFF toggle, once the section renders. */
  const apptoolsCard = async (container: HTMLElement) => {
    await waitFor(() => expect(container.textContent).toContain('First-party tools'))
    const card = container.querySelector('.settings-first-party-card')
    expect(card, 'first-party card').toBeDefined()
    const toggle = card!.querySelector('.settings-first-party-toggle') as HTMLButtonElement
    expect(toggle, 'first-party ON/OFF toggle').toBeDefined()
    return { card: card!, toggle }
  }

  it('renders one card per first-party server from the config map', async () => {
    const container = await openMcpTab({ firstPartyTools: { apptools: { enabled: true } } })
    const { toggle } = await apptoolsCard(container)
    expect(container.textContent).toContain('apptools')
    expect(toggle.textContent).toBe('ON')
  })

  it('stages toggles locally and saves the structured key on Save', async () => {
    const container = await openMcpTab({ firstPartyTools: { apptools: { enabled: true } } })
    const { toggle } = await apptoolsCard(container)

    fireEvent.click(toggle)
    // Staged — nothing hits the network until Save.
    expect(api.put).not.toHaveBeenCalled()
    expect(toggle.textContent).toBe('OFF')

    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(vi.mocked(api.put)).toHaveBeenCalledWith(
      '/config',
      expect.objectContaining({ firstPartyTools: { apptools: { enabled: false } } }),
    )
  })

  it('expands the static tool listing on "List tools" (read-only badge on git_status)', async () => {
    const container = await openMcpTab({ firstPartyTools: { apptools: { enabled: true } } })
    const { card } = await apptoolsCard(container)
    expect(container.textContent).not.toContain('git_status')

    const listBtn = [...card.querySelectorAll('button')].find((b) => b.textContent === 'List tools')
    expect(listBtn, 'List tools button').toBeDefined()
    fireEvent.click(listBtn!)

    await waitFor(() => expect(container.textContent).toContain('git_status'))
    expect(container.textContent).toContain('git_stage')
    expect(card.querySelector('.settings-tag.readonly')).toBeDefined()
  })

  it('hides the section when the global map is empty', async () => {
    const container = await openMcpTab({ firstPartyTools: {} })
    await waitFor(() => expect(screen.getByText('MCP Servers')).toBeTruthy())
    expect(container.textContent).not.toContain('First-party tools')
  })
})

describe('GlobalSettingsModal Server tab', () => {
  beforeEach(() => {
    vi.mocked(api.put).mockResolvedValue({})
  })

  const openServerTab = async (config: Record<string, unknown>) => {
    mockGet(config)
    render(
      <ToastProvider>
        <GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />
      </ToastProvider>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Server' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Server' }))
    // Content is gated on the /config/full fetch — wait for a Server-only control.
    await waitFor(() => expect(screen.getByRole('radiogroup', { name: 'Max group panels' })).toBeTruthy())
  }

  const save = () => fireEvent.click(screen.getByText('Save'))

  it('renders human units, the segmented panel picker, and switch states from config', async () => {
    await openServerTab({
      maxUploadBytes: 30 * 1024 * 1024,
      historyCap: 1000,
      maxGroupPanels: 4,
      workingStuckMs: 3600000,
      showPinnedUserMessage: true,
      autoRecap: false,
      allowSensitivePathEdits: false,
    })

    // Bytes → MB and ms → minutes, with unit suffixes (not raw 31457280 / 3600000).
    expect((screen.getByLabelText('Max upload size, in megabytes') as HTMLInputElement).value).toBe('30')
    expect(screen.getByText('MB')).toBeTruthy()
    expect((screen.getByLabelText('History cap') as HTMLInputElement).value).toBe('1000')
    expect((screen.getByLabelText('Working-stuck timeout, in minutes') as HTMLInputElement).value).toBe('60')
    expect(screen.getByText('min')).toBeTruthy()

    // Max group panels is a segmented picker; the configured value is active.
    expect(screen.getByRole('radio', { name: '4' }).getAttribute('aria-checked')).toBe('true')

    // Booleans render as switches reflecting the loaded values.
    expect(screen.getByRole('switch', { name: 'Show pinned “current question” header' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('switch', { name: 'Auto-generate session recap' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: 'Allow editing sensitive paths in auto-approve modes' }).getAttribute('aria-checked')).toBe('false')
  })

  it('steps History cap by the field step and persists the raw value on Save', async () => {
    await openServerTab({ historyCap: 500 })

    fireEvent.click(screen.getByRole('button', { name: 'Increase History cap' }))
    expect((screen.getByLabelText('History cap') as HTMLInputElement).value).toBe('600')

    save()
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(vi.mocked(api.put)).toHaveBeenCalledWith('/config', expect.objectContaining({ historyCap: 600 }))
  })

  it('converts typed MB back to bytes on Save', async () => {
    await openServerTab({ maxUploadBytes: 25 * 1024 * 1024 })

    fireEvent.change(screen.getByLabelText('Max upload size, in megabytes'), { target: { value: '50' } })

    save()
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(vi.mocked(api.put)).toHaveBeenCalledWith('/config', expect.objectContaining({ maxUploadBytes: 50 * 1024 * 1024 }))
  })

  it('converts typed minutes to ms on Save and keeps 0 = disabled semantics', async () => {
    await openServerTab({ workingStuckMs: 3600000 })

    fireEvent.change(screen.getByLabelText('Working-stuck timeout, in minutes'), { target: { value: '0' } })

    save()
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(vi.mocked(api.put)).toHaveBeenCalledWith('/config', expect.objectContaining({ workingStuckMs: 0 }))
  })

  it('does not alter a value when the field is focused and blurred without editing', async () => {
    await openServerTab({ historyCap: 500 })

    const input = screen.getByLabelText('History cap') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.blur(input)
    expect(input.value).toBe('500')

    save()
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(vi.mocked(api.put)).toHaveBeenCalledWith('/config', expect.objectContaining({ historyCap: 500 }))
  })

  it('restores the previous value when a typed value is cleared', async () => {
    await openServerTab({ historyCap: 500 })

    const input = screen.getByLabelText('History cap') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(input.value).toBe('500')
  })

  it('persists a segmented panel choice and a switch flip', async () => {
    await openServerTab({
      maxGroupPanels: 3,
      showPinnedUserMessage: true,
      autoRecap: true,
      allowSensitivePathEdits: false,
    })

    fireEvent.click(screen.getByRole('radio', { name: '5' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Allow editing sensitive paths in auto-approve modes' }))

    save()
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(vi.mocked(api.put)).toHaveBeenCalledWith('/config', expect.objectContaining({
      maxGroupPanels: 5,
      allowSensitivePathEdits: true,
    }))
  })
})
