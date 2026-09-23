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
const gitToolsStatus = {
  name: 'git-tools',
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
  /** Tab to deep-link into. Defaults to 'mcp' (the historical callers). */
  tab?: 'general' | 'appearance' | 'mcp'
}) {
  return render(
    <ToastProvider>
      <SettingsPanel
        session={opts.session ?? mkSession()}
        globalPrefs={
          {
            showPinnedUserMessage: true,
            autoRecap: true,
            toolGroupCards: true,
            autoExpandRunningGroups: true,
            showMessageHeaders: true,
            ...opts.globalPrefs,
          } as Parameters<typeof SettingsPanel>[0]['globalPrefs']
        }
        onClose={() => {}}
        onSessionUpdate={() => {}}
        tabRequest={{ tab: opts.tab ?? 'mcp', nonce: 1 }}
      />
    </ToastProvider>,
  )
}

/** The action button (Enable/Disable) of the git-tools card, once the section
 *  renders. Mirrors the MCP server card, so the label is state-dependent. */
async function findApptoolsAction(container: HTMLElement) {
  await waitFor(() => expect(container.textContent).toContain('git-tools'))
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
      if (url.endsWith('/tools')) return Promise.resolve({ tools: [gitToolsStatus] })
      if (url === '/profiles') return Promise.resolve({ profiles: [] })
      if (url === '/config') return Promise.resolve({ models: [] })
      return Promise.resolve({})
    })
  })

  it('inherits from the global firstPartyTools map when no session override exists', async () => {
    // Global default OFF must win over the stale live status (enabled: true).
    const { container } = renderPanel({
      session: mkSession(),
      globalPrefs: { firstPartyTools: { 'git-tools': { enabled: false } } },
    })
    await expect(findApptoolsAction(container)).resolves.toBe('Enable')
  })

  it('prefers a session override over the global map', async () => {
    const { container } = renderPanel({
      session: mkSession({ 'git-tools': true }),
      globalPrefs: { firstPartyTools: { 'git-tools': { enabled: false } } },
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
    await waitFor(() => expect(container.textContent).toContain('git-tools'))
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
                toolGroupCards: true,
                autoExpandRunningGroups: true,
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
    await waitFor(() => expect(container.textContent).toContain('git-tools'))
    const card = container.querySelector('.settings-first-party-card')!
    const disable = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Disable')
    expect(disable, 'Disable action').toBeDefined()
    fireEvent.click(disable!)

    await waitFor(() => expect(card.querySelector('.settings-card-pending')).toBeDefined())

    // Release the round-trip inside act so the response is applied: the
    // returned session carries the override, so the card must flip to Enable
    // and expose the Reset (inherit global) link.
    await act(async () => {
      release({ session: mkSession({ 'git-tools': false }) })
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
    toolGroupCards: true,
    autoExpandRunningGroups: true,
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

describe('SettingsPanel Appearance tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.endsWith('/mcp-status')) return Promise.resolve({ mcp: [] })
      if (url.endsWith('/tools')) return Promise.resolve({ tools: [] })
      if (url === '/mcp-config') return Promise.resolve({ servers: [] })
      if (url === '/profiles') return Promise.resolve({ profiles: [] })
      if (url === '/config') return Promise.resolve({ models: [] })
      return Promise.resolve({})
    })
    vi.mocked(api.post).mockResolvedValue({ session: mkSession() })
  })

  // NOTE: scoped to the returned `container`, never document-wide `screen`.
  // Every test's render is torn down by the global hook in src/test-setup.ts,
  // so this is house style rather than a workaround — a `screen` query is just
  // less clear about which panel it means.
  const switchEl = (container: HTMLElement, label: string) =>
    container.querySelector(`button[aria-label="${label}"]`)

  /** Every per-session override row, paired with the pref key its switch must
   *  write. Labels here carry NO curly quotes (unlike the global modal's
   *  "Show pinned “current question” header"). */
  const OVERRIDES = [
    ['Show pinned current question header', 'showPinnedUserMessage'],
    ['Auto-generate session recap', 'autoRecap'],
    ['Use collapsible tool-group cards', 'toolGroupCards'],
    ['Show message card headers', 'showMessageHeaders'],
  ] as const

  it('renders every override row and posts each one under its own key', async () => {
    const { container } = renderPanel({ tab: 'appearance' })

    // Each switch reflects the inherited global default (globalPrefs are all
    // true) because the session carries no override.
    await waitFor(() => expect(switchEl(container, OVERRIDES[0][0])).not.toBeNull())
    for (const [label] of OVERRIDES) {
      expect(switchEl(container, label)!.getAttribute('aria-checked')).toBe('true')
    }

    // Toggling writes THAT row's key — a copy-paste handler that reports the
    // wrong pref fails here.
    for (const [label, key] of OVERRIDES) {
      fireEvent.click(switchEl(container, label)!)
      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith('/sessions/s1/prefs', { [key]: false }))
    }
  })

  it('no longer renders the display overrides on the General tab', async () => {
    const { container } = renderPanel({ tab: 'general' })
    await waitFor(() => expect(container.textContent).toContain('Live controls'))

    // Moved, not duplicated.
    expect(switchEl(container, 'Auto-generate session recap')).toBeNull()
    expect(switchEl(container, 'Show message card headers')).toBeNull()
  })

  describe('auto-expand-running-groups sub-setting', () => {
    const SUB_LABEL = 'Auto-expand running groups'

    it('renders indented under its parent and posts its own key', async () => {
      const { container } = renderPanel({ tab: 'appearance' })
      await waitFor(() => expect(switchEl(container, SUB_LABEL)).not.toBeNull())

      const row = switchEl(container, SUB_LABEL)!.closest('.settings-row')!
      expect(row.classList.contains('settings-row-sub')).toBe(true)
      expect(switchEl(container, SUB_LABEL)!.getAttribute('aria-checked')).toBe('true')

      fireEvent.click(switchEl(container, SUB_LABEL)!)
      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith('/sessions/s1/prefs', { autoExpandRunningGroups: false }))
    })

    it('inherits the global default and reports it in the hint', async () => {
      const { container } = renderPanel({
        tab: 'appearance',
        globalPrefs: { autoExpandRunningGroups: false },
      })
      await waitFor(() => expect(switchEl(container, SUB_LABEL)).not.toBeNull())
      expect(switchEl(container, SUB_LABEL)!.getAttribute('aria-checked')).toBe('false')
      expect(container.textContent).toContain('Inheriting global (OFF).')
    })

    it('shows a session override with a reset link that clears it', async () => {
      const { container } = renderPanel({
        tab: 'appearance',
        session: { id: 's1', running: true, terminated: false, autoExpandRunningGroups: false } as unknown as SessionInfo,
      })
      await waitFor(() => expect(switchEl(container, SUB_LABEL)).not.toBeNull())
      expect(container.textContent).toContain('Session override.')

      const reset = [...container.querySelectorAll('.settings-reset-link')].find(
        (b) => b.textContent === 'Reset (inherit global)',
      )!
      fireEvent.click(reset)
      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith('/sessions/s1/prefs', { autoExpandRunningGroups: null }))
    })

    it('hides the sub-row while the effective parent is off', async () => {
      const { container } = renderPanel({ tab: 'appearance', globalPrefs: { toolGroupCards: false } })
      await waitFor(() => expect(switchEl(container, 'Use collapsible tool-group cards')).not.toBeNull())
      expect(switchEl(container, SUB_LABEL)).toBeNull()
    })

    it('keeps the sub-row when a session override re-enables the parent', async () => {
      // The gate reads the EFFECTIVE parent, not the session field: a session
      // pinning toolGroupCards=true while the global default is off still has
      // collapsible cards, so the sub-setting must stay reachable.
      const { container } = renderPanel({
        tab: 'appearance',
        session: { id: 's1', running: true, terminated: false, toolGroupCards: true } as unknown as SessionInfo,
        globalPrefs: { toolGroupCards: false },
      })
      await waitFor(() => expect(switchEl(container, SUB_LABEL)).not.toBeNull())
    })
  })
})

