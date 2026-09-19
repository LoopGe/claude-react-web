import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react'
import { NewSessionDialog } from './NewSessionDialog'
import type { NewSessionForm } from '../../types'

// Cleanup is registered globally in src/test-setup.ts. It is load-bearing here
// regardless: the dialog portals to <body> and these tests assert against
// document.body, so a dialog left mounted by one test would satisfy the next
// one's `.not.toContain(...)`.
afterEach(() => cleanup())

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
    const { baseElement } = render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    await waitFor(() => expect(baseElement.textContent).toContain('plugA'))

    // Find and click the "Create" button
    const buttons = baseElement.querySelectorAll('button')
    const createBtn = Array.from(buttons).find((b) => b.textContent?.trim() === 'Create')!
    fireEvent.click(createBtn)
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    const form = onSubmit.mock.calls[0][0] as NewSessionForm
    expect(form.enabledPlugins).toBeUndefined()
  })

  it('sends enabledPlugins subset when a plugin is unchecked', async () => {
    const onSubmit = vi.fn()
    const { baseElement } = render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    await waitFor(() => expect(baseElement.textContent).toContain('plugA'))

    // Uncheck plugB by clicking its checkbox
    const labels = baseElement.querySelectorAll('label')
    const plugBLabel = Array.from(labels).find((l) => l.textContent?.includes('plugB'))!
    const plugBCheckbox = plugBLabel.querySelector('input[type="checkbox"]') as HTMLInputElement
    fireEvent.click(plugBCheckbox)

    const buttons = baseElement.querySelectorAll('button')
    const createBtn = Array.from(buttons).find((b) => b.textContent?.trim() === 'Create')!
    fireEvent.click(createBtn)
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    const form = onSubmit.mock.calls[0][0] as NewSessionForm
    expect(form.enabledPlugins).toEqual(['plugA@mp1'])
  })

  it('does not close the form when Esc dismisses the nested MCP installer', async () => {
    const onCancel = vi.fn()
    const { baseElement } = render(<NewSessionDialog {...baseProps} onCancel={onCancel} />)
    await waitFor(() => expect(baseElement.textContent).toContain('plugA'))

    // Open the MCP installer — a modal-on-top-of-modal. Both it and this dialog
    // render through a portal on <body> (Overlay's fixed-backdrop variants), so
    // the assertions below read document.body.
    const addBtn = Array.from(baseElement.querySelectorAll('button')).find((b) =>
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
    const { baseElement } = render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    await waitFor(() => expect(baseElement.textContent).toContain('plugA'))

    // Uncheck both plugins
    const labels = baseElement.querySelectorAll('label')
    const plugALabel = Array.from(labels).find((l) => l.textContent?.includes('plugA') && !l.textContent?.includes('plugB'))!
    const plugBLabel = Array.from(labels).find((l) => l.textContent?.includes('plugB'))!
    fireEvent.click(plugALabel.querySelector('input[type="checkbox"]')!)
    fireEvent.click(plugBLabel.querySelector('input[type="checkbox"]')!)

    const buttons = baseElement.querySelectorAll('button')
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

  // Both helpers take the element to search from — the dialog portals to
  // <body>, so callers pass RTL's baseElement rather than a scoped container.
  const findFirstPartyRow = (root: HTMLElement, name: string) => {
    const label = Array.from(root.querySelectorAll('label')).find((l) =>
      l.textContent?.includes(name) && l.querySelector('input[type="checkbox"]'),
    )
    expect(label, `first-party row for ${name}`).toBeDefined()
    return {
      label: label!,
      checkbox: label!.querySelector('input[type="checkbox"]') as HTMLInputElement,
    }
  }

  const clickCreate = async (root: HTMLElement, onSubmit: ReturnType<typeof vi.fn>) => {
    const createBtn = Array.from(root.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Create',
    )!
    fireEvent.click(createBtn)
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    return onSubmit.mock.calls[0][0] as NewSessionForm
  }

  it('pre-checks rows from the global defaults and omits the field when unchanged', async () => {
    const onSubmit = vi.fn()
    const { baseElement } = render(
      <NewSessionDialog {...baseProps} onSubmit={onSubmit} firstPartyTools={{ 'git-tools': { enabled: true } }} />,
    )
    await waitFor(() => expect(baseElement.textContent).toContain('git-tools'))
    expect(findFirstPartyRow(baseElement, 'git-tools').checkbox.checked).toBe(true)

    const form = await clickCreate(baseElement, onSubmit)
    // Unchanged from the global default → no override (the session inherits).
    expect(form.firstPartyTools).toBeUndefined()
  })

  it('sends an explicit OFF override when a globally-enabled tool is unchecked', async () => {
    const onSubmit = vi.fn()
    const { baseElement } = render(
      <NewSessionDialog {...baseProps} onSubmit={onSubmit} firstPartyTools={{ 'git-tools': { enabled: true } }} />,
    )
    await waitFor(() => expect(baseElement.textContent).toContain('git-tools'))
    fireEvent.click(findFirstPartyRow(baseElement, 'git-tools').checkbox)

    const form = await clickCreate(baseElement, onSubmit)
    expect(form.firstPartyTools).toEqual({ 'git-tools': false })
  })

  it('sends an explicit ON override when a globally-disabled tool is checked', async () => {
    const onSubmit = vi.fn()
    const { baseElement } = render(
      <NewSessionDialog {...baseProps} onSubmit={onSubmit} firstPartyTools={{ 'git-tools': { enabled: false } }} />,
    )
    await waitFor(() => expect(baseElement.textContent).toContain('git-tools'))
    expect(findFirstPartyRow(baseElement, 'git-tools').checkbox.checked).toBe(false)
    fireEvent.click(findFirstPartyRow(baseElement, 'git-tools').checkbox)

    const form = await clickCreate(baseElement, onSubmit)
    expect(form.firstPartyTools).toEqual({ 'git-tools': true })
  })

  it('hides the cluster when the defaults map is empty', async () => {
    const onSubmit = vi.fn()
    const { baseElement } = render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} firstPartyTools={{}} />)
    await waitFor(() => expect(baseElement.textContent).not.toContain('plugA'))
    expect(baseElement.textContent).not.toContain('First-party tools')
    await clickCreate(baseElement, onSubmit)
  })
})

