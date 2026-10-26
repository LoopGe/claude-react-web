import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ToastProvider } from './ToastProvider'
import { GlobalSettingsModal } from './GlobalSettingsModal'
import { api } from '../hooks/useApi'
import type { UpdateInfo } from '../../shared/update-info'
import type { RemoteSearchHit } from '../../shared/skills'

vi.mock('../hooks/useApi', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }))

// jsdom doesn't implement matchMedia; the modal's height-transition and
// exit-presence hooks probe it. Same stub as SettingsPanel/NewSessionDialog.
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
}))

afterEach(() => { cleanup() })

// api.get is called for /config/full, /mcp-config and /first-party-tools — route by URL.
function mockGet(config: Record<string, unknown>, fpServers: unknown[] = [gitToolsInfo], searchSkills: RemoteSearchHit[] = []) {
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url === '/mcp-config') return Promise.resolve({ servers: [] })
    if (url === '/first-party-tools') return Promise.resolve({ servers: fpServers })
    // LogsTab is reachable by landing on the System group's first leaf, so
    // the /log shape it reads at mount must always be present.
    if (url === '/log') return Promise.resolve({ level: 'info', availableLevels: ['error', 'warn', 'info', 'debug', 'trace'] })
    if (url === '/log/file') return Promise.resolve({ enabled: false, path: null })
    // Catalog search — distinct from the installed-list fetch (/skills?…)
    // only by the `/search` segment, so match it before any /skills fallthrough.
    if (url.startsWith('/skills/search')) return Promise.resolve({ skills: searchSkills })
    return Promise.resolve(config)
  })
}

