import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { RunAsAgentControl } from './RunAsAgentControl'

const { post } = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('../../hooks/useApi', () => ({ api: { post } }))
vi.mock('../../hooks/useAgentDefinitions', () => ({
  useAgentDefinitions: () => ({ agents: [
    { name: 'reviewer', enabled: true, description: 'Reviews', createdAt: 1, updatedAt: 1, prompt: 'p' },
    { name: 'off', enabled: false, description: 'Off', createdAt: 1, updatedAt: 1, prompt: 'p' },
  ] }),
}))

describe('RunAsAgentControl', () => {
  afterEach(() => { cleanup(); post.mockReset() })
  it('lists only enabled custom agents', () => {
    render(<RunAsAgentControl sessionId="s1" onClose={() => {}} />)
    expect(screen.getByText('reviewer')).toBeTruthy()
    expect(screen.queryByText('off')).toBeNull()
  })
  it('disables confirm when the task is empty', () => {
    render(<RunAsAgentControl sessionId="s1" onClose={() => {}} />)
    expect((screen.getByRole('button', { name: /run/i }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('enqueues the crafted delegation message on confirm', () => {
    render(<RunAsAgentControl sessionId="s1" onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText(/task/i), { target: { value: 'find the bug' } })
    fireEvent.click(screen.getByRole('button', { name: /run/i }))
    expect(post).toHaveBeenCalledWith(
      '/sessions/s1/messages',
      expect.objectContaining({ text: expect.stringMatching(/Agent tool[\s\S]*reviewer[\s\S]*find the bug/) }),
    )
  })
})