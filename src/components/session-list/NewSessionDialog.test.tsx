import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, waitFor, screen } from '@testing-library/react'
import { NewSessionDialog } from './NewSessionDialog'
import type { NewSessionForm } from '../../types'

// Cleanup is registered globally in src/test-setup.ts — do not re-add a
// per-file afterEach(cleanup) (CLAUDE.md).

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

describe('NewSessionDialog field pickers (model / permission mode / group)', () => {
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

  const modelTrigger = () => screen.getByLabelText('Model') as HTMLButtonElement
  const permTrigger = () => screen.getByLabelText('Permission mode') as HTMLButtonElement
  const groupTrigger = () => screen.getByLabelText('Group') as HTMLButtonElement
  const fieldItems = () => Array.from(document.querySelectorAll('.field-picker-item')) as HTMLButtonElement[]

  const clickCreate = async (onSubmit: ReturnType<typeof vi.fn>) => {
    const createBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Create',
    )!
    fireEvent.click(createBtn)
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    return onSubmit.mock.calls[0][0] as NewSessionForm
  }

  it('renders Model as a field picker showing the current model', () => {
    render(<NewSessionDialog {...baseProps} />)
    expect(modelTrigger().className).toContain('field-picker-trigger')
    expect(modelTrigger().textContent).toContain('claude-sonnet-4-20250514')
  })

  it('lists server models in the Model menu and selects one into the form', async () => {
    const onSubmit = vi.fn()
    render(
      <NewSessionDialog
        {...baseProps}
        onSubmit={onSubmit}
        serverModels={['claude-sonnet-4-20250514', 'claude-opus-4-20250514']}
      />,
    )
    fireEvent.click(modelTrigger())
    const labels = fieldItems().map((el) => el.textContent)
    expect(labels.some((t) => t?.includes('claude-opus-4-20250514'))).toBe(true)

    const opus = fieldItems().find((el) => el.textContent?.includes('claude-opus-4-20250514'))!
    fireEvent.click(opus)
    const form = await clickCreate(onSubmit)
    expect(form.model).toBe('claude-opus-4-20250514')
  })

  it('offers a custom "Use …" row for an unknown model id', async () => {
    const onSubmit = vi.fn()
    render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} serverModels={['claude-sonnet-4-20250514']} />)
    fireEvent.click(modelTrigger())
    const search = screen.getByRole('textbox', { name: 'Search models' })
    fireEvent.change(search, { target: { value: 'my-proxy-model' } })
    const custom = fieldItems().find((el) => el.textContent?.includes('Use'))!
    expect(custom.textContent).toContain('my-proxy-model')
    fireEvent.click(custom)
    const form = await clickCreate(onSubmit)
    expect(form.model).toBe('my-proxy-model')
  })

  it('keeps the custom row last so Enter after a filter commits the match, not the filter text', async () => {
    const onSubmit = vi.fn()
    render(
      <NewSessionDialog
        {...baseProps}
        onSubmit={onSubmit}
        serverModels={['claude-opus-4-20250514', 'claude-sonnet-4-20250514']}
      />,
    )
    fireEvent.click(modelTrigger())
    const search = screen.getByRole('textbox', { name: 'Search models' })
    fireEvent.change(search, { target: { value: 'opus' } })
    // Real match first, custom "Use …" last — ModelPicker's order.
    expect(fieldItems()[0].textContent).toContain('claude-opus-4-20250514')
    expect(fieldItems()[fieldItems().length - 1].textContent).toContain('Use')
    fireEvent.keyDown(search, { key: 'Enter' })
    const form = await clickCreate(onSubmit)
    expect(form.model).toBe('claude-opus-4-20250514')
  })

  it('can clear the model back to the server default', async () => {
    const onSubmit = vi.fn()
    render(
      <NewSessionDialog
        {...baseProps}
        onSubmit={onSubmit}
        serverModels={['claude-sonnet-4-20250514', 'claude-opus-4-20250514']}
      />,
    )
    fireEvent.click(modelTrigger())
    const def = fieldItems().find((el) => el.textContent?.includes('Default'))!
    fireEvent.click(def)
    const form = await clickCreate(onSubmit)
    expect(form.model).toBeUndefined()
  })

  it('keeps model recents in the menu (not a chips row) and can forget them', async () => {
    window.localStorage.setItem(
      'claude-react-web:recent-models',
      JSON.stringify(['recent-model-a', 'claude-sonnet-4-20250514']),
    )
    const onSubmit = vi.fn()
    render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    // No chips row under the field — recents live in the menu.
    expect(document.querySelector('.recent-chip')).toBeNull()

    fireEvent.click(modelTrigger())
    expect(fieldItems().some((el) => el.textContent?.includes('recent-model-a'))).toBe(true)
    // Every recent row is forgettable (ProjectPicker does the same — including
    // the current value if it happens to be in the list).
    const forget = Array.from(document.querySelectorAll('.field-picker-forget')) as HTMLButtonElement[]
    expect(forget.length).toBeGreaterThanOrEqual(1)
    fireEvent.click(forget[0])
    const stored = JSON.parse(window.localStorage.getItem('claude-react-web:recent-models')!)
    expect(stored).not.toContain('recent-model-a')
  })

  it('shows permission modes as human labels with icons, no search box', async () => {
    const onSubmit = vi.fn()
    render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    expect(permTrigger().textContent).toContain('Default (ask)')

    fireEvent.click(permTrigger())
    expect(document.querySelector('.field-picker-search')).toBeNull()
    const texts = fieldItems().map((el) => el.textContent)
    expect(texts.some((t) => t?.includes('Plan mode'))).toBe(true)
    // Raw enum values must not be the visible labels.
    expect(texts.some((t) => t?.trim() === 'bypassPermissions')).toBe(false)
    expect(texts.some((t) => t?.includes('Bypass (allow all)'))).toBe(true)

    fireEvent.click(fieldItems().find((el) => el.textContent?.includes('Plan mode'))!)
    const form = await clickCreate(onSubmit)
    expect(form.permissionMode).toBe('plan')
  })

  it('lists groups with capacity and submits the chosen group', async () => {
    const onSubmit = vi.fn()
    render(
      <NewSessionDialog
        {...baseProps}
        onSubmit={onSubmit}
        groups={[{ id: 'g1', name: 'Sprint', sessionIds: ['a', 'b'] }]}
        maxGroupSize={10}
      />,
    )
    expect(groupTrigger().textContent).toContain('None')

    fireEvent.click(groupTrigger())
    expect(fieldItems().some((el) => el.textContent?.includes('Sprint'))).toBe(true)
    expect(fieldItems().some((el) => el.textContent?.includes('2/10'))).toBe(true)

    fireEvent.click(fieldItems().find((el) => el.textContent?.includes('Sprint'))!)
    const form = await clickCreate(onSubmit)
    expect(form.groupId).toBe('g1')
  })

  it('drops a stale group id instead of submitting it as None', async () => {
    const onSubmit = vi.fn()
    const { rerender } = render(
      <NewSessionDialog
        {...baseProps}
        onSubmit={onSubmit}
        groups={[{ id: 'g1', name: 'Sprint', sessionIds: [] }]}
        initialGroupId="g1"
        maxGroupSize={10}
      />,
    )
    expect(groupTrigger().textContent).toContain('Sprint')
    // Group deleted while the dialog is open — trigger must not lie.
    rerender(
      <NewSessionDialog
        {...baseProps}
        onSubmit={onSubmit}
        groups={[]}
        initialGroupId="g1"
        maxGroupSize={10}
      />,
    )
    expect(groupTrigger().textContent).toContain('None')
    const form = await clickCreate(onSubmit)
    expect(form.groupId).toBeUndefined()
  })

  it('lists Model Groups from the modelGroups prop and submits modelGroupId', async () => {
    const onSubmit = vi.fn()
    render(
      <NewSessionDialog
        {...baseProps}
        onSubmit={onSubmit}
        serverModels={['claude-sonnet-4-20250514', 'claude-opus-4-20250514']}
        modelGroups={[
          {
            id: 'mg1',
            name: 'Balanced',
            opus: 'claude-opus-4-20250514',
            sonnet: 'claude-sonnet-4-20250514',
          },
        ]}
      />,
    )
    fireEvent.click(modelTrigger())
    expect(fieldItems().some((el) => el.textContent?.includes('Balanced'))).toBe(true)
    expect(document.querySelector('.field-picker-heading')?.textContent).toBe('Model Groups')

    fireEvent.click(fieldItems().find((el) => el.textContent?.includes('Balanced'))!)
    const form = await clickCreate(onSubmit)
    expect(form.modelGroupId).toBe('mg1')
    // A group pin replaces a concrete model — don't send both.
    expect(form.model).toBeUndefined()
  })

  it('does not fetch /config for modelGroups — they ride the prop', () => {
    render(
      <NewSessionDialog
        {...baseProps}
        modelGroups={[{ id: 'mg1', name: 'Balanced', opus: 'claude-opus-4-20250514' }]}
      />,
    )
    const configCalls = (api.get as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => url === '/config',
    )
    expect(configCalls).toHaveLength(0)
  })

  it('clears modelGroupId when a concrete model is chosen', async () => {
    const onSubmit = vi.fn()
    render(
      <NewSessionDialog
        {...baseProps}
        onSubmit={onSubmit}
        serverModels={['claude-opus-4-20250514']}
        modelGroups={[{ id: 'mg1', name: 'Balanced', opus: 'claude-opus-4-20250514' }]}
      />,
    )
    fireEvent.click(modelTrigger())
    fireEvent.click(fieldItems().find((el) => el.textContent?.includes('Balanced'))!)
    fireEvent.click(modelTrigger())
    // Match the model ROW by its label — the Balanced group's slot sub also
    // contains this model id and would otherwise win `includes`.
    const modelRow = fieldItems().find(
      (el) => el.querySelector('.field-picker-item-name')?.textContent === 'claude-opus-4-20250514',
    )!
    fireEvent.click(modelRow)
    const form = await clickCreate(onSubmit)
    expect(form.model).toBe('claude-opus-4-20250514')
    expect(form.modelGroupId).toBeUndefined()
  })

  it('renders Agent / Effort / Thinking as field pickers', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/enabled-plugins') return Promise.resolve({ plugins: [] })
      if (url === '/mcp-config') return Promise.resolve({ servers: [] })
      if (url === '/agent-definitions') {
        return Promise.resolve({
          agents: [{ name: 'reviewer', description: 'Reviews', prompt: 'P', enabled: true }],
        })
      }
      return Promise.resolve({})
    })
    const onSubmit = vi.fn()
    render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    await waitFor(() => expect(screen.getByLabelText('Agent')).toBeTruthy())

    const agentTrigger = screen.getByLabelText('Agent') as HTMLButtonElement
    expect(agentTrigger.className).toContain('field-picker-trigger')
    fireEvent.click(agentTrigger)
    expect(fieldItems().some((el) => el.textContent?.includes('reviewer'))).toBe(true)
    fireEvent.click(fieldItems().find((el) => el.textContent?.includes('reviewer'))!)

    // Advanced selects share the same chrome.
    fireEvent.click(screen.getByLabelText('Effort'))
    expect(fieldItems().some((el) => el.textContent?.includes('xhigh'))).toBe(true)
    fireEvent.click(fieldItems().find((el) => el.textContent?.includes('xhigh'))!)

    fireEvent.click(screen.getByLabelText('Thinking'))
    expect(fieldItems().some((el) => el.textContent?.includes('adaptive'))).toBe(true)
    fireEvent.click(fieldItems().find((el) => el.textContent?.includes('adaptive'))!)

    const form = await clickCreate(onSubmit)
    expect(form.agent).toBe('reviewer')
    expect(form.effort).toBe('xhigh')
    expect(form.thinking).toBe('adaptive')
  })

  it('resets agent prefills when the agent is deselected', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/enabled-plugins') return Promise.resolve({ plugins: [] })
      if (url === '/mcp-config') return Promise.resolve({ servers: [] })
      if (url === '/agent-definitions') {
        return Promise.resolve({
          agents: [
            {
              name: 'reviewer',
              description: 'Reviews',
              prompt: 'P',
              enabled: true,
              model: 'haiku',
              permissionMode: 'bypassPermissions',
            },
          ],
        })
      }
      return Promise.resolve({})
    })
    const onSubmit = vi.fn()
    render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    await waitFor(() => expect(screen.getByLabelText('Agent')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Agent'))
    await waitFor(() => {
      expect(
        Array.from(document.querySelectorAll('.field-picker-item')).some((el) =>
          el.textContent?.includes('reviewer'),
        ),
      ).toBe(true)
    })
    fireEvent.click(
      Array.from(document.querySelectorAll('.field-picker-item')).find((el) =>
        el.textContent?.includes('reviewer'),
      )!,
    )
    // Prefilled from the def…
    fireEvent.click(screen.getByLabelText('Agent'))
    fireEvent.click(
      Array.from(document.querySelectorAll('.field-picker-item')).find((el) =>
        el.textContent?.includes('None'),
      )!,
    )

    const form = await clickCreate(onSubmit)
    expect(form.agent).toBeUndefined()
    // …and reverted, not leaked into the create payload.
    expect(form.model).toBe(baseProps.defaults.model)
    expect(form.permissionMode).toBe('default')
  })

  it('keeps a manual model pick when the agent is later deselected', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/enabled-plugins') return Promise.resolve({ plugins: [] })
      if (url === '/mcp-config') return Promise.resolve({ servers: [] })
      if (url === '/agent-definitions') {
        return Promise.resolve({
          agents: [
            { name: 'reviewer', description: 'Reviews', prompt: 'P', enabled: true, model: 'haiku' },
          ],
        })
      }
      return Promise.resolve({})
    })
    const onSubmit = vi.fn()
    render(
      <NewSessionDialog
        {...baseProps}
        onSubmit={onSubmit}
        serverModels={['haiku', 'claude-opus-4-20250514']}
      />,
    )
    await waitFor(() => expect(screen.getByLabelText('Agent')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Agent'))
    await waitFor(() => {
      expect(
        Array.from(document.querySelectorAll('.field-picker-item')).some((el) =>
          el.textContent?.includes('reviewer'),
        ),
      ).toBe(true)
    })
    fireEvent.click(
      Array.from(document.querySelectorAll('.field-picker-item')).find((el) =>
        el.textContent?.includes('reviewer'),
      )!,
    )
    // User overrides the agent's prefill…
    fireEvent.click(modelTrigger())
    fireEvent.click(
      fieldItems().find(
        (el) => el.querySelector('.field-picker-item-name')?.textContent === 'claude-opus-4-20250514',
      )!,
    )
    // …then deselects the agent: the manual pick must survive.
    fireEvent.click(screen.getByLabelText('Agent'))
    fireEvent.click(
      Array.from(document.querySelectorAll('.field-picker-item')).find((el) =>
        el.textContent?.includes('None'),
      )!,
    )

    const form = await clickCreate(onSubmit)
    expect(form.model).toBe('claude-opus-4-20250514')
    expect(form.agent).toBeUndefined()
  })

  it('drops a stale modelGroupId when the group disappears from the prop', async () => {
    const onSubmit = vi.fn()
    const groups = [{ id: 'mg1', name: 'Balanced', opus: 'claude-opus-4-20250514' }]
    const { rerender } = render(
      <NewSessionDialog {...baseProps} onSubmit={onSubmit} modelGroups={groups} />,
    )
    fireEvent.click(modelTrigger())
    fireEvent.click(fieldItems().find((el) => el.textContent?.includes('Balanced'))!)

    // Profile deleted the group while the dialog was open: App refetches
    // /config and threads an empty modelGroups prop down.
    rerender(<NewSessionDialog {...baseProps} onSubmit={onSubmit} modelGroups={[]} />)

    const form = await clickCreate(onSubmit)
    expect(form.modelGroupId).toBeUndefined()
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
