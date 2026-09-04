import { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { ToastHost } from './ToastHost'
import { ToastProvider } from './ToastProvider'
import { SettingsPanel } from './SettingsPanel'
import type { SessionInfo } from '../types'

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))

import { api } from '../hooks/useApi'

// jsdom doesn't implement matchMedia; useExitPresence probes it when the
// nested MCP installer closes (reduced-motion check). Same stub as
// NewSessionDialog.test.
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
}))

const mkSession = (firstPartyTools?: Record<string, boolean>) =>
  ({ id: 's1', running: true, terminated: false, firstPartyTools }) as unknown as SessionInfo

// Live server status deliberately says "enabled" in every case below so the
// assertions can distinguish which source the display chain consulted.
const apptoolsStatus = {
  name: 'apptools',
  description: 'First-party git tools bound to the session cwd',
  enabled: true,
  injected: true,
  requiresCwd: true,
  hasCwd: true,
  tools: [
    { name: 'git_status', description: 'Show git working-tree status.', readOnly: true },
    { name: 'git_stage', description: 'Stage files into the index.', readOnly: false },
  ],
}

function renderPanel(opts: {
  session?: SessionInfo
  globalPrefs?: Record<string, unknown>
}) {
  return render(
    <ToastProvider>
      <SettingsPanel
        session={opts.session ?? mkSession()}
        globalPrefs={
          {
            showPinnedUserMessage: true,
            autoRecap: true,
            ...opts.globalPrefs,
          } as Parameters<typeof SettingsPanel>[0]['globalPrefs']
        }
        onClose={() => {}}
        onSessionUpdate={() => {}}
        tabRequest={{ tab: 'mcp', nonce: 1 }}
      />
    </ToastProvider>,
  )
}

/** The action button (Enable/Disable) of the apptools card, once the section
 *  renders. Mirrors the MCP server card, so the label is state-dependent. */
async function findApptoolsAction(container: HTMLElement) {
  await waitFor(() => expect(container.textContent).toContain('apptools'))
  const card = container.querySelector('.settings-first-party-card')
  expect(card, 'first-party card').toBeDefined()
  const action = [...card!.querySelectorAll('button')].find(
    (b) => b.textContent === 'Enable' || b.textContent === 'Disable',
  )
  expect(action, 'first-party Enable/Disable action').toBeDefined()
  return action!.textContent
}

