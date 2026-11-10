import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AppPluginsTab } from './AppPluginsTab'
import type { AppPluginClientInfo } from '../../shared/app-plugins/runtime-state.js'

const mockRegistry = vi.hoisted(() => ({ plugins: [] as AppPluginClientInfo[], refresh: vi.fn() }))

vi.mock('../app-plugins/usePluginRegistry', () => ({ usePluginRegistry: () => mockRegistry }))
vi.mock('./AppPluginMarketplaceSection', () => ({ AppPluginMarketplaceSection: () => null }))
vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  apiRequest: vi.fn(),
}))

import { api } from '../hooks/useApi'

function makePlugin(overrides: Partial<AppPluginClientInfo> = {}): AppPluginClientInfo {
  return {
    id: 'example.plugin',
    name: 'Example Plugin',
    version: '1.0.0',
    enabled: true,
    runtimeState: 'inactive',
    declaredPermissions: [],
    grantedPermissions: [],
    permissionRequired: false,
    compatible: true,
    secretsBackend: 'none',
    contributions: {
      commands: [],
      contextMenus: [],
      actions: [],
      configuration: { properties: [] },
      statusIndicators: [],
      widgets: [],
      diagnostics: [],
    },
    ...overrides,
  }
}

function renderPlugin(overrides: Partial<AppPluginClientInfo> = {}) {
  mockRegistry.plugins = [makePlugin(overrides)]
  return render(<AppPluginsTab />)
}

describe('AppPluginsTab status projection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRegistry.plugins = []
    mockRegistry.refresh.mockResolvedValue(undefined)
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}))
  })

  it('separates enabled intent from an inactive runtime', () => {
    renderPlugin()
    expect(screen.getByText('Enabled')).toBeTruthy()
    expect(screen.getByText('Not running')).toBeTruthy()
    expect(screen.getByText('No recorded file error')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Disable' })).toBeTruthy()
    expect(screen.queryByText('inactive')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Revalidate' })).toBeNull()
  })

  it('shows Running only for an active plugin', async () => {
    renderPlugin({ runtimeState: 'active' })
    expect(screen.getByText('Running').className).toContain('status-badge-accent')
    expect(screen.getByText('Running').parentElement?.getAttribute('role')).toBe('status')
    expect(screen.getByText('Enabled').className).toContain('status-badge-muted')

    const toggle = screen.getByRole('button', { name: /Example Plugin Enabled Running/ })
    fireEvent.focus(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-describedby')).toBeTruthy())
    expect(
      screen.getByText('Activation was confirmed by the host. This is not a live OS process heartbeat.'),
    ).toBeTruthy()
  })

  it('shows a disabled intent independently of runtime state', () => {
    renderPlugin({ enabled: false, runtimeState: 'disabled' })
    expect(screen.getByText('Disabled')).toBeTruthy()
    expect(screen.getByText('Not running')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy()
  })

  it('distinguishes an incompatible manifest from unavailable files', async () => {
    renderPlugin({
      runtimeState: 'incompatible',
      compatible: false,
      lastError: 'engines.claudeReactWeb ^0.7.0 not satisfied by host 0.8.0',
    })
    expect(screen.getByText('Enabled')).toBeTruthy()
    expect(screen.getByText('Blocked · incompatible')).toBeTruthy()
    expect(screen.getByText('Manifest readable')).toBeTruthy()
    const files = screen.getByText('Manifest readable')
    expect(files.getAttribute('tabindex')).toBe('0')
    expect(files.getAttribute('title')).toBeNull()
    fireEvent.focus(files)
    await waitFor(() => expect(files.getAttribute('aria-describedby')).toBeTruthy())
    expect(
      screen.getByText(/The plugin directory and manifest were readable at the last validation/),
    ).toBeTruthy()
    const reason = screen.getByText(
      'The manifest was read, but its structure or engine requirements are not supported by this host.',
    )
    expect(reason).toBeTruthy()
    expect(reason.parentElement?.getAttribute('role')).toBe('status')
    expect(screen.getByText('engines.claudeReactWeb ^0.7.0 not satisfied by host 0.8.0')).toBeTruthy()
    expect(screen.queryByText('File check failed')).toBeNull()
    expect(screen.getByRole('button', { name: 'Disable' })).toBeTruthy()
  })

  it('reports file failures without calling them host incompatibility', () => {
    renderPlugin({ runtimeState: 'corrupted', compatible: false, lastError: 'manifest is not valid JSON' })
    expect(screen.getByText('File check failed')).toBeTruthy()
    expect(screen.getByText('Unavailable · file error')).toBeTruthy()
    expect(
      screen.getByText(
        'The plugin directory or crw-plugin.json could not be read or parsed during the last validation.',
      ),
    ).toBeTruthy()
    expect(screen.getByText('manifest is not valid JSON')).toBeTruthy()
    expect(screen.queryByText('Blocked · incompatible')).toBeNull()
  })

  it('keeps permission consent separate from enabled intent', () => {
    renderPlugin({ runtimeState: 'permission-required', permissionRequired: true })
    expect(screen.getByText('Enabled')).toBeTruthy()
    expect(screen.queryByText('Disabled')).toBeNull()
    expect(screen.getByText('Blocked · permissions')).toBeTruthy()
    expect(screen.getByText('This version requires permission consent before activation.')).toBeTruthy()
  })

  it.each([
    ['crashed', 'Not running · crashed', 'The plugin subprocess exited unexpectedly.'],
    [
      'quarantined',
      'Stopped · crash loop',
      'Activation is blocked after repeated crashes. Disable and enable the plugin to reset it.',
    ],
  ] as const)('explains %s without requiring lastError', (runtimeState, label, reason) => {
    renderPlugin({ runtimeState })
    expect(screen.getByText(label).className).toContain('status-badge-danger')
    expect(screen.getByText(reason)).toBeTruthy()
  })

  it('does not surface stale errors in healthy states', () => {
    renderPlugin({ runtimeState: 'active', lastError: 'stale failure' })
    expect(screen.queryByText('stale failure')).toBeNull()
  })
})
