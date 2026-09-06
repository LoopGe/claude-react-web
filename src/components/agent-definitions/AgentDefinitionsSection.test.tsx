import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { AgentDefinitionsSection } from './AgentDefinitionsSection'
import type { StoredAgentDefinition } from '../../types'

const mocks = vi.hoisted(() => ({ post: vi.fn(), put: vi.fn() }))
vi.mock('../../hooks/useApi', () => ({ api: { post: mocks.post, put: mocks.put } }))

afterEach(() => {
  cleanup()
  mocks.post.mockClear()
  mocks.put.mockClear()
})

function makeDef(over: Partial<StoredAgentDefinition> = {}): StoredAgentDefinition {
  return {
    name: 'reviewer',
    enabled: true,
    description: 'Code reviewer',
    prompt: 'You review code',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function renderSection(refresh = vi.fn()) {
  return render(
    <AgentDefinitionsSection
      agents={[makeDef()]}
      toggleEnabled={vi.fn()}
      remove={vi.fn()}
      refresh={refresh}
    />,
  )
}

describe('AgentDefinitionsSection', () => {
  it('renders each definition name and description', () => {
    const { rerender } = renderSection()
    rerender(
      <AgentDefinitionsSection
        agents={[makeDef(), makeDef({ name: 'writer', description: 'Writes prose' })]}
        toggleEnabled={vi.fn()}
        remove={vi.fn()}
        refresh={vi.fn()}
      />,
    )
    expect(screen.getByText('reviewer')).toBeTruthy()
    expect(screen.getByText('writer')).toBeTruthy()
    expect(screen.getByText('Code reviewer')).toBeTruthy()
    expect(screen.getByText('Writes prose')).toBeTruthy()
  })

  it('calls toggleEnabled with the next enabled state', () => {
    const toggleEnabled = vi.fn()
    render(
      <AgentDefinitionsSection
        agents={[makeDef()]}
        toggleEnabled={toggleEnabled}
        remove={vi.fn()}
        refresh={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox'))
    expect(toggleEnabled).toHaveBeenCalledWith('reviewer', false)
  })

  it('calls remove when delete is clicked', () => {
    const remove = vi.fn()
    render(
      <AgentDefinitionsSection
        agents={[makeDef()]}
        toggleEnabled={vi.fn()}
        remove={remove}
        refresh={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    expect(remove).toHaveBeenCalledWith('reviewer')
  })

  it('opens the create form when New is clicked', () => {
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: /new/i }))
    expect(screen.getByText(/new agent/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /create/i })).toBeTruthy()
  })

  it('opens the edit form prefilled for the row when Edit is clicked', () => {
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    expect(screen.getByText(/edit reviewer/i)).toBeTruthy()
    expect(screen.getByLabelText(/name/i)).toHaveProperty('disabled', true)
    expect((screen.getByLabelText(/prompt/i) as HTMLTextAreaElement).value).toBe('You review code')
  })

  it('closes the form and refreshes the list on save', async () => {
    const refresh = vi.fn()
    renderSection(refresh)
    fireEvent.click(screen.getByRole('button', { name: /new/i }))
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'writer' } })
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'Writes' } })
    fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: 'You write.' } })
    fireEvent.click(screen.getByRole('button', { name: /create/i }))
    // After the POST resolves, the form closes back to the list.
    await screen.findByText('reviewer')
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /create/i })).toBeNull()
  })

  it('shows an empty state listing placeholder when there are no agents', () => {
    render(
      <AgentDefinitionsSection
        agents={[]}
        toggleEnabled={vi.fn()}
        remove={vi.fn()}
        refresh={vi.fn()}
      />,
    )
    expect(screen.getByText(/no agents/i)).toBeTruthy()
  })
})