describe('SettingsPanel first-party card display chain', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.endsWith('/mcp-status')) return Promise.resolve({ mcp: [] })
      if (url.endsWith('/tools')) return Promise.resolve({ tools: [apptoolsStatus] })
      if (url === '/profiles') return Promise.resolve({ profiles: [] })
      if (url === '/config') return Promise.resolve({ models: [] })
      return Promise.resolve({})
    })
  })

  it('inherits from the global firstPartyTools map when no session override exists', async () => {
    // Global default OFF must win over the stale live status (enabled: true).
    const { container } = renderPanel({
      session: mkSession(),
      globalPrefs: { firstPartyTools: { apptools: { enabled: false } } },
    })
    await expect(findApptoolsAction(container)).resolves.toBe('Enable')
  })

  it('prefers a session override over the global map', async () => {
    const { container } = renderPanel({
      session: mkSession({ apptools: true }),
      globalPrefs: { firstPartyTools: { apptools: { enabled: false } } },
    })
    await expect(findApptoolsAction(container)).resolves.toBe('Disable')
  })

  it('falls back to the live tool status when the global map lacks the name', async () => {
    const { container } = renderPanel({
      session: mkSession(),
      globalPrefs: { firstPartyTools: {} },
    })
    await expect(findApptoolsAction(container)).resolves.toBe('Disable')
  })

  it('expands the embedded tool listing inline on chevron (read-only badge on git_status)', async () => {
    const { container } = renderPanel({
      session: mkSession(),
      globalPrefs: { firstPartyTools: {} },
    })
    await waitFor(() => expect(container.textContent).toContain('apptools'))
    expect(container.textContent).not.toContain('git_status')

    const card = container.querySelector('.settings-first-party-card')!
    const expand = card.querySelector('button[aria-label="Expand"]') as HTMLButtonElement | null
    expect(expand, 'expand chevron').toBeDefined()
    fireEvent.click(expand!)

    await waitFor(() => expect(container.textContent).toContain('git_status'))
    expect(container.textContent).toContain('git_stage')
    expect(card.querySelector('.settings-tag.readonly')).toBeDefined()
  })

  it('shows a pending spinner while the toggle round-trip is in flight', async () => {
    let release!: (value: unknown) => void
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise((res) => {
          release = res
        }),
    )
    // Stateful wrapper: applies onSessionUpdate responses so the card really
    // reconciles (renderPanel's no-op updater would hide a regression where
    // the toggle response is never reflected in the card state).
    const Harness = () => {
      const [session, setSession] = useState(mkSession())
      return (
        <ToastProvider>
          <SettingsPanel
            session={session}
            globalPrefs={
              {
                showPinnedUserMessage: true,
                autoRecap: true,
                firstPartyTools: {},
              } as Parameters<typeof SettingsPanel>[0]['globalPrefs']
            }
            onClose={() => {}}
            onSessionUpdate={setSession}
            tabRequest={{ tab: 'mcp', nonce: 1 }}
          />
        </ToastProvider>
      )
    }
    const { container } = render(<Harness />)
    await waitFor(() => expect(container.textContent).toContain('apptools'))
    const card = container.querySelector('.settings-first-party-card')!
    const disable = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Disable')
    expect(disable, 'Disable action').toBeDefined()
    fireEvent.click(disable!)

    await waitFor(() => expect(card.querySelector('.settings-card-pending')).toBeDefined())

    // Release the round-trip inside act so the response is applied: the
    // returned session carries the override, so the card must flip to Enable
    // and expose the Reset (inherit global) link.
    await act(async () => {
      release({ session: mkSession({ apptools: false }) })
    })
    expect(card.querySelector('.settings-card-pending')).toBeNull()
    expect([...card.querySelectorAll('button')].some((b) => b.textContent === 'Enable')).toBe(true)
    expect(card.textContent).toContain('Reset (inherit global)')
  })
})