// Static registry listing as GET /first-party-tools serves it.
const gitToolsInfo = {
  name: 'git-tools',
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

describe('GlobalSettingsModal host-capability gating', () => {
  afterEach(() => {
    delete (window as { __CRW_DESKTOP__?: unknown }).__CRW_DESKTOP__
  })

  it('shows the "Open on phone" tab on the web host', async () => {
    mockGet({})
    render(<GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />)
    // "Open on phone" lives in the System group now — open the group first.
    await waitFor(() => expect(screen.getByText('System')).toBeTruthy())
    fireEvent.click(screen.getByText('System'))
    await waitFor(() => expect(screen.getByText('Open on phone')).toBeTruthy())
  })

  it('hides the "Open on phone" tab inside the desktop host', async () => {
    ;(window as { __CRW_DESKTOP__?: unknown }).__CRW_DESKTOP__ = { connect: () => {} }
    mockGet({})
    render(<GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />)
    // Wait for the tab bar to render (Profiles is always present)…
    await waitFor(() => expect(screen.getByText('Profiles')).toBeTruthy())
    // …open the System group, then assert the LAN-sharing entry is absent.
    fireEvent.click(screen.getByText('System'))
    expect(screen.queryByText('Open on phone')).toBeNull()
  })

  // AboutTab calls useToast, so it must render inside a ToastProvider.
  const renderAbout = async () => {
    mockGet({})
    render(
      <ToastProvider>
        <GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />
      </ToastProvider>,
    )
    await waitFor(() => expect(screen.getByText('System')).toBeTruthy())
    fireEvent.click(screen.getByText('System'))
    await waitFor(() => expect(screen.getByText('About')).toBeTruthy())
    fireEvent.click(screen.getByText('About'))
  }

  it('keeps the self-update block on the web host About tab', async () => {
    await renderAbout()
    await waitFor(() => expect(screen.getByText('Update registry')).toBeTruthy())
  })

  it('hides the self-update block on the desktop host About tab', async () => {
    ;(window as { __CRW_DESKTOP__?: unknown }).__CRW_DESKTOP__ = { connect: () => {} }
    await renderAbout()
    // The version-info rows still render (Project is static)…
    await waitFor(() => expect(screen.getByText('Project')).toBeTruthy())
    // …but the npm self-update controls are gone.
    expect(screen.queryByText('Update registry')).toBeNull()
    expect(screen.queryByText('Switch version')).toBeNull()
  })
})

describe('GlobalSettingsModal first-party tools section', () => {
  beforeEach(() => {
    vi.mocked(api.put).mockResolvedValue({})
  })

  const openMcpTab = async (config: Record<string, unknown>, fpServers?: unknown[]) => {
    mockGet(config, fpServers)
    render(
      <ToastProvider>
        <GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />
      </ToastProvider>,
    )
    await waitFor(() => expect(screen.getByText('Extensions')).toBeTruthy())
    fireEvent.click(screen.getByText('Extensions'))
    await waitFor(() => expect(screen.getByText('MCP Servers')).toBeTruthy())
    fireEvent.click(screen.getByText('MCP Servers'))
  }

  /** The git-tools card + its staged ON/OFF toggle, once the section renders.
   *  Queried through `screen` / document because the modal portals to body
   *  (Overlay's fixed-backdrop variants always portal — see Overlay.tsx). */
  const gitToolsCard = async () => {
    await waitFor(() => expect(screen.getByText('First-party tools')).toBeTruthy())
    const card = document.querySelector('.settings-first-party-card')
    expect(card, 'first-party card').toBeDefined()
    const toggle = card!.querySelector('.settings-first-party-toggle') as HTMLButtonElement
    expect(toggle, 'first-party ON/OFF toggle').toBeDefined()
    return { card: card!, toggle }
  }

  it('renders one card per first-party server from the config map', async () => {
    await openMcpTab({ firstPartyTools: { 'git-tools': { enabled: true } } })
    const { toggle } = await gitToolsCard()
    expect(screen.getByText('git-tools')).toBeTruthy()
    expect(toggle.textContent).toBe('ON')
  })

  it('stages toggles locally and saves the structured key on Save', async () => {
    await openMcpTab({ firstPartyTools: { 'git-tools': { enabled: true } } })
    const { toggle } = await gitToolsCard()

    fireEvent.click(toggle)
    // Staged — nothing hits the network until Save.
    expect(api.put).not.toHaveBeenCalled()
    expect(toggle.textContent).toBe('OFF')

    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(vi.mocked(api.put)).toHaveBeenCalledWith(
      '/config',
      expect.objectContaining({ firstPartyTools: { 'git-tools': { enabled: false } } }),
    )
  })

  it('expands the static tool listing on "List tools" (read-only badge on git_status)', async () => {
    await openMcpTab({ firstPartyTools: { 'git-tools': { enabled: true } } })
    const { card } = await gitToolsCard()
    expect(screen.queryByText('git_status')).toBeNull()

    const listBtn = [...card.querySelectorAll('button')].find((b) => b.textContent === 'List tools')
    expect(listBtn, 'List tools button').toBeDefined()
    fireEvent.click(listBtn!)

    await waitFor(() => expect(screen.getByText('git_status')).toBeTruthy())
    expect(screen.getByText('git_stage')).toBeTruthy()
    expect(card.querySelector('.settings-tag.readonly')).toBeDefined()
  })

  it('hides the section when the global map is empty', async () => {
    await openMcpTab({ firstPartyTools: {} })
    await waitFor(() => expect(screen.getByText('MCP Servers')).toBeTruthy())
    expect(screen.queryByText('First-party tools')).toBeNull()
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
      // Deliberately the NON-default (true) so this asserts the value came
      // from /config/full rather than the useState(false) initial.
      allowSensitivePathEdits: true,
    })

    // Bytes → MB and ms → minutes, with unit suffixes (not raw 31457280 / 3600000).
    expect((screen.getByLabelText('Max upload size, in megabytes') as HTMLInputElement).value).toBe('30')
    expect(screen.getByText('MB')).toBeTruthy()
    expect((screen.getByLabelText('History cap') as HTMLInputElement).value).toBe('1000')
    expect((screen.getByLabelText('Working-stuck timeout, in minutes') as HTMLInputElement).value).toBe('60')
    expect(screen.getByText('min')).toBeTruthy()

    // Max group panels is a segmented picker; the configured value is active.
    expect(screen.getByRole('radio', { name: '4' }).getAttribute('aria-checked')).toBe('true')

    // The one switch that stays on this tab reflects its loaded value. The
    // display-defaults switches now live on the Appearance tab (covered by
    // the 'Appearance tab' suite below).
    expect(screen.getByRole('switch', { name: 'Allow editing sensitive paths in auto-approve modes' }).getAttribute('aria-checked')).toBe('true')
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

describe('GlobalSettingsModal About tab', () => {
  const INFO: UpdateInfo = {
    current: '0.7.3',
    packageName: 'claude-react-web',
    installMethod: 'global',
    latest: '0.7.3',
    hasUpdate: false,
    source: 'npm',
    checkedAt: 1,
    repoUrl: 'https://github.com/LoopGe/claude-react-web',
  }

  const openAboutTab = async (
    props: Partial<React.ComponentProps<typeof GlobalSettingsModal>> = {},
  ) => {
    mockGet({})
    render(
      <ToastProvider>
        <GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} {...props} />
      </ToastProvider>,
    )
    await waitFor(() => expect(screen.getByText('System')).toBeTruthy())
    fireEvent.click(screen.getByText('System'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'About' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'About' }))
  }

  it("offers the running version's release notes and hands the click to App", async () => {
    const onOpenCurrentReleaseNotes = vi.fn()
    await openAboutTab({ updateInfo: INFO, onOpenCurrentReleaseNotes })

    const entry = await waitFor(() =>
      screen.getByRole('button', { name: "What's new in 0.7.3" }),
    )
    fireEvent.click(entry)
    expect(onOpenCurrentReleaseNotes).toHaveBeenCalledOnce()
  })

  it('hides the entry whenever it could only be a dead end', async () => {
    // Four independent gates, each leaving the entry pointing at a guaranteed
    // failure: a versionless query; a route that refuses while the registry is
    // unconfigured; a build with no parseable GitHub repository (the route's
    // OTHER unconditional refusal, which only the server can see); and a
    // prerelease build, whose notes would be the stable release of the same
    // major.minor.patch because compareSemver ignores the suffix.
    const cases: Array<[string, UpdateInfo | null]> = [
      ['no snapshot yet', null],
      ['update checks disabled', { ...INFO, disabled: true }],
      ['no GitHub repository in this build', { ...INFO, repoUrl: undefined }],
      ['prerelease build', { ...INFO, current: '0.8.0-rc.1' }],
    ]
    for (const [label, info] of cases) {
      cleanup()
      await openAboutTab({ updateInfo: info, onOpenCurrentReleaseNotes: vi.fn() })
      // Prove the tab actually mounted before asserting absence.
      await waitFor(() => expect(screen.getByText('Project')).toBeTruthy())
      expect(screen.queryByText('Release notes'), label).toBeNull()
    }
  })

  it('links the Source row at the server-reported repo, not a build constant', async () => {
    await openAboutTab({ updateInfo: { ...INFO, repoUrl: 'https://github.com/acme/crw' } })
    // The server derives the slug the notes are fetched from; a fork must not
    // be sent to the upstream project's source.
    const link = await waitFor(() => screen.getByText('github.com/acme/crw'))
    expect(link.getAttribute('href')).toBe('https://github.com/acme/crw')
  })
})

describe('GlobalSettingsModal Appearance tab', () => {
  beforeEach(() => {
    vi.mocked(api.put).mockResolvedValue({})
    // mockResolvedValue only sets an implementation — it does NOT clear the
    // call history. Without this, the `waitFor(api.put).toHaveBeenCalled()`
    // gate below is satisfied instantly by an earlier test's PUT.
    vi.mocked(api.put).mockClear()
  })

  /** Every control the move relocates from the Server tab. Used by both the
   *  presence and the absence assertion so the two lists can't drift. */
  const MOVED_SWITCHES = [
    'Show pinned “current question” header',
    'Auto-generate session recap',
    'Use collapsible transcript cards',
    'Show message card headers',
  ] as const
  const MOVED_GROUPS = ['Transcript spacing', 'Message text density', 'Font size', 'Animation speed'] as const

  const openAppearanceTab = async (config: Record<string, unknown>) => {
    mockGet(config)
    render(
      <ToastProvider>
        <GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />
      </ToastProvider>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Appearance' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    // Content is gated on the /config/full fetch — wait for an Appearance-only control.
    await waitFor(() => expect(screen.getByRole('radiogroup', { name: 'Font size' })).toBeTruthy())
  }

  const save = () => fireEvent.click(screen.getByText('Save'))

  /** aria-checked of one option inside a named segmented group. Scoped by the
   *  radiogroup because the two spacing groups reuse the same option labels. */
  const segmentedActive = (group: string, option: string) =>
    within(screen.getByRole('radiogroup', { name: group }))
      .getByRole('radio', { name: option })
      .getAttribute('aria-checked')

  it('renders every moved display default from config', async () => {
    // Every value is deliberately the NON-default so a dropped /config/full
    // mapping can't pass by coinciding with the useState initial value.
    // (useState defaults: all four switches true, spacious/spacious/standard.)
    await openAppearanceTab({
      showPinnedUserMessage: false,
      autoRecap: false,
      toolGroupCards: false,
      showMessageHeaders: false,
      rowGap: 'comfortable',
      textSpacing: 'compact',
      fontSize: 'large',
      animationSpeed: 'fast',
    })

    for (const name of MOVED_SWITCHES) {
      expect(screen.getByRole('switch', { name }).getAttribute('aria-checked')).toBe('false')
    }

    // Each segmented group reflects its configured preset.
    expect(segmentedActive('Transcript spacing', 'Comfortable')).toBe('true')
    expect(segmentedActive('Message text density', 'Compact')).toBe('true')
    expect(segmentedActive('Font size', 'Large')).toBe('true')
    expect(segmentedActive('Animation speed', 'Fast')).toBe('true')
  })

  it('persists a switch flip and a preset change on Save', async () => {
    await openAppearanceTab({
      showPinnedUserMessage: false,
      fontSize: 'standard',
      animationSpeed: 'slow',
    })

    fireEvent.click(screen.getByRole('switch', { name: 'Show pinned “current question” header' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Font size' }))
      .getByRole('radio', { name: 'X-Large' }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Animation speed' }))
      .getByRole('radio', { name: 'Fast' }))

    save()
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(vi.mocked(api.put)).toHaveBeenCalledWith('/config', expect.objectContaining({
      showPinnedUserMessage: true,
      fontSize: 'xlarge',
      animationSpeed: 'fast',
    }))
  })

  it('no longer renders any moved display default on the Server tab', async () => {
    mockGet({})
    render(
      <ToastProvider>
        <GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />
      </ToastProvider>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Server' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Server' }))
    // Prove the tab actually mounted before asserting absence.
    await waitFor(() => expect(screen.getByRole('radiogroup', { name: 'Max group panels' })).toBeTruthy())

    // Moved, not duplicated — every relocated control, not a sample.
    for (const name of MOVED_SWITCHES) {
      expect(screen.queryByRole('switch', { name })).toBeNull()
    }
    for (const name of MOVED_GROUPS) {
      expect(screen.queryByRole('radiogroup', { name })).toBeNull()
    }
  })

  describe('auto-expand-running-groups sub-setting', () => {
    const SUB = 'Auto-expand running groups'

    it('renders as an indented child row and persists its own key', async () => {
      await openAppearanceTab({ toolGroupCards: true, autoExpandRunningGroups: false })
      const sub = screen.getByRole('switch', { name: SUB })
      expect(sub.getAttribute('aria-checked')).toBe('false')
      expect(sub.closest('.settings-row')!.classList.contains('settings-row-sub')).toBe(true)

      fireEvent.click(sub)
      save()
      await waitFor(() => expect(api.put).toHaveBeenCalled())
      expect(vi.mocked(api.put)).toHaveBeenCalledWith('/config', expect.objectContaining({
        autoExpandRunningGroups: true,
      }))
    })

    it('hides the sub-row while the parent is off', async () => {
      await openAppearanceTab({ toolGroupCards: false, autoExpandRunningGroups: true })
      expect(screen.queryByRole('switch', { name: SUB })).toBeNull()
    })

    it('keeps the stored value while hidden and reapplies it when the parent returns', async () => {
      // Turning the parent off must not silently reset the child — the value
      // rides along on Save and the row comes back as it was.
      await openAppearanceTab({ toolGroupCards: true, autoExpandRunningGroups: false })
      fireEvent.click(screen.getByRole('switch', { name: 'Use collapsible transcript cards' }))
      expect(screen.queryByRole('switch', { name: SUB })).toBeNull()

      save()
      await waitFor(() => expect(api.put).toHaveBeenCalled())
      expect(vi.mocked(api.put)).toHaveBeenCalledWith('/config', expect.objectContaining({
        toolGroupCards: false,
        autoExpandRunningGroups: false,
      }))
    })
  })
})

describe('GlobalSettingsModal grouped tab nav', () => {
  const groupBtns = () => [...document.querySelectorAll('.settings-tab-groups button')]
  const leafBtns = () => [...document.querySelectorAll('.settings-tab-leaves button')]

  it('renders three group pills and only the active group’s leaves', async () => {
    mockGet({})
    render(<GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />)
    await waitFor(() => expect(screen.getByText('Profiles')).toBeTruthy())
    expect(groupBtns().map((b) => b.textContent)).toEqual(['General', 'Extensions', 'System'])
    expect(leafBtns().map((b) => b.textContent)).toEqual(['Profiles', 'Server', 'Appearance'])
  })

  it('opens a group on click and lands on its first leaf', async () => {
    mockGet({})
    render(
      <ToastProvider>
        <GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />
      </ToastProvider>,
    )
    await waitFor(() => expect(screen.getByText('Profiles')).toBeTruthy())
    fireEvent.click(groupBtns().find((b) => b.textContent === 'Extensions')!)
    await waitFor(() => expect(screen.getByText('MCP Servers')).toBeTruthy())
    expect(leafBtns().map((b) => b.textContent)).toEqual([
      'Skills', 'MCP Servers', 'Marketplace', 'App Plugins',
    ])
    // The group click must land on the group's FIRST leaf (Skills), not
    // merely render the row.
    expect(document.querySelector('.settings-tab-leaves .active')?.textContent).toBe('Skills')
  })
})

describe('GlobalSettingsModal Skills remote install', () => {
  beforeEach(() => {
    vi.mocked(api.put).mockResolvedValue({})
    vi.mocked(api.put).mockClear()
    vi.mocked(api.post).mockReset()
    vi.mocked(api.get).mockClear()
  })

  /** One skills.sh catalog hit. `skillId` is the clone-relative directory
   *  basename that `matchSearchHit` keys on. */
  const catalogHit = (over: Partial<RemoteSearchHit> = {}): RemoteSearchHit => ({
    id: 'hit-1',
    source: 'org/repo',
    skillId: 'react-helper',
    name: 'react-helper',
    installs: 1234,
    ...over,
  })

  /** Land on the Skills tab (the Extensions group's first leaf) with the
   *  catalog search input on screen, and return that input. */
  const openSkillsTab = async (
    config: Record<string, unknown>,
    searchSkills: RemoteSearchHit[] = [],
  ) => {
    mockGet(config, [gitToolsInfo], searchSkills)
    render(
      <ToastProvider>
        <GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />
      </ToastProvider>,
    )
    await waitFor(() => expect(screen.getByText('Extensions')).toBeTruthy())
    fireEvent.click(screen.getByText('Extensions'))
    await waitFor(() => expect(screen.getByLabelText('Browse skills')).toBeTruthy())
    return screen.getByLabelText('Browse skills') as HTMLInputElement
  }

  /** The remote section only — the "Install from folder" card below it carries
   *  its own Install / Browse / Replace existing controls, so unscoped queries
   *  would happily hit those and pass for the wrong reason. */
  const remote = () => {
    const el = document.querySelector('.settings-skill-remote-group')
    expect(el, 'remote install section').toBeTruthy()
    return within(el as HTMLElement)
  }

  /** GETs of the catalog search (`/skills/search?…`), as opposed to the
   *  installed-list fetch (`/skills` or `/skills?cwd=…`). */
  const searchGets = () =>
    vi.mocked(api.get).mock.calls.filter(([u]) => String(u).startsWith('/skills/search'))
  const listGets = () =>
    vi.mocked(api.get).mock.calls.filter(([u]) => {
      const s = String(u)
      return s === '/skills' || s.startsWith('/skills?')
    })

  it('shows Open repository when the query parses as owner/repo', async () => {
    const input = await openSkillsTab({})
    fireEvent.change(input, { target: { value: 'vercel-labs/agent-skills' } })
    // Parsed from the raw query — not gated on the debounced search.
    const openRepo = remote().getByRole('button', { name: 'Open repository' }) as HTMLButtonElement
    expect(openRepo.disabled).toBe(false)
  })

  it('renders search results with Install buttons', async () => {
    const input = await openSkillsTab({}, [catalogHit()])
    fireEvent.change(input, { target: { value: 'react' } })
    // 300 ms debounce: the wire is still quiet at this instant.
    expect(searchGets()).toHaveLength(0)
    await waitFor(() => expect(remote().getByText('react-helper')).toBeTruthy())
    expect(searchGets()).toHaveLength(1)
    expect(searchGets()[0]![0]).toBe('/skills/search?q=react')
    expect(remote().getByText('org/repo')).toBeTruthy()
    expect(remote().getByText((1234).toLocaleString())).toBeTruthy()
    expect(remote().getByRole('button', { name: 'Install' })).toBeTruthy()
    expect(remote().getByRole('button', { name: 'Browse' })).toBeTruthy()
  })

  it('flips a row to Installed after a successful install', async () => {
    // Preview returns DiscoveredSkill[] — the component must match the hit
    // against THESE, not the SkillRecord[] prop (whose relativePath is
    // cwd-relative to SKILL.md, not a clone-relative directory).
    vi.mocked(api.post).mockImplementation((path: string) => {
      if (path === '/skills/remote/preview') {
        return Promise.resolve({
          source: 'org/repo',
          skills: [{ name: 'react-helper', description: 'Does react things', relativePath: 'skills/react-helper' }],
        })
      }
      return Promise.resolve({
        installed: [{ name: 'react-helper', relativePath: 'skills/react-helper' }],
        failed: [],
      })
    })
    const input = await openSkillsTab({ defaults: { cwd: '/work/proj' } }, [catalogHit()])
    fireEvent.change(input, { target: { value: 'react' } })
    await waitFor(() => expect(remote().getByRole('button', { name: 'Install' })).toBeTruthy())
    const listsBefore = listGets().length

    fireEvent.click(remote().getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(remote().getByText('✓ Installed')).toBeTruthy())
    expect(remote().queryByRole('button', { name: 'Install' })).toBeNull()

    // onInstalled → SkillsTab.refresh(), observable as a second list fetch.
    await waitFor(() => expect(listGets().length).toBeGreaterThan(listsBefore))
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/remote/install', {
      source: 'org/repo',
      scope: 'project',
      cwd: '/work/proj',
      paths: ['skills/react-helper'],
      overwrite: false,
    })
  })

  it('shows the Installed badge only in the scope it was installed to', async () => {
    // Install into Project (the default scope), then flip the Project/User
    // toggle: the badge must not claim the skill is installed in User scope.
    vi.mocked(api.post).mockImplementation((path: string) => {
      if (path === '/skills/remote/preview') {
        return Promise.resolve({
          source: 'org/repo',
          skills: [{ name: 'react-helper', description: 'Does react things', relativePath: 'skills/react-helper' }],
        })
      }
      return Promise.resolve({
        installed: [{ name: 'react-helper', relativePath: 'skills/react-helper' }],
        failed: [],
      })
    })
    const input = await openSkillsTab({ defaults: { cwd: '/work/proj' } }, [catalogHit()])
    fireEvent.change(input, { target: { value: 'react' } })
    await waitFor(() => expect(remote().getByRole('button', { name: 'Install' })).toBeTruthy())
    fireEvent.click(remote().getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(remote().getByText('✓ Installed')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'User' }))
    await waitFor(() => expect(remote().queryByText('✓ Installed')).toBeNull())
    expect(remote().getByRole('button', { name: 'Install' })).toBeTruthy()
  })

  it('heads the catalog section "Browse skills"', async () => {
    await openSkillsTab({})
    // The spec (§1) names the section heading; the search input keeps its
    // own "Browse skills" aria-label.
    expect(screen.getByRole('heading', { name: 'Browse skills' })).toBeTruthy()
  })

  it('shows an inline error when the skill is not found in the repo', async () => {
    // The preview discovers the clone's skills — none of them is this hit.
    vi.mocked(api.post).mockImplementation((path: string) => {
      if (path === '/skills/remote/preview') {
        return Promise.resolve({
          source: 'org/repo',
          skills: [{ name: 'other-skill', description: 'Not the hit', relativePath: 'skills/other-skill' }],
        })
      }
      return Promise.resolve({ installed: [], failed: [] })
    })
    const input = await openSkillsTab({}, [catalogHit()])
    fireEvent.change(input, { target: { value: 'react' } })
    await waitFor(() => expect(remote().getByRole('button', { name: 'Install' })).toBeTruthy())

    fireEvent.click(remote().getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(remote().getByText(/Not found in/)).toBeTruthy())
    expect(remote().getByText('Not found in org/repo')).toBeTruthy()
    // Browse stays the way into the repo — never disabled by a failed match.
    expect((remote().getByRole('button', { name: 'Browse' }) as HTMLButtonElement).disabled).toBe(false)
    // Only the preview went out; a miss never reaches /install.
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/remote/preview', { source: 'org/repo' })
    expect(vi.mocked(api.post)).not.toHaveBeenCalledWith('/skills/remote/install', expect.anything())
  })

  /** Two previewed skills for the batch picker — distinct name, description
   *  and relativePath so selection (keyed by relativePath) is observable. */
  const stubTwoSkillPreview = (install?: (path: string) => unknown) => {
    vi.mocked(api.post).mockImplementation((path: string) => {
      if (path === '/skills/remote/preview') {
        return Promise.resolve({
          source: 'org/repo',
          skills: [
            { name: 'alpha-skill', description: 'Does alpha things', relativePath: 'skills/alpha-skill' },
            { name: 'beta-skill', description: 'Does beta things', relativePath: 'skills/beta-skill' },
          ],
        })
      }
      return Promise.resolve(install ? install(path) : { installed: [], failed: [] })
    })
  }

  /** The batch picker modal (portaled to body by Overlay). Scoped queries
   *  keep the settings dialog's own checkboxes/labels out of the matches. */
  const picker = () => {
    const el = document.querySelector('.settings-skill-picker')
    expect(el, 'batch picker modal').toBeTruthy()
    return within(el as HTMLElement)
  }

  /** Land on the skills tab, surface one catalog hit, and click its Browse
   *  button so BatchPickerModal mounts. */
  const openPicker = async (config: Record<string, unknown> = {}) => {
    const input = await openSkillsTab(config, [catalogHit()])
    fireEvent.change(input, { target: { value: 'react' } })
    await waitFor(() => expect(remote().getByRole('button', { name: 'Browse' })).toBeTruthy())
    fireEvent.click(remote().getByRole('button', { name: 'Browse' }))
    await waitFor(() => expect(screen.getByText('Select skills to install')).toBeTruthy())
  }

  it('opens the picker with descriptions and Select All', async () => {
    stubTwoSkillPreview()
    await openPicker()

    expect(screen.getByText('Select skills to install')).toBeTruthy()
    // Subtitle: `${source} · ${skills.length} skills found`
    expect(picker().getByText('org/repo · 2 skills found')).toBeTruthy()
    expect(picker().getByRole('checkbox', { name: /Select All/ })).toBeTruthy()
    expect(picker().getByText('Does alpha things')).toBeTruthy()
    expect(picker().getByText('Does beta things')).toBeTruthy()
    // The picker previews the Browse source, not the search hit's.
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/remote/preview', { source: 'org/repo' })
  })

  it('installs only the checked skills and keeps the modal open with per-row status', async () => {
    stubTwoSkillPreview(() => ({
      installed: [{ name: 'alpha-skill', relativePath: 'skills/alpha-skill' }],
      failed: [{ name: 'beta-skill', relativePath: 'skills/beta-skill', error: 'Missing SKILL.md' }],
    }))
    await openPicker({ defaults: { cwd: '/work/proj' } })

    fireEvent.click(picker().getByRole('checkbox', { name: /alpha-skill/ }))
    fireEvent.click(picker().getByRole('button', { name: 'Install 1 skills' }))

    // Modal stays open: per-row status (full text on hover), install summary,
    // checkboxes retired, button relabelled Done.
    await waitFor(() => expect(picker().getByText('✓')).toBeTruthy())
    expect(screen.getByText('Select skills to install')).toBeTruthy()
    expect(picker().getByText('Missing SKILL.md').getAttribute('title')).toBe('Missing SKILL.md')
    expect(picker().getByText('1 installed · 1 failed')).toBeTruthy()
    expect((picker().getByRole('checkbox', { name: /alpha-skill/ }) as HTMLInputElement).disabled).toBe(true)
    expect((picker().getByRole('checkbox', { name: /Select All/ }) as HTMLInputElement).disabled).toBe(true)
    expect(picker().getByRole('button', { name: 'Done' })).toBeTruthy()
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/remote/install', {
      source: 'org/repo',
      scope: 'project',
      cwd: '/work/proj',
      paths: ['skills/alpha-skill'],
      overwrite: false,
    })

    // Done refreshes the list (every close path does after an install) and
    // closes — see the two close-path tests below.
    const listsBefore = listGets().length
    fireEvent.click(picker().getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByText('Select skills to install')).toBeNull())
    await waitFor(() => expect(listGets().length).toBeGreaterThan(listsBefore))
  })

  it('filters the list with the picker search box', async () => {
    stubTwoSkillPreview()
    await openPicker()

    fireEvent.change(picker().getByRole('textbox', { name: 'Search skills' }), { target: { value: 'beta' } })
    expect(picker().queryByText('alpha-skill')).toBeNull()
    expect(picker().getByText('beta-skill')).toBeTruthy()
    // Subtitle still reports the full found count, not the filtered one.
    expect(picker().getByText('org/repo · 2 skills found')).toBeTruthy()
  })

  it('Select All toggles only the visible rows', async () => {
    stubTwoSkillPreview()
    await openPicker()

    fireEvent.change(picker().getByRole('textbox', { name: 'Search skills' }), { target: { value: 'alpha' } })
    fireEvent.click(picker().getByRole('checkbox', { name: /Select All/ }))
    // The filtered-out row must stay unselected.
    fireEvent.change(picker().getByRole('textbox', { name: 'Search skills' }), { target: { value: '' } })
    expect((picker().getByRole('checkbox', { name: /alpha-skill/ }) as HTMLInputElement).checked).toBe(true)
    expect((picker().getByRole('checkbox', { name: /beta-skill/ }) as HTMLInputElement).checked).toBe(false)
  })

  it('header close button closes without installing', async () => {
    stubTwoSkillPreview()
    await openPicker()

    fireEvent.click(picker().getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByText('Select skills to install')).toBeNull())
    expect(vi.mocked(api.post)).not.toHaveBeenCalledWith('/skills/remote/install', expect.anything())
  })

  it('any close path after an install refreshes the installed list', async () => {
    // The install POST has already landed on disk when the user leaves via
    // the header ✕ instead of Done — the list must still refresh.
    stubTwoSkillPreview(() => ({
      installed: [{ name: 'alpha-skill', relativePath: 'skills/alpha-skill' }],
      failed: [],
    }))
    await openPicker({ defaults: { cwd: '/work/proj' } })

    fireEvent.click(picker().getByRole('checkbox', { name: /alpha-skill/ }))
    fireEvent.click(picker().getByRole('button', { name: 'Install 1 skills' }))
    await waitFor(() => expect(picker().getByRole('button', { name: 'Done' })).toBeTruthy())

    const listsBefore = listGets().length
    fireEvent.click(picker().getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByText('Select skills to install')).toBeNull())
    await waitFor(() => expect(listGets().length).toBeGreaterThan(listsBefore))
  })

  it('closing mid-install refreshes the installed list when the POST lands', async () => {
    // Cancel / ✕ are NOT disabled while an install is in flight. The POST
    // lands on disk anyway, so when it resolves after the modal is gone the
    // picker must deliver the refresh itself (close() can no longer do it).
    let resolveInstall!: () => void
    vi.mocked(api.post).mockImplementation((path: string) => {
      if (path === '/skills/remote/preview') {
        return Promise.resolve({
          source: 'org/repo',
          skills: [{ name: 'alpha-skill', description: 'Does alpha things', relativePath: 'skills/alpha-skill' }],
        })
      }
      return new Promise((resolve) => {
        resolveInstall = () => resolve({
          installed: [{ name: 'alpha-skill', relativePath: 'skills/alpha-skill' }],
          failed: [],
        })
      })
    })
    await openPicker({ defaults: { cwd: '/work/proj' } })

    fireEvent.click(picker().getByRole('checkbox', { name: /alpha-skill/ }))
    fireEvent.click(picker().getByRole('button', { name: 'Install 1 skills' }))
    // Close while the POST is still pending…
    fireEvent.click(picker().getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText('Select skills to install')).toBeNull())
    // …then let it land: the list must refresh even though the picker is gone.
    const listsBefore = listGets().length
    resolveInstall()
    await waitFor(() => expect(listGets().length).toBeGreaterThan(listsBefore))
  })

  it('closing mid-install still refreshes the list when the POST fails', async () => {
    // A rejected POST after the modal is gone must not be swallowed silently:
    // the list refreshes because files may have landed before the failure —
    // the GET is the source of truth, so over-refreshing is harmless.
    let rejectInstall!: () => void
    vi.mocked(api.post).mockImplementation((path: string) => {
      if (path === '/skills/remote/preview') {
        return Promise.resolve({
          source: 'org/repo',
          skills: [{ name: 'alpha-skill', description: 'Does alpha things', relativePath: 'skills/alpha-skill' }],
        })
      }
      return new Promise((_resolve, reject) => {
        rejectInstall = () => reject(new Error('boom'))
      })
    })
    await openPicker({ defaults: { cwd: '/work/proj' } })

    fireEvent.click(picker().getByRole('checkbox', { name: /alpha-skill/ }))
    fireEvent.click(picker().getByRole('button', { name: 'Install 1 skills' }))
    fireEvent.click(picker().getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText('Select skills to install')).toBeNull())
    const listsBefore = listGets().length
    rejectInstall()
    await waitFor(() => expect(listGets().length).toBeGreaterThan(listsBefore))
  })

  it('footer scope toggle switches the install target between project and user', async () => {
    stubTwoSkillPreview()
    await openPicker()

    // Default is project (inherited from the tab).
    fireEvent.click(picker().getByRole('checkbox', { name: /alpha-skill/ }))
    fireEvent.click(picker().getByRole('button', { name: 'Install 1 skills' }))
    await waitFor(() => expect(picker().getByRole('button', { name: 'Done' })).toBeTruthy())
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/remote/install', expect.objectContaining({ scope: 'project' }))

    // Reopen (Done first) and switch the footer toggle to User before installing.
    fireEvent.click(picker().getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByText('Select skills to install')).toBeNull())
    vi.mocked(api.post).mockClear()
    fireEvent.click(remote().getByRole('button', { name: 'Browse' }))
    await waitFor(() => expect(screen.getByText('Select skills to install')).toBeTruthy())
    expect(picker().getByRole('button', { name: 'User' })).toBeTruthy()
    fireEvent.click(picker().getByRole('button', { name: 'User' }))
    fireEvent.click(picker().getByRole('checkbox', { name: /alpha-skill/ }))
    fireEvent.click(picker().getByRole('button', { name: 'Install 1 skills' }))
    await waitFor(() => expect(picker().getByRole('button', { name: 'Done' })).toBeTruthy())
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/skills/remote/install', expect.objectContaining({
      scope: 'user',
      cwd: undefined,
    }))
  })

  it('Cancel closes without installing', async () => {
    stubTwoSkillPreview()
    await openPicker()

    fireEvent.click(picker().getByRole('checkbox', { name: /alpha-skill/ }))
    fireEvent.click(picker().getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText('Select skills to install')).toBeNull())
    expect(vi.mocked(api.post)).not.toHaveBeenCalledWith('/skills/remote/install', expect.anything())
  })

  it('shows a target-project selector defaulting to the server default cwd', async () => {
    const input = await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    expect(input).toBeTruthy()
    const select = screen.getByLabelText('Target project') as HTMLSelectElement
    expect(select.value).toBe('/work/proj')
    expect(select.disabled).toBe(false)
    // Resolved target hint is visible in project scope.
    expect(screen.getByText('/work/proj/.claude/skills')).toBeTruthy()
  })

  it('disables the target selector in user scope', async () => {
    await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    const userBtn = screen.getByRole('button', { name: 'User' })
    fireEvent.click(userBtn)
    const select = screen.getByLabelText('Target project') as HTMLSelectElement
    expect(select.disabled).toBe(true)
    // Hint disappears — user scope has no per-project target.
    expect(screen.queryByText('/work/proj/.claude/skills')).toBeNull()
  })

  it('selector onChange updates the target value and hint', async () => {
    // Seed the MRU list so the select offers a second path besides the
    // server default cwd.
    window.localStorage.setItem('claude-react-web:recent-cwds', JSON.stringify(['/other/repo']))
    await openSkillsTab({ defaults: { cwd: '/work/proj' } })
    const select = screen.getByLabelText('Target project') as HTMLSelectElement
    fireEvent.change(select, { target: { value: '/other/repo' } })
    expect(select.value).toBe('/other/repo')
    expect(screen.getByText('/other/repo/.claude/skills')).toBeTruthy()
    window.localStorage.removeItem('claude-react-web:recent-cwds')
  })

  it('browse opens the directory picker and a pick becomes the target', async () => {
    await openSkillsTab({ defaults: { cwd: '/work/proj' } })

    // DirectoryPicker browses the server filesystem; layer /fs shapes over
    // the shared config mock so the picker's bootstrap listing resolves.
    const baseGet = vi.mocked(api.get).getMockImplementation()!
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/fs/home') return Promise.resolve({ home: '/home/u', cwd: '/work/proj', sep: '/' })
      if (url.startsWith('/fs/list')) {
        const p = new URLSearchParams(url.split('?')[1]).get('path') ?? ''
        return Promise.resolve({ path: p, parent: null, entries: [] })
      }
      return baseGet(url)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Browse projects' }))
    await waitFor(() => expect(screen.getByText('Pick a project')).toBeTruthy())

    // Wait out the picker's initial directory listing so no in-flight
    // loadList can clobber the draft we are about to type.
    const dialog = screen.getByText('Pick a project').closest('.modal') as HTMLElement
    await waitFor(() => expect(within(dialog).queryByText('Loading...')).toBeNull())

    // Pick a different directory via the picker's manual-path affordance.
    const draftInput = within(dialog).getByRole('textbox') as HTMLInputElement
    fireEvent.change(draftInput, { target: { value: '/other/repo' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install skills here' }))

    await waitFor(() => expect(screen.queryByText('Pick a project')).toBeNull())
    const select = screen.getByLabelText('Target project') as HTMLSelectElement
    expect(select.value).toBe('/other/repo')
    expect(screen.getByText('/other/repo/.claude/skills')).toBeTruthy()
    window.localStorage.removeItem('claude-react-web:recent-cwds')
  })
})

describe('GlobalSettingsModal Skills preview modal', () => {
  beforeEach(() => {
    vi.mocked(api.put).mockResolvedValue({})
    vi.mocked(api.post).mockReset()
    vi.mocked(api.get).mockClear()
  })

  /** A project skill whose body exercises the markdown pipeline: a heading,
   *  bold text, and a list. */
  const previewSkill = {
    scope: 'project',
    name: 'find-skills',
    description: 'Helps users discover and install agent skills',
    path: '/work/proj/.claude/skills/find-skills/SKILL.md',
    relativePath: '.claude/skills/find-skills/SKILL.md',
    readOnly: false,
    valid: true,
    errors: [],
    content: [
      '---',
      'name: find-skills',
      'description: Helps users discover and install agent skills',
      '---',
      '',
      '# Find Skills',
      '',
      'This skill helps you discover **agent skills** quickly.',
      '',
      '- one',
      '- two',
    ].join('\n'),
  }

  const openPreview = async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/mcp-config') return Promise.resolve({ servers: [] })
      if (url === '/first-party-tools') return Promise.resolve({ servers: [] })
      if (url === '/log') return Promise.resolve({ level: 'info', availableLevels: ['error', 'warn', 'info', 'debug', 'trace'] })
      if (url === '/log/file') return Promise.resolve({ enabled: false, path: null })
      if (url.startsWith('/skills/search')) return Promise.resolve({ skills: [] })
      if (url.includes('/skills/project/find-skills')) return Promise.resolve({ skill: previewSkill })
      if (url.startsWith('/skills')) return Promise.resolve({ skills: [previewSkill] })
      return Promise.resolve({ defaults: { cwd: '/work/proj' } })
    })
    render(
      <ToastProvider>
        <GlobalSettingsModal open onClose={() => {}} onSaved={() => {}} />
      </ToastProvider>,
    )
    await waitFor(() => expect(screen.getByText('Extensions')).toBeTruthy())
    fireEvent.click(screen.getByText('Extensions'))
    await waitFor(() => expect(screen.getAllByText('find-skills').length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByText('find-skills')[0]!)
    await waitFor(() => expect(screen.getByText('Frontmatter')).toBeTruthy())
  }

  it('renders the body through the shared markdown pipeline, not raw text', async () => {
    await openPreview()

    // `**agent skills**` must arrive as a <strong>, not literal asterisks.
    const strong = document.querySelector('.settings-skill-preview-content strong')
    expect(strong, 'bold run rendered as <strong>').toBeTruthy()
    expect(strong!.textContent).toBe('agent skills')
    // Headings render as headings — the shared pipeline remaps `#` to <h3>
    // (h1/h2 are reserved for the app shell).
    expect(document.querySelector('.settings-skill-preview-content h3')?.textContent).toBe('Find Skills')
  })

  it('still shows the frontmatter key-value table', async () => {
    await openPreview()

    const rows = document.querySelectorAll('.settings-skill-frontmatter-table tbody tr')
    expect(rows.length).toBe(2)
    expect(rows[0]!.textContent).toContain('find-skills')
  })
})