describe('SettingsPanel MCP source grouping', () => {
  const globalPrefs = {
    showPinnedUserMessage: true,
    autoRecap: true,
    toolGroupCards: true,
    autoExpandRunningGroups: true,
  } as Parameters<typeof SettingsPanel>[0]['globalPrefs']

  const mkServer = (over: Record<string, unknown>) =>
    ({ status: 'connected', tools: [{ name: 'a_tool', description: 'A tool.' }], ...over })

  /** The three canonical provenances plus the dual one: global-server is in
   *  the global library, scoped-server reports a CLI config scope, and
   *  session-server has neither marker (inline / agent-definition injection). */
  const servers = [
    mkServer({ name: 'global-server' }),
    mkServer({ name: 'scoped-server', source: 'project' }),
    mkServer({ name: 'session-server' }),
    mkServer({ name: 'dual-server', source: 'user' }),
  ]

  /** Render the session panel on its MCP tab. `mcpServers` feeds the default
   *  /mcp-status stub; `urlOverrides` swaps any endpoint's payload — an Error
   *  value rejects, a Promise value is returned as-is (for held-pending
   *  assertions), anything else resolves — so each test pins only what
   *  differs from the default table. `session` overrides the default. */
  function renderGroupedPanel(
    mcpServers: Record<string, unknown>[],
    urlOverrides: Record<string, unknown> = {},
    session: SessionInfo = mkSession(),
  ) {
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      for (const [match, payload] of Object.entries(urlOverrides)) {
        if (url === match || url.endsWith(match)) {
          if (payload instanceof Error) return Promise.reject(payload)
          if (payload instanceof Promise) return payload
          return Promise.resolve(payload)
        }
      }
      if (url.endsWith('/mcp-status')) return Promise.resolve({ mcp: mcpServers })
      if (url.endsWith('/tools')) return Promise.resolve({ tools: [] })
      if (url === '/mcp-config')
        return Promise.resolve({ servers: [{ name: 'global-server' }, { name: 'dual-server' }] })
      if (url === '/profiles') return Promise.resolve({ profiles: [] })
      if (url === '/config') return Promise.resolve({ models: [] })
      return Promise.resolve({})
    })
    return render(
      <ToastProvider>
        <SettingsPanel
          session={session}
          globalPrefs={globalPrefs}
          onClose={() => {}}
          onSessionUpdate={() => {}}
          tabRequest={{ tab: 'mcp', nonce: 1 }}
        />
      </ToastProvider>,
    )
  }

  /** The `.settings-group` box whose head title matches exactly, or null when
   *  the box is (correctly) not rendered. */
  const findGroup = (container: HTMLElement, title: string) =>
    [...container.querySelectorAll('.settings-group')].find(
      (g) => g.querySelector('.settings-group-head h4')?.textContent === title,
    )

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('boxes each provenance into its own group', async () => {
    const { container } = renderGroupedPanel(servers)

    await waitFor(() => expect(container.textContent).toContain('session-server'))

    const globalGroup = findGroup(container, 'Global config')
    const cliGroup = findGroup(container, 'CLI-discovered')
    const sessionGroup = findGroup(container, 'Session only')
    expect(globalGroup, 'Global config box').toBeDefined()
    expect(cliGroup, 'CLI-discovered box').toBeDefined()
    expect(sessionGroup, 'Session only box').toBeDefined()

    // Each card lands in exactly one box.
    expect(globalGroup!.textContent).toContain('global-server')
    expect(cliGroup!.textContent).toContain('scoped-server')
    expect(sessionGroup!.textContent).toContain('session-server')
    expect(globalGroup!.textContent).not.toContain('scoped-server')
    expect(globalGroup!.textContent).not.toContain('session-server')
    expect(cliGroup!.textContent).not.toContain('global-server')
  })

  it('keeps a dual-provenance server in the Global box with both badges', async () => {
    const { container } = renderGroupedPanel(servers)
    await waitFor(() => expect(container.textContent).toContain('dual-server'))

    const globalGroup = findGroup(container, 'Global config')!
    expect(globalGroup.textContent).toContain('dual-server')
    const card = [...globalGroup.querySelectorAll('.settings-card')].find((c) =>
      c.textContent?.includes('dual-server'),
    )!
    expect(card.querySelector('.settings-card-badge.global'), 'global badge').toBeDefined()
    expect(card.querySelector('.settings-card-badge.scope'), 'scope badge').toBeDefined()
    // dual-server must NOT have been partitioned into the CLI-discovered box.
    expect(findGroup(container, 'CLI-discovered')!.textContent).not.toContain('dual-server')
  })

  it('stamps source-tone badges per provenance', async () => {
    const { container } = renderGroupedPanel(servers)
    await waitFor(() => expect(container.textContent).toContain('session-server'))

    const sessionCard = [...container.querySelectorAll('.settings-card')].find((c) =>
      c.textContent?.includes('session-server'),
    )!
    expect(sessionCard.querySelector('.settings-card-badge.session'), 'session badge').toBeDefined()

    const scopedCard = [...container.querySelectorAll('.settings-card')].find((c) =>
      c.textContent?.includes('scoped-server'),
    )!
    expect(scopedCard.querySelector('.settings-card-badge.scope'), 'scope badge').toBeDefined()
    expect(scopedCard.querySelector('.settings-card-badge.global')).toBeNull()
  })

  it('renders no provenance boxes when nothing has a source marker', async () => {
    const { container } = renderGroupedPanel([mkServer({ name: 'session-server' })])
    await waitFor(() => expect(container.textContent).toContain('session-server'))

    expect(findGroup(container, 'Global config')).toBeUndefined()
    expect(findGroup(container, 'CLI-discovered')).toBeUndefined()
    // The one non-empty box still renders, and no "No MCP servers" empty state
    // (the effective list is not empty).
    expect(findGroup(container, 'Session only')).toBeDefined()
    expect(container.textContent).not.toContain('No MCP servers')
  })

  it('shows the empty state only when the whole external list is empty', async () => {
    const { container } = renderGroupedPanel([])
    await waitFor(() => expect(container.textContent).toContain('No MCP servers'))

    expect(findGroup(container, 'Global config')).toBeUndefined()
    expect(findGroup(container, 'CLI-discovered')).toBeUndefined()
    expect(findGroup(container, 'Session only')).toBeUndefined()
  })

  it('does not flash mislabeled boxes while the global-names fetch is in flight', async () => {
    // Hold /mcp-config pending forever: until global membership is known, a
    // source-less server must NOT be by-elimination labeled "Session only —
    // not persisted" (it may well be a global-library server). The tab shows
    // the skeleton instead, then the boxes appear once the names settle.
    let releaseGlobalNames!: (value: unknown) => void
    const pendingGlobalNames = new Promise((res) => {
      releaseGlobalNames = res
    })
    const { container } = renderGroupedPanel(
      [mkServer({ name: 'global-server' })],
      { '/mcp-config': pendingGlobalNames },
      { id: 's1', running: true, terminated: false, mcpServerNames: ['global-server'] } as unknown as SessionInfo,
    )

    // No boxes (and no cards) before the names settle — the skeleton holds.
    await waitFor(() => expect(container.querySelector('.skeleton-group')).not.toBeNull())
    expect(findGroup(container, 'Session only')).toBeUndefined()
    expect(findGroup(container, 'Global config')).toBeUndefined()
    expect(container.textContent).not.toContain('global-server')

    await act(async () => {
      releaseGlobalNames({ servers: [{ name: 'global-server' }] })
    })
    await waitFor(() => expect(container.textContent).toContain('global-server'))
    expect(findGroup(container, 'Global config')!.textContent).toContain('global-server')
    expect(findGroup(container, 'Session only')).toBeUndefined()
  })

  it('reaches the empty state on a dormant session instead of sticking on the skeleton', async () => {
    // Non-running sessions never fetch mcp-status (the server 410s it), so
    // loadingMeta must settle through the not-running branch — previously it
    // held the skeleton forever and "No MCP servers" was unreachable. The
    // store mock is deliberately NON-empty: the "Available from global
    // config" section must stay hidden by the session.running gate (without
    // it, the Add buttons would render on a dormant session and every click
    // would POST into a 410) — an empty store would pass for the wrong
    // reason.
    const { container } = renderGroupedPanel(
      [],
      { '/mcp-config': { servers: [{ name: 'global-server' }] } },
      { id: 's1', running: false, terminated: false } as unknown as SessionInfo,
    )
    await waitFor(() => expect(container.textContent).toContain('No MCP servers'))
    expect(container.querySelector('.skeleton-group')).toBeNull()
    // The Add list stays dormant-session territory: no buttons that would
    // only ever POST into a 410.
    expect(container.textContent).not.toContain('Available from global config')
  })

  it('keeps a globally-defined-but-disabled server in the Global box', async () => {
    // The session stays connected to a server that was later disabled in the
    // global library: the partition must consult the full defined-name set,
    // not the enabled-only one, or the card would be mislabeled "Session
    // only — not persisted". The enabled-only filter still governs the
    // Available list (no Add button for a disabled server).
    const { container } = renderGroupedPanel(
      [mkServer({ name: 'disabled-global' })],
      { '/mcp-config': { servers: [{ name: 'disabled-global', enabled: false }] } },
    )
    await waitFor(() => expect(container.textContent).toContain('disabled-global'))

    const globalGroup = findGroup(container, 'Global config')!
    expect(globalGroup, 'Global config box').toBeDefined()
    expect(globalGroup.textContent).toContain('disabled-global')
    expect(findGroup(container, 'Session only')).toBeUndefined()
    expect(container.textContent).not.toContain('Available from global config')
  })

  it('falls back to one neutral ungrouped box when the global store read fails', async () => {
    // Provenance must not be partitioned on empty name sets — that would
    // affirmatively mislabel every global-library server as "Session only —
    // not persisted". The fallback box groups everything and suppresses the
    // by-elimination session badge.
    const { container } = renderGroupedPanel(
      [mkServer({ name: 'mystery-server' }), mkServer({ name: 'scoped-server', source: 'project' })],
      { '/mcp-config': new Error('store unreadable') },
    )
    await waitFor(() => expect(container.textContent).toContain('mystery-server'))

    expect(findGroup(container, 'Global config')).toBeUndefined()
    expect(findGroup(container, 'CLI-discovered')).toBeUndefined()
    expect(findGroup(container, 'Session only')).toBeUndefined()
    const fallback = findGroup(container, 'All servers')!
    expect(fallback, 'fallback box').toBeDefined()
    expect(fallback.textContent).toContain('mystery-server')
    expect(fallback.textContent).toContain('scoped-server')
    const mysteryCard = [...fallback.querySelectorAll('.settings-card')].find((c) =>
      c.textContent?.includes('mystery-server'),
    )!
    expect(mysteryCard.querySelector('.settings-card-badge.session')).toBeNull()
  })

  it('keeps an sdk-source server out of the CLI-discovered box', async () => {
    // source==='sdk' marks a host-registered in-process server, not a CLI
    // config scope — the CLI-discovered head would contradict the card's
    // own in-process badge.
    const { container } = renderGroupedPanel([mkServer({ name: 'host-srv', source: 'sdk' })])
    await waitFor(() => expect(container.textContent).toContain('host-srv'))

    expect(findGroup(container, 'CLI-discovered')).toBeUndefined()
    const sessionGroup = findGroup(container, 'Session only')!
    expect(sessionGroup, 'Session only box').toBeDefined()
    const card = [...sessionGroup.querySelectorAll('.settings-card')].find((c) =>
      c.textContent?.includes('host-srv'),
    )!
    expect(card.querySelector('.settings-card-badge.built-in'), 'in-process badge').toBeDefined()
  })

  it('boxes the built-in tools under their own group header', async () => {
    const { container } = renderGroupedPanel([], { '/tools': { tools: [gitToolsStatus] } })
    await waitFor(() => expect(container.textContent).toContain('git-tools'))

    const builtIn = findGroup(container, 'Built-in tools')
    expect(builtIn, 'Built-in tools box').toBeDefined()
    expect(builtIn!.querySelector('.settings-first-party-card')).toBeDefined()
    // The old bare note header is gone — the box head is the only label.
    expect(container.querySelector('.settings-section > .settings-note')).toBeNull()
  })
})
