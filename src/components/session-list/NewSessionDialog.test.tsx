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

// jsdom doesn't implement matchMedia; useExitPresence probes it when a
// nested modal closes (reduced-motion check). Report "no reduced motion" so
// the exit-timer path runs normally. Same stub as FindingsCard/TodoChecklist.
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
}))

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

  it('does not close the form when Esc dismisses the nested MCP installer', async () => {
    const onCancel = vi.fn()
    const { container } = render(<NewSessionDialog {...baseProps} onCancel={onCancel} />)
    await waitFor(() => expect(container.textContent).toContain('plugA'))

    // Open the MCP installer — a modal-on-top-of-modal. It is portaled to
    // <body>, so assert against document.body, not the dialog container.
    const addBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Add server'),
    )!
    fireEvent.click(addBtn)
    await waitFor(() => expect(document.body.textContent).toContain('Add MCP Server'))

    // One Escape dismisses ONLY the installer; the new-session form survives.
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(document.body.textContent).not.toContain('Add MCP Server'))
    expect(onCancel).not.toHaveBeenCalled()
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

describe('NewSessionDialog first-party tools picker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/enabled-plugins') return Promise.resolve({ plugins: [] })
      if (url === '/mcp-config') return Promise.resolve({ servers: [] })
      return Promise.resolve({})
    })
  })

  const findFirstPartyRow = (container: HTMLElement, name: string) => {
    const label = Array.from(container.querySelectorAll('label')).find((l) =>
      l.textContent?.includes(name) && l.querySelector('input[type="checkbox"]'),
    )
    expect(label, `first-party row for ${name}`).toBeDefined()
    return {
      label: label!,
      checkbox: label!.querySelector('input[type="checkbox"]') as HTMLInputElement,
    }
  }

  const clickCreate = async (container: HTMLElement, onSubmit: ReturnType<typeof vi.fn>) => {
    const createBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Create',
    )!
    fireEvent.click(createBtn)
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    return onSubmit.mock.calls[0][0] as NewSessionForm
  }

  it('pre-checks rows from the global defaults and omits the field when unchanged', async () => {
    const onSubmit = vi.fn()
    const { container } = render(
      <NewSessionDialog {...baseProps} onSubmit={onSubmit} firstPartyTools={{ apptools: { enabled: true } }} />,
    )
    await waitFor(() => expect(container.textContent).toContain('apptools'))
    expect(findFirstPartyRow(container, 'apptools').checkbox.checked).toBe(true)

    const form = await clickCreate(container, onSubmit)
    // Unchanged from the global default → no override (the session inherits).
    expect(form.firstPartyTools).toBeUndefined()
  })

  it('sends an explicit OFF override when a globally-enabled tool is unchecked', async () => {
    const onSubmit = vi.fn()
    const { container } = render(
      <NewSessionDialog {...baseProps} onSubmit={onSubmit} firstPartyTools={{ apptools: { enabled: true } }} />,
    )
    await waitFor(() => expect(container.textContent).toContain('apptools'))
    fireEvent.click(findFirstPartyRow(container, 'apptools').checkbox)

    const form = await clickCreate(container, onSubmit)
    expect(form.firstPartyTools).toEqual({ apptools: false })
  })

  it('sends an explicit ON override when a globally-disabled tool is checked', async () => {
    const onSubmit = vi.fn()
    const { container } = render(
      <NewSessionDialog {...baseProps} onSubmit={onSubmit} firstPartyTools={{ apptools: { enabled: false } }} />,
    )
    await waitFor(() => expect(container.textContent).toContain('apptools'))
    expect(findFirstPartyRow(container, 'apptools').checkbox.checked).toBe(false)
    fireEvent.click(findFirstPartyRow(container, 'apptools').checkbox)

    const form = await clickCreate(container, onSubmit)
    expect(form.firstPartyTools).toEqual({ apptools: true })
  })

  it('hides the cluster when the defaults map is empty', async () => {
    const onSubmit = vi.fn()
    const { container } = render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} firstPartyTools={{}} />)
    await waitFor(() => expect(container.textContent).not.toContain('plugA'))
    expect(container.textContent).not.toContain('First-party tools')
    await clickCreate(container, onSubmit)
  })
})
