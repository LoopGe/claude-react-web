import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { NewSessionDialog } from './NewSessionDialog'
import type { NewSessionForm } from '../../types'

vi.mock('../../hooks/useApi', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}))

import { api } from '../../hooks/useApi'

// Supply minimal required props matching NewSessionDialogProps:
//   defaults (required), onSubmit, onCancel, groups, maxGroupSize
const baseProps = {
  open: true,
  defaults: { cwd: '/tmp', model: 'claude-sonnet-4-20250514' },
  onSubmit: vi.fn(),
  onCancel: vi.fn(),
  groups: [],
  serverModels: [],
  maxGroupSize: 10,
}

describe('NewSessionDialog plugin picker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/enabled-plugins') {
        return Promise.resolve({
          plugins: [
            { key: 'plugA@mp1', name: 'plugA', marketplace: 'mp1' },
            { key: 'plugB@mp1', name: 'plugB', marketplace: 'mp1' },
          ],
        })
      }
      if (url === '/mcp-config') return Promise.resolve({ servers: [] })
      return Promise.resolve({})
    })
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ session: { id: 's1' } })
  })

  it('renders all enabled plugins pre-checked and omits enabledPlugins when all checked', async () => {
    const onSubmit = vi.fn()
    const { container } = render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    await waitFor(() => expect(container.textContent).toContain('plugA'))

    // Find and click the "Create" button
    const buttons = container.querySelectorAll('button')
    const createBtn = Array.from(buttons).find((b) => b.textContent?.trim() === 'Create')!
    fireEvent.click(createBtn)
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    const form = onSubmit.mock.calls[0][0] as NewSessionForm
    expect(form.enabledPlugins).toBeUndefined()
  })

  it('sends enabledPlugins subset when a plugin is unchecked', async () => {
    const onSubmit = vi.fn()
    const { container } = render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    await waitFor(() => expect(container.textContent).toContain('plugA'))

    // Uncheck plugB by clicking its checkbox
    const labels = container.querySelectorAll('label')
    const plugBLabel = Array.from(labels).find((l) => l.textContent?.includes('plugB'))!
    const plugBCheckbox = plugBLabel.querySelector('input[type="checkbox"]') as HTMLInputElement
    fireEvent.click(plugBCheckbox)

    const buttons = container.querySelectorAll('button')
    const createBtn = Array.from(buttons).find((b) => b.textContent?.trim() === 'Create')!
    fireEvent.click(createBtn)
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    const form = onSubmit.mock.calls[0][0] as NewSessionForm
    expect(form.enabledPlugins).toEqual(['plugA@mp1'])
  })

  it('sends enabledPlugins: [] when all unchecked', async () => {
    const onSubmit = vi.fn()
    const { container } = render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    await waitFor(() => expect(container.textContent).toContain('plugA'))

    // Uncheck both plugins
    const labels = container.querySelectorAll('label')
    const plugALabel = Array.from(labels).find((l) => l.textContent?.includes('plugA') && !l.textContent?.includes('plugB'))!
    const plugBLabel = Array.from(labels).find((l) => l.textContent?.includes('plugB'))!
    fireEvent.click(plugALabel.querySelector('input[type="checkbox"]')!)
    fireEvent.click(plugBLabel.querySelector('input[type="checkbox"]')!)

    const buttons = container.querySelectorAll('button')
    const createBtn = Array.from(buttons).find((b) => b.textContent?.trim() === 'Create')!
    fireEvent.click(createBtn)
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    const form = onSubmit.mock.calls[0][0] as NewSessionForm
    expect(form.enabledPlugins).toEqual([])
  })
})