describe('NewSessionDialog project prefill', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/enabled-plugins') return Promise.resolve({ plugins: [] })
      if (url === '/mcp-config') return Promise.resolve({ servers: [] })
      return Promise.resolve({})
    })
  })
  afterEach(() => window.localStorage.clear())

  const renderDialog = (props: { initialCwd?: string; onSubmit?: ReturnType<typeof vi.fn>; onCancel?: () => void } = {}) =>
    render(<NewSessionDialog {...baseProps} onSubmit={props.onSubmit ?? vi.fn()} {...props} />)

  it('prefers the most recent project over defaults.cwd', () => {
    window.localStorage.setItem('claude-react-web:recent-cwds', JSON.stringify(['/a/recent-app']))
    renderDialog()
    expect(screen.getByTitle('/a/recent-app')).toBeTruthy()
  })

  it('falls back to defaults.cwd when there are no recent projects', () => {
    renderDialog()
    expect(screen.getByTitle('/tmp')).toBeTruthy()
  })

  it('lets the drag-and-drop prefill win over the recent list', () => {
    window.localStorage.setItem('claude-react-web:recent-cwds', JSON.stringify(['/a/recent-app']))
    renderDialog({ initialCwd: '/b/dropped' })
    expect(screen.getByTitle('/b/dropped')).toBeTruthy()
  })

  it('submits the prefilled project as cwd', async () => {
    window.localStorage.setItem('claude-react-web:recent-cwds', JSON.stringify(['/a/recent-app']))
    const onSubmit = vi.fn()
    renderDialog({ onSubmit })
    const createBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Create',
    )!
    fireEvent.click(createBtn)
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0].cwd).toBe('/a/recent-app')
  })

  it('opens the directory picker from the Project menu footer', async () => {
    renderDialog()
    fireEvent.click(screen.getByTitle('/tmp'))
    fireEvent.click(screen.getByText('Open project…'))
    await waitFor(() => expect(screen.getByText('Pick a working directory')).toBeTruthy())
  })

  it('closes only the project menu on Escape, keeping the dialog open', () => {
    const onCancel = vi.fn()
    renderDialog({ onCancel })
    const trigger = screen.getByTitle('/tmp')
    fireEvent.click(trigger)
    const search = screen.getByRole('textbox', { name: 'Search projects' })
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(document.querySelector('.project-picker-menu')).toBeNull()
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByText('New session')).toBeTruthy()
    // Keyboard close hands focus back to the trigger instead of dropping it on <body>.
    expect(document.activeElement).toBe(trigger)
  })
})