describe('SettingsPanel MCP reconnect feedback', () => {
  const filesystemServer = {
    name: 'filesystem',
    status: 'connected',
    tools: [{ name: 'read_file', description: 'Read a file.' }],
  }

  const globalPrefs = {
    showPinnedUserMessage: true,
    autoRecap: true,
  } as Parameters<typeof SettingsPanel>[0]['globalPrefs']

  /** Render the session panel on its MCP tab with a ToastHost mounted under
   *  the same provider so success/error toasts are asserted via textContent. */
  function renderMcpPanel() {
    return render(
      <ToastProvider>
        <SettingsPanel
          session={mkSession()}
          globalPrefs={globalPrefs}
          onClose={() => {}}
          onSessionUpdate={() => {}}
          tabRequest={{ tab: 'mcp', nonce: 1 }}
        />
        <ToastHost />
      </ToastProvider>,
    )
  }

  function stubMcpStatus(server: { name: string; status: string; tools?: unknown[] }) {
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.endsWith('/mcp-status')) return Promise.resolve({ mcp: [server] })
      if (url.endsWith('/tools')) return Promise.resolve({ tools: [] })
      if (url === '/mcp-config') return Promise.resolve({ servers: [] })
      if (url === '/profiles') return Promise.resolve({ profiles: [] })
      if (url === '/config') return Promise.resolve({ models: [] })
      return Promise.resolve({})
    })
  }

  async function findFilesystemCard(container: HTMLElement) {
    await waitFor(() => expect(container.textContent).toContain('filesystem'))
    const card = [...container.querySelectorAll('.settings-card')].find((c) =>
      c.textContent?.includes('filesystem'),
    )!
    expect(card, 'filesystem card').toBeDefined()
    return card
  }

  function reconnectButton(card: Element) {
    return [...card.querySelectorAll('button')].find((b) => b.textContent === 'Reconnect')
  }

  beforeEach(() => {
    vi.clearAllMocks()
    stubMcpStatus(filesystemServer)
  })

  it('shows an in-flight spinner then a success toast when Reconnect lands', async () => {
    let release!: (value: unknown) => void
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise((res) => {
          release = res
        }),
    )

    const { container } = renderMcpPanel()
    const card = await findFilesystemCard(container)
    const reconnect = reconnectButton(card)
    expect(reconnect, 'Reconnect button').toBeDefined()

    fireEvent.click(reconnect!)
    // The click actually hits the reconnect endpoint for this server.
    expect(api.post).toHaveBeenCalledWith('/sessions/s1/mcp/filesystem/reconnect')

    // In-flight: the card swaps the action buttons for a spinner and the
    // Reconnect button is disabled until the round-trip resolves.
    await waitFor(() => expect(card.querySelector('.settings-card-pending')).toBeDefined())
    expect((reconnectButton(card) as HTMLButtonElement | undefined)?.disabled).toBe(true)

    await act(async () => {
      release({ ok: true })
    })

    await waitFor(() => expect(card.querySelector('.settings-card-pending')).toBeNull())
    await waitFor(() =>
      expect(container.textContent).toContain('Reconnected MCP server "filesystem"'),
    )
    // A confirmed live connection is a genuine success toast.
    expect(container.querySelector('.toast-success')).not.toBeNull()
  })

  it('toasts the server error when the reconnect POST fails', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      Promise.reject(new Error('MCP reconnect failed: Connection closed')),
    )

    const { container } = renderMcpPanel()
    const card = await findFilesystemCard(container)
    const reconnect = reconnectButton(card)
    expect(reconnect, 'Reconnect button').toBeDefined()

    fireEvent.click(reconnect!)

    await waitFor(() =>
      expect(container.textContent).toContain('MCP reconnect failed: Connection closed'),
    )
    // The failure is an error toast, and the spinner is gone once it lands.
    expect(container.querySelector('.toast-error')).not.toBeNull()
    expect(card.querySelector('.settings-card-pending')).toBeNull()
  })

  it('errors rather than claims success when the server still reports failed', async () => {
    // A reconnect that lands back on 'failed' must not toast a green
    // success — report the failure and let the card's red state speak.
    stubMcpStatus({ ...filesystemServer, status: 'failed' })

    const { container } = renderMcpPanel()
    const card = await findFilesystemCard(container)
    const reconnect = reconnectButton(card)
    expect(reconnect, 'Reconnect button').toBeDefined()

    fireEvent.click(reconnect!)

    await waitFor(() =>
      expect(container.textContent).toContain('Reconnect did not restore MCP server "filesystem"'),
    )
    expect(container.querySelector('.toast-error')).not.toBeNull()
    expect(container.querySelector('.toast-success')).toBeNull()
    expect(card.querySelector('.settings-card-pending')).toBeNull()
  })

  it('acknowledges with an info toast when the follow-up status read does not land', async () => {
    // The mount reads already resolved, so make the post-reconnect mcp-status
    // read fail: refreshMcp swallows it and returns undefined (the documented
    // flaky-read branch), and the ack must not over-claim a live connection.
    const { container } = renderMcpPanel()
    const card = await findFilesystemCard(container)
    const reconnect = reconnectButton(card)
    expect(reconnect, 'Reconnect button').toBeDefined()

    ;(api.get as ReturnType<typeof vi.fn>).mockImplementationOnce((url: string) =>
      url.endsWith('/mcp-status')
        ? Promise.reject(new Error('Request timed out after 10s'))
        : Promise.resolve({}),
    )

    fireEvent.click(reconnect!)

    await waitFor(() =>
      expect(container.textContent).toContain('Reconnect requested for MCP server "filesystem"'),
    )
    expect(container.querySelector('.toast-info')).not.toBeNull()
    expect(container.querySelector('.toast-success')).toBeNull()
    expect(card.querySelector('.settings-card-pending')).toBeNull()
  })
})
