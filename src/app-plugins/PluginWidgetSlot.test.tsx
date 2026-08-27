import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('./usePluginWidgetStream', () => ({
  usePluginWidgetStream: vi.fn(),
}))
vi.mock('./PluginRegistryProvider', () => ({
  useAllContributions: vi.fn(),
}))

import { PluginWidgetSlot } from './PluginWidgetSlot'
import { usePluginWidgetStream } from './usePluginWidgetStream'
import { useAllContributions } from './PluginRegistryProvider'
import type { WidgetState } from './usePluginWidgetStream'
import type { ResolvedPluginContributions } from '../../shared/app-plugins/contributions.js'

const mockedStream = vi.mocked(usePluginWidgetStream)
const mockedContrib = vi.mocked(useAllContributions)

const contribution: ResolvedPluginContributions = {
  commands: [],
  contextMenus: [],
  actions: [],
  configuration: { properties: [] },
  statusIndicators: [],
  widgets: [{ id: 'sys.stats', location: 'global.bottomLeft', kind: 'stat-grid', title: 'Stats' }],
  diagnostics: [],
}

const state: WidgetState = {
  payload: {
    values: [{ id: 'cpu', label: 'CPU', value: '23.4', unit: '%', progress: 0.2, tone: 'ok' }],
  },
  updatedAt: 1,
}

describe('PluginWidgetSlot', () => {
  beforeEach(() => {
    mockedStream.mockReset()
    mockedContrib.mockReset()
  })

  it('renders nothing when no plugin contributes widgets', () => {
    mockedContrib.mockReturnValue([])
    const { container } = render(<PluginWidgetSlot location="global.bottomLeft" />)
    expect(container.querySelector('.plugin-widget-slot')).toBeNull()
  })

  it('renders no container while widgets have no payload yet', () => {
    mockedContrib.mockReturnValue([{ ...contribution, pluginId: 'sys' }])
    mockedStream.mockReturnValue(undefined)
    const { container } = render(<PluginWidgetSlot location="global.bottomLeft" />)
    // Contributions exist but every widget renders nothing → no empty bordered box.
    expect(container.querySelector('.plugin-widget-slot')).toBeNull()
  })

  it('renders the slot container once a widget has a payload', () => {
    mockedContrib.mockReturnValue([{ ...contribution, pluginId: 'sys' }])
    mockedStream.mockReturnValue(state)
    const { container } = render(<PluginWidgetSlot location="global.bottomLeft" />)
    expect(container.querySelector('.plugin-widget-slot')).not.toBeNull()
    expect(screen.getByText('CPU')).toBeTruthy()
  })
})
