import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { AgentDefinitionForm, validateAgentDefinition } from './AgentDefinitionForm'
import type { StoredAgentDefinition } from '../../types'

function makeDef(over: Partial<StoredAgentDefinition> = {}): StoredAgentDefinition {
  return {
    name: 'reviewer',
    enabled: true,
    description: 'Reviews',
    prompt: 'You are a reviewer.',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

// The form calls `api.post`/`api.put`; the brief's test destructures `post` /
// `put` directly off the module namespace. Alias the same spies to both so the
// form's call and the test's assertion observe the identical mock.
const mocks = vi.hoisted(() => ({ post: vi.fn(), put: vi.fn() }))
vi.mock('../../hooks/useApi', () => ({ post: mocks.post, put: mocks.put, api: { post: mocks.post, put: mocks.put } }))

afterEach(() => cleanup())

describe('AgentDefinitionForm', () => {
  it('blocks save until name/description/prompt are present', () => {
    render(<AgentDefinitionForm onSaved={() => {}} onCancel={() => {}} />)
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: '' } })
    expect(validateAgentDefinition({ name: '', description: '', prompt: '' })).toBe('name is required')
  })
  it('submits a fully valid definition to POST', async () => {
    const { post } = (await import('../../hooks/useApi')) as unknown as {
      post: ReturnType<typeof vi.fn>
    }
    render(<AgentDefinitionForm onSaved={() => {}} onCancel={() => {}} />)
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'reviewer' } })
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'Reviews' } })
    fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: 'You are a reviewer.' } })
    fireEvent.click(screen.getByRole('button', { name: /create/i }))
    expect(post).toHaveBeenCalledWith('/agent-definitions', expect.objectContaining({ data: expect.objectContaining({ name: 'reviewer' }) }))
  })
  it('round-trips a numeric-effort definition on edit as a NUMBER, not a string', async () => {
    render(
      <AgentDefinitionForm
        initial={makeDef({ effort: 0.5 })}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    )
    // The numeric effort renders as a number input (spinbutton), not a select.
    expect(screen.getByLabelText(/effort/i)).toHaveProperty('type', 'number')
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    const { data } = mocks.put.mock.calls[0][1] as { data: Record<string, unknown> }
    expect(data.effort).toBe(0.5)
    expect(typeof data.effort).toBe('number')
  })
})
