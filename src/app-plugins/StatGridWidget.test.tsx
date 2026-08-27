import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('./usePluginWidgetStream', () => ({
  usePluginWidgetStream: () => ({
    payload: {
      values: [
        { id: 'cpu', label: 'CPU', value: '23.4', unit: '%', progress: 0.234, tone: 'ok' },
        { id: 'mem', label: 'Mem', value: '12.8/32', unit: 'GB', progress: 0.4, tone: 'warn' },
      ],
    },
    updatedAt: 1,
  }),
}))

import { StatGridWidget } from './StatGridWidget'

describe('StatGridWidget', () => {
  it('renders each row with label, value, unit and a data-tone', () => {
    render(<StatGridWidget pluginId="p1" widget={{ id: 'w1', location: 'global.bottomLeft', kind: 'stat-grid' }} />)
    expect(screen.getByText('CPU')).toBeTruthy()
    expect(screen.getByText('23.4')).toBeTruthy()
    expect(screen.getByText('%')).toBeTruthy()
    const mem = screen.getByText('Mem').closest('.stat-row')
    expect(mem?.getAttribute('data-tone')).toBe('warn')
  })
})
