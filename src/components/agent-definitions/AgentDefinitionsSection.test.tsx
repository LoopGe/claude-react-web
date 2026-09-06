import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { AgentDefinitionsSection } from './AgentDefinitionsSection'
import type { StoredAgentDefinition } from '../../types'

afterEach(() => cleanup())

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

describe('AgentDefinitionsSection', () => {
  it('renders each definition name and description', () => {
    render(
      <AgentDefinitionsSection
        agents={[makeDef(), makeDef({ name: 'writer', description: 'Writes prose' })]}
        toggleEnabled={vi.fn()}
        remove={vi.fn()}
        onEdit={vi.fn()}
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
        onEdit={vi.fn()}
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
        onEdit={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    expect(remove).toHaveBeenCalledWith('reviewer')
  })

  it('calls onEdit with the definition when edit is clicked (Task 6 stub)', () => {
    const onEdit = vi.fn()
    render(
      <AgentDefinitionsSection
        agents={[makeDef()]}
        toggleEnabled={vi.fn()}
        remove={vi.fn()}
        onEdit={onEdit}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    expect(onEdit).toHaveBeenCalledWith(makeDef())
  })

  it('calls onEdit with undefined when New is clicked (Task 6 stub)', () => {
    const onEdit = vi.fn()
    render(
      <AgentDefinitionsSection
        agents={[]}
        toggleEnabled={vi.fn()}
        remove={vi.fn()}
        onEdit={onEdit}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /new/i }))
    expect(onEdit).toHaveBeenCalledWith(undefined)
  })

  it('shows an empty state listing placeholder when there are no agents', () => {
    render(
      <AgentDefinitionsSection
        agents={[]}
        toggleEnabled={vi.fn()}
        remove={vi.fn()}
        onEdit={vi.fn()}
      />,
    )
    expect(screen.getByText(/no agents/i)).toBeTruthy()
  })
})