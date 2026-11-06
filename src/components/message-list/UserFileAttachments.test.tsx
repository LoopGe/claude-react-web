import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { UserFileAttachments } from './UserFileAttachments'

describe('UserFileAttachments', () => {
  it('renders one chip per file, linked to the stored copy', () => {
    const { getByText, getAllByRole } = render(
      <UserFileAttachments files={[
        { id: 'u1', name: 'a.pdf', size: 2048 },
        { id: 'u2', name: 'b.txt', size: 3 },
      ]} />,
    )
    expect(getByText('a.pdf')).toBeTruthy()
    expect(getByText('2.0 KB')).toBeTruthy()
    const links = getAllByRole('link')
    expect(links).toHaveLength(2)
    expect(links[0].getAttribute('href')).toBe('/api/uploads/u1/content')
    expect(links[1].getAttribute('href')).toBe('/api/uploads/u2/content')
  })
})