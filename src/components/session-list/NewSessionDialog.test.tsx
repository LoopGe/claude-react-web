import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, waitFor, screen, act } from '@testing-library/react'
import { NewSessionDialog } from './NewSessionDialog'
import type { NewSessionForm } from '../../types'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../../test/resize-observer-stub'

// Cleanup is registered globally in src/test-setup.ts — do not re-add a
// per-file afterEach(cleanup) (CLAUDE.md).

vi.mock('../../hooks/useApi', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}))

import { api } from '../../hooks/useApi'

// Height-animation wiring: the cap math is unit-tested in capped-height-measure.test.ts;
// here the measure is mocked to controlled heights so the wiring (observer + key
// paths, pin release) is what's under test. Existing tests never read the measure.
const { measureMock } = vi.hoisted(() => ({ measureMock: vi.fn() }))
vi.mock('../../utils/capped-height-measure', () => ({ measureCappedContentHeight: measureMock }))

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

  // The draft provider is internal dialog state (no prop) — the gate is
  // driven through the real provider selector, like a user would.
  const selectProvider = (label: string) => {
    fireEvent.click(screen.getByLabelText('Provider'))
    const row = Array.from(document.querySelectorAll('.field-picker-item')).find(
      (el) => el.querySelector('.field-picker-item-name')?.textContent === label,
    )!
    fireEvent.click(row)
  }
  const pluginCheckboxes = (root: HTMLElement) =>
    Array.from(root.querySelectorAll('label'))
      .filter((l) => l.querySelector('input[type="checkbox"]') && /plug[AB]/.test(l.textContent ?? ''))
      .map((l) => l.querySelector('input[type="checkbox"]') as HTMLInputElement)

  it('native draft: plugin picker shown but locked — disabled checkboxes + requires-CLI notice', async () => {
    const { baseElement } = render(<NewSessionDialog {...baseProps} />)
    await waitFor(() => expect(baseElement.textContent).toContain('plugA'))

    selectProvider('Native in-process')

    // Show-but-locked: the rows stay visible with their pre-checked state…
    const boxes = pluginCheckboxes(baseElement)
    expect(boxes).toHaveLength(2)
    for (const box of boxes) {
      expect(box.disabled).toBe(true)
      expect(box.checked).toBe(true)
    }
    // …the notice explains the lock, and the choose-here hint survives.
    expect(baseElement.querySelector('.requires-cli-notice')?.textContent).toContain(
      'This feature requires the Claude CLI.',
    )
    expect(baseElement.textContent).toContain("Plugins can't be added after the session starts")
    // A click on a locked row cannot change the selection.
    fireEvent.click(boxes[0])
    expect(boxes[0].checked).toBe(true)
  })

  it('claude draft: picker enabled with no notice; switching providers toggles the lock live', async () => {
    const { baseElement } = render(<NewSessionDialog {...baseProps} />)
    await waitFor(() => expect(baseElement.textContent).toContain('plugA'))

    // Claude (the default): enabled, no notice.
    for (const box of pluginCheckboxes(baseElement)) expect(box.disabled).toBe(false)
    expect(baseElement.querySelector('.requires-cli-notice')).toBeNull()

    selectProvider('Native in-process')
    for (const box of pluginCheckboxes(baseElement)) expect(box.disabled).toBe(true)
    expect(baseElement.querySelector('.requires-cli-notice')).not.toBeNull()

    // Switching back to Claude unlocks live — same mounted dialog.
    selectProvider('Claude CLI')
    for (const box of pluginCheckboxes(baseElement)) expect(box.disabled).toBe(false)
    expect(baseElement.querySelector('.requires-cli-notice')).toBeNull()
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

describe('NewSessionDialog provider picker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/enabled-plugins') {
        return Promise.resolve({
          plugins: [{ key: 'plugA@mp1', name: 'plugA', marketplace: 'mp1' }],
        })
      }
      if (url === '/mcp-config') return Promise.resolve({ servers: [] })
      return Promise.resolve({})
    })
  })
  afterEach(() => window.localStorage.clear())

  const providerTrigger = () => screen.getByLabelText('Provider') as HTMLButtonElement
  const fieldItems = () => Array.from(document.querySelectorAll('.field-picker-item')) as HTMLButtonElement[]
  const providerRow = (label: string) =>
    fieldItems().find(
      (el) => el.querySelector('.field-picker-item-name')?.textContent === label,
    )!
  /** The plugin cluster's own heading label (exact text — the hint and other
   *  labels share the word region but not the exact match). */
  const pluginCluster = (root: HTMLElement) =>
    Array.from(root.querySelectorAll('label')).find((l) => l.textContent?.trim() === 'Plugins')

  const clickCreate = async (onSubmit: ReturnType<typeof vi.fn>) => {
    const createBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Create',
    )!
    fireEvent.click(createBtn)
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    return onSubmit.mock.calls[0][0] as NewSessionForm
  }

  it('defaults to Claude CLI and keeps the plugin cluster visible', async () => {
    const { baseElement } = render(<NewSessionDialog {...baseProps} />)
    expect(providerTrigger().textContent).toContain('Claude CLI')
    await waitFor(() => expect(pluginCluster(baseElement)).toBeDefined())
    // The cluster's own control (not a stray "Plugins" mention) holds the rows.
    expect(pluginCluster(baseElement)!.parentElement!.textContent).toContain('plugA')
  })

  it('submits provider: claude by default', async () => {
    const onSubmit = vi.fn()
    render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    const form = await clickCreate(onSubmit)
    expect(form.provider).toBe('claude')
  })

  it('submits provider: native and shows the plugin cluster locked', async () => {
    const onSubmit = vi.fn()
    const { baseElement } = render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    await waitFor(() => expect(pluginCluster(baseElement)).toBeDefined())

    fireEvent.click(providerTrigger())
    fireEvent.click(providerRow('Native in-process'))
    expect(providerTrigger().textContent).toContain('Native in-process')

    // Native locks plugins — the cluster stays visible (rows included),
    // disabled, with the requires-CLI notice explaining the lock.
    expect(pluginCluster(baseElement)).toBeDefined()
    expect(pluginCluster(baseElement)!.parentElement!.textContent).toContain('plugA')
    const box = pluginCluster(baseElement)!.parentElement!.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement
    expect(box.disabled).toBe(true)
    expect(baseElement.querySelector('.requires-cli-notice')).not.toBeNull()

    const form = await clickCreate(onSubmit)
    expect(form.provider).toBe('native')
  })

  it('unlocks the plugin cluster when switching back to Claude', async () => {
    const onSubmit = vi.fn()
    const { baseElement } = render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    await waitFor(() => expect(pluginCluster(baseElement)).toBeDefined())

    fireEvent.click(providerTrigger())
    fireEvent.click(providerRow('Native in-process'))
    await waitFor(() => expect(baseElement.querySelector('.requires-cli-notice')).not.toBeNull())

    fireEvent.click(providerTrigger())
    fireEvent.click(providerRow('Claude CLI'))
    expect(providerTrigger().textContent).toContain('Claude CLI')
    expect(pluginCluster(baseElement)).toBeDefined()
    expect(pluginCluster(baseElement)!.parentElement!.textContent).toContain('plugA')
    const box = pluginCluster(baseElement)!.parentElement!.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement
    expect(box.disabled).toBe(false)
    expect(baseElement.querySelector('.requires-cli-notice')).toBeNull()

    const form = await clickCreate(onSubmit)
    expect(form.provider).toBe('claude')
  })

  it('offers exactly the two provider labels', () => {
    render(<NewSessionDialog {...baseProps} />)
    fireEvent.click(providerTrigger())
    const labels = fieldItems().map((el) => el.querySelector('.field-picker-item-name')?.textContent)
    expect(labels).toEqual(['Claude CLI', 'Native in-process'])
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

  it('marks a full group honestly — the create refuses, nothing is replaced', async () => {
    const onSubmit = vi.fn()
    render(
      <NewSessionDialog
        {...baseProps}
        onSubmit={onSubmit}
        groups={[{ id: 'g1', name: 'Sprint', sessionIds: ['a', 'b'] }]}
        maxGroupSize={2}
      />,
    )
    fireEvent.click(groupTrigger())
    const row = fieldItems().find((el) => el.textContent?.includes('Sprint'))!
    // handleAddToGroup refuses a full group with a toast (no eviction since
    // 1304a08b) — the label must not promise a replacement.
    expect(row.textContent).toContain('2/2 — full, will stay ungrouped')
    expect(row.textContent).not.toContain('replace oldest')

    // Picking it still submits the group id; App's refuse path leaves the
    // session ungrouped. The trigger carries the same honest suffix.
    fireEvent.click(row)
    expect(groupTrigger().textContent).toContain('full, will stay ungrouped')
    const form = await clickCreate(onSubmit)
    expect(form.groupId).toBe('g1')
  })

  it('offers a "Create group …" row for a new name and submits it as newGroupName', async () => {
    const onSubmit = vi.fn()
    render(
      <NewSessionDialog
        {...baseProps}
        onSubmit={onSubmit}
        groups={[{ id: 'g1', name: 'Sprint', sessionIds: [] }]}
        maxGroupSize={10}
      />,
    )
    fireEvent.click(groupTrigger())
    const search = screen.getByRole('textbox', { name: 'Search groups' })
    fireEvent.change(search, { target: { value: 'Fresh Team' } })
    const create = fieldItems().find((el) => el.textContent?.includes('Create group'))!
    expect(create.textContent).toContain('Fresh Team')
    fireEvent.click(create)
    // Trigger shows the pending name once the menu closes.
    expect(groupTrigger().textContent).toContain('Fresh Team')

    const form = await clickCreate(onSubmit)
    expect(form.newGroupName).toBe('Fresh Team')
    // The pending group replaces any concrete group pick — don't send both.
    expect(form.groupId).toBeUndefined()
  })

  it('does not offer group creation when the typed name matches an existing group', async () => {
    render(
      <NewSessionDialog
        {...baseProps}
        groups={[{ id: 'g1', name: 'Sprint', sessionIds: [] }]}
        maxGroupSize={10}
      />,
    )
    fireEvent.click(groupTrigger())
    const search = screen.getByRole('textbox', { name: 'Search groups' })
    fireEvent.change(search, { target: { value: 'Sprint' } })
    // Exact existing-name match suppresses the create row (FieldPicker's
    // exact-label rule) — the real group is the only offer.
    expect(fieldItems().some((el) => el.textContent?.includes('Create group'))).toBe(false)
    expect(fieldItems().some((el) => el.textContent?.includes('Sprint'))).toBe(true)
  })

  it('clears the pending new group when an existing group is picked', async () => {
    const onSubmit = vi.fn()
    render(
      <NewSessionDialog
        {...baseProps}
        onSubmit={onSubmit}
        groups={[{ id: 'g1', name: 'Sprint', sessionIds: [] }]}
        maxGroupSize={10}
      />,
    )
    fireEvent.click(groupTrigger())
    fireEvent.change(screen.getByRole('textbox', { name: 'Search groups' }), {
      target: { value: 'Fresh Team' },
    })
    fireEvent.click(fieldItems().find((el) => el.textContent?.includes('Create group'))!)

    // User changes their mind and picks the existing group instead.
    fireEvent.click(groupTrigger())
    fireEvent.click(fieldItems().find((el) => el.textContent?.includes('Sprint'))!)

    const form = await clickCreate(onSubmit)
    expect(form.groupId).toBe('g1')
    expect(form.newGroupName).toBeUndefined()
  })

  it('clears the pending new group when None is picked', async () => {
    const onSubmit = vi.fn()
    render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    fireEvent.click(groupTrigger())
    fireEvent.change(screen.getByRole('textbox', { name: 'Search groups' }), {
      target: { value: 'Fresh Team' },
    })
    fireEvent.click(fieldItems().find((el) => el.textContent?.includes('Create group'))!)

    fireEvent.click(groupTrigger())
    fireEvent.click(fieldItems().find((el) => el.textContent?.includes('None (Ungrouped)'))!)

    const form = await clickCreate(onSubmit)
    expect(form.groupId).toBeUndefined()
    expect(form.newGroupName).toBeUndefined()
  })

  it('does not offer group creation for a name App would reject (over-length)', async () => {
    render(<NewSessionDialog {...baseProps} />)
    fireEvent.click(groupTrigger())
    fireEvent.change(screen.getByRole('textbox', { name: 'Search groups' }), {
      // 45 chars — over validateGroupName's 40-char cap. Offering the row
      // would only fail AFTER the session POST landed, stranding the
      // session ungrouped, so it must not be offered at all.
      target: { value: 'x'.repeat(45) },
    })
    expect(fieldItems().some((el) => el.textContent?.includes('Create group'))).toBe(false)
  })

  it('shows the pending new group as the selected row when the menu reopens', async () => {
    render(<NewSessionDialog {...baseProps} />)
    fireEvent.click(groupTrigger())
    fireEvent.change(screen.getByRole('textbox', { name: 'Search groups' }), {
      target: { value: 'Fresh Team' },
    })
    fireEvent.click(fieldItems().find((el) => el.textContent?.includes('Create group'))!)

    // Reopen: the pending pick must be visible and CHECKED in the listbox —
    // same contract as the Model picker's current-value row.
    fireEvent.click(groupTrigger())
    const pending = fieldItems().find(
      (el) => el.querySelector('.field-picker-item-name')?.textContent === 'Fresh Team',
    )!
    expect(pending.getAttribute('aria-selected')).toBe('true')
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

  it('model menu has no Model Groups section and submits the chosen model', async () => {
    const onSubmit = vi.fn()
    render(
      <NewSessionDialog
        {...baseProps}
        onSubmit={onSubmit}
        serverModels={['claude-sonnet-4-20250514', 'claude-opus-4-20250514']}
      />,
    )
    fireEvent.click(modelTrigger())
    expect(document.querySelector('.field-picker-heading')?.textContent).not.toBe('Model Groups')
    fireEvent.click(fieldItems().find((el) => el.textContent?.includes('claude-opus-4-20250514'))!)
    const form = await clickCreate(onSubmit)
    expect(form.model).toBe('claude-opus-4-20250514')
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
})

describe('NewSessionDialog worktree isolation', () => {
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

  const isolateRow = (root: HTMLElement) => {
    const label = Array.from(root.querySelectorAll('label')).find((l) =>
      l.textContent?.includes('Isolate in its own worktree'),
    )
    expect(label, 'worktree isolation row').toBeDefined()
    return label!.querySelector('input[type="checkbox"]') as HTMLInputElement
  }

  const clickCreate = async (onSubmit: ReturnType<typeof vi.fn>) => {
    const createBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Create',
    )!
    fireEvent.click(createBtn)
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    return onSubmit.mock.calls[0][0] as NewSessionForm
  }

  it('submits isolateWorktree: true when the checkbox is checked', async () => {
    const onSubmit = vi.fn()
    const { baseElement } = render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    fireEvent.click(isolateRow(baseElement))
    expect(isolateRow(baseElement).checked).toBe(true)

    const form = await clickCreate(onSubmit)
    expect(form.isolateWorktree).toBe(true)
  })

  it('omits isolateWorktree when the checkbox is left unchecked', async () => {
    const onSubmit = vi.fn()
    const { baseElement } = render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    expect(isolateRow(baseElement).checked).toBe(false)

    const form = await clickCreate(onSubmit)
    expect(form.isolateWorktree).toBeUndefined()
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

describe('NewSessionDialog auto-compact window', () => {
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

  const windowInput = (root: HTMLElement) => {
    const label = Array.from(root.querySelectorAll('label')).find((l) =>
      l.textContent?.includes('Auto-compact window'),
    )
    expect(label, 'auto-compact window row').toBeDefined()
    return label!.parentElement!.querySelector('input') as HTMLInputElement
  }

  const clickCreate = async (onSubmit: ReturnType<typeof vi.fn>) => {
    const createBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Create',
    )!
    fireEvent.click(createBtn)
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    return onSubmit.mock.calls[0][0] as NewSessionForm
  }

  it('submits settings.autoCompactWindow when a window is entered', async () => {
    const onSubmit = vi.fn()
    const { baseElement } = render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    fireEvent.change(windowInput(baseElement), { target: { value: '500000' } })

    const form = await clickCreate(onSubmit)
    expect(form.settings).toEqual({ autoCompactWindow: 500000 })
  })

  it('omits settings when the field is empty (auto)', async () => {
    const onSubmit = vi.fn()
    const { baseElement } = render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    expect(windowInput(baseElement).value).toBe('')

    const form = await clickCreate(onSubmit)
    expect(form.settings).toBeUndefined()
  })

  it('omits settings on unparseable input', async () => {
    const onSubmit = vi.fn()
    const { baseElement } = render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    fireEvent.change(windowInput(baseElement), { target: { value: 'abc' } })

    const form = await clickCreate(onSubmit)
    expect(form.settings).toBeUndefined()
  })

  it('accepts exponent notation like a number input does (5e5 → 500000)', async () => {
    // type=number lets the user type 5e5 / 1e6; parseInt would read those as
    // 5 / 1 and silently clamp to the 100k floor.
    const onSubmit = vi.fn()
    const { baseElement } = render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    fireEvent.change(windowInput(baseElement), { target: { value: '5e5' } })

    const form = await clickCreate(onSubmit)
    expect(form.settings).toEqual({ autoCompactWindow: 500000 })
  })

  it('clamps a window below 100k up to 100000', async () => {
    const onSubmit = vi.fn()
    const { baseElement } = render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    fireEvent.change(windowInput(baseElement), { target: { value: '50000' } })

    const form = await clickCreate(onSubmit)
    expect(form.settings).toEqual({ autoCompactWindow: 100000 })
  })

  it('clamps a window above 1M down to 1000000', async () => {
    const onSubmit = vi.fn()
    const { baseElement } = render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    fireEvent.change(windowInput(baseElement), { target: { value: '2000000' } })

    const form = await clickCreate(onSubmit)
    expect(form.settings).toEqual({ autoCompactWindow: 1000000 })
  })

  it('remembers the last window choice and pre-fills the field', async () => {
    const onSubmit = vi.fn()
    const first = render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    fireEvent.change(windowInput(first.baseElement), { target: { value: '500000' } })
    await clickCreate(onSubmit)
    first.unmount()

    const second = render(<NewSessionDialog {...baseProps} onSubmit={vi.fn()} />)
    expect(windowInput(second.baseElement).value).toBe('500000')
  })

  it('remembers the effective value, not raw garbage', async () => {
    // '5e5' parses to 500000 — remember the parsed number, not the raw text;
    // unparseable input means "auto" and must not pre-fill the next dialog
    // with a string that silently keeps meaning auto.
    const onSubmit = vi.fn()
    const first = render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    fireEvent.change(windowInput(first.baseElement), { target: { value: '5e5' } })
    await clickCreate(onSubmit)
    first.unmount()

    const second = render(<NewSessionDialog {...baseProps} onSubmit={vi.fn()} />)
    expect(windowInput(second.baseElement).value).toBe('500000')

    fireEvent.change(windowInput(second.baseElement), { target: { value: '500k' } })
    await clickCreate(onSubmit)
    second.unmount()

    const third = render(<NewSessionDialog {...baseProps} onSubmit={vi.fn()} />)
    expect(windowInput(third.baseElement).value).toBe('')
  })
})

describe('NewSessionDialog synchronous Create double-write', () => {
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

  it('writes both model and cwd to localStorage before the dialog unmounts on the same tick', () => {
    // Pre-seed existing entries so the test proves the second write (cwd)
    // stacks on the latest disk and does not lose the first (model).
    window.localStorage.setItem(
      'claude-react-web:recent-models',
      JSON.stringify(['existing-model']),
    )
    window.localStorage.setItem(
      'claude-react-web:recent-cwds',
      JSON.stringify(['/existing/project']),
    )

    const onSubmit = vi.fn()
    // defaults.model seeds the model field; initialCwd seeds the cwd field.
    const { unmount } = render(
      <NewSessionDialog
        {...baseProps}
        defaults={{ cwd: '/tmp', model: 'new-model' }}
        initialCwd="/new/project"
        onSubmit={onSubmit}
      />,
    )

    const createBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Create',
    )!
    // The parent unmounts this dialog on the same tick as submit (it flips
    // showDialog=false in onSubmit). rememberModel/rememberCwd must write
    // to localStorage BEFORE that unmount — an effect-based persist would
    // race the unmount and lose the write.
    act(() => {
      fireEvent.click(createBtn)
      unmount()
    })

    expect(onSubmit).toHaveBeenCalled()
    expect(
      JSON.parse(localStorage.getItem('claude-react-web:recent-models')!),
    ).toEqual(['new-model', 'existing-model'])
    expect(
      JSON.parse(localStorage.getItem('claude-react-web:recent-cwds')!),
    ).toEqual(['/new/project', '/existing/project'])
  })
})

describe('NewSessionDialog height animation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/enabled-plugins') return Promise.resolve({ plugins: [] })
      if (url === '/mcp-config') return Promise.resolve({ servers: [] })
      return Promise.resolve({})
    })
    measureMock.mockReset()
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    stubResizeObserver()
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(0)
  })
  afterEach(() => {
    clearResizeObserverStub()
    vi.restoreAllMocks()
  })

  // The dialog portals to <body>, so read the box/content from document.
  const body = () => document.querySelector<HTMLElement>('.modal-new-session .modal-section')!
  const content = () => document.querySelector<HTMLElement>('.new-session-content')!

  it('tweens the body height on a content-driven resize', () => {
    let height = 200
    measureMock.mockImplementation(() => height)
    render(<NewSessionDialog {...baseProps} />)
    height = 400
    fireResize(content())
    expect(body().classList.contains('auto-height-animating')).toBe(true)
    expect(body().style.height).toBe('200px')
  })

  it('releases the pin when the tween finishes', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    let height = 200
    measureMock.mockImplementation(() => height)
    render(<NewSessionDialog {...baseProps} />)
    height = 400
    fireResize(content())
    expect(body().style.height).toBe('400px')
    act(() => {
      const evt = new Event('transitionend', { bubbles: true })
      Object.defineProperty(evt, 'propertyName', { value: 'height' })
      body().dispatchEvent(evt)
    })
    expect(body().classList.contains('auto-height-animating')).toBe(false)
    expect(body().style.height).toBe('')
  })
})

describe('NewSessionDialog overlay scrollbar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/enabled-plugins') return Promise.resolve({ plugins: [] })
      if (url === '/mcp-config') return Promise.resolve({ servers: [] })
      return Promise.resolve({})
    })
  })

  it('attaches the project overlay scrollbar to the modal-section scroll body (hides the native one)', () => {
    const { baseElement } = render(<NewSessionDialog {...baseProps} />)
    const section = baseElement.querySelector('.modal-section') as HTMLElement | null
    expect(section).toBeTruthy()
    // Same contract as PermissionDialog: the unified overlay thumb replaces
    // the native 10px bar on the dialog's scroll body — the Advanced-options
    // expansion is what makes it overflow the .modal cap.
    expect(section!.hasAttribute('data-os-native-hidden')).toBe(true)
    const card = baseElement.querySelector('.modal')
    expect(card?.querySelector('.os-track')).toBeTruthy()
  })
})
