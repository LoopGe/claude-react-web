import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  afterEach(cleanup)

  it('renders title, body and action', () => {
    render(
      <EmptyState
        title="No servers"
        body="Add one to start"
        action={<button>Add</button>}
      />,
    )
    expect(screen.getByText('No servers')).toBeTruthy()
    expect(screen.getByText('Add one to start')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy()
  })

  it('renders an icon tile when provided', () => {
    render(<EmptyState title="Empty" icon={<svg data-testid="ico" />} />)
    expect(document.querySelector('[data-testid="ico"]')).toBeTruthy()
    expect(document.querySelector('.empty-state-ui-icon')).toBeTruthy()
  })

  it('omits body/action when not provided', () => {
    render(<EmptyState title="Only title" />)
    expect(document.querySelector('.empty-state-ui-body')).toBeNull()
    expect(document.querySelector('.empty-state-ui-action')).toBeNull()
  })

  it('passes className through to the root', () => {
    const { container } = render(<EmptyState title="Empty" className="extra" />)
    expect((container.firstChild as HTMLElement).className).toContain('extra')
  })
})
