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

// jsdom lacks matchMedia; useExitPresence probes it for reduced motion.
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
}))

const baseProps = {
  open: true,
  defaults: { cwd: '/tmp', model: 'claude-sonnet-4-20250514' },
  onSubmit: vi.fn(),
  onCancel: vi.fn(),
  groups: [],
  serverModels: [],
  maxGroupSize: 10,
}

const agentDefs = [
  {
    name: 'reviewer',
    description: 'Reviews',
    prompt: 'P',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    model: 'haiku',
  },
]

describe('NewSessionDialog custom agent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/enabled-plugins') return Promise.resolve({ plugins: [] })
      if (url === '/mcp-config') return Promise.resolve({ servers: [] })
      if (url === '/agent-definitions') return Promise.resolve({ agents: agentDefs })
      return Promise.resolve({})
    })
  })

  it('renders an agent dropdown with custom definitions and prefills model', async () => {
    const onSubmit = vi.fn()
    render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)

    // Wait for the custom agent to appear in the dropdown.
    let select!: HTMLSelectElement
    await waitFor(() => {
      const el = Array.from(document.querySelectorAll<HTMLSelectElement>('select')).find((s) =>
        Array.from(s.options).some((o) => o.value === 'reviewer'),
      )
      expect(el).toBeDefined()
      select = el!
    })
    fireEvent.change(select, { target: { value: 'reviewer' } })

    const buttons = Array.from(document.querySelectorAll('button'))
    const createBtn = buttons.find((b) => b.textContent?.trim() === 'Create')!
    fireEvent.click(createBtn)
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())

    const form = onSubmit.mock.calls[0][0] as NewSessionForm
    expect(form.agent).toBe('reviewer')
    expect(form.model).toBe('haiku') // prefilled from the def
  })

  it('omits agent when None is selected', async () => {
    const onSubmit = vi.fn()
    render(<NewSessionDialog {...baseProps} onSubmit={onSubmit} />)
    await waitFor(() => {
      expect(
        Array.from(document.querySelectorAll<HTMLSelectElement>('select')).some((s) =>
          Array.from(s.options).some((o) => o.value === 'reviewer'),
        ),
      ).toBe(true)
    })

    const buttons = Array.from(document.querySelectorAll('button'))
    const createBtn = buttons.find((b) => b.textContent?.trim() === 'Create')!
    fireEvent.click(createBtn)
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())

    const form = onSubmit.mock.calls[0][0] as NewSessionForm
    expect(form.agent).toBeUndefined()
  })
})