import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { UserFileAttachments } from './UserFileAttachments'

describe('UserFileAttachments', () => {
  it('renders a file chip linked to the stored copy', () => {
    const { getByText, getByRole } = render(
      <UserFileAttachments
        file={{ id: 'u1', name: 'a.pdf', size: 2048 }}
        occurrenceKey="u1:1"
      />,
    )
    expect(getByText('2.0 KB')).toBeTruthy()
    expect(getByRole('link').getAttribute('href')).toBe('/api/uploads/u1/content')
    expect(getByRole('link').getAttribute('data-file-occurrence')).toBe('u1:1')
  })

  it('highlights only the matched file name and marks the active occurrence', () => {
    const { getByRole, rerender } = render(
      <UserFileAttachments
        file={{ id: 'u1', name: 'annual-report.pdf', size: 2048 }}
        occurrenceKey="u1:1"
        searchQuery="report"
        active={false}
      />,
    )
    expect(getByRole('link').querySelector('mark.search-hl')?.textContent).toBe('report')
    expect(getByRole('link').querySelector('mark.search-hl-active')).toBeNull()

    rerender(
      <UserFileAttachments
        file={{ id: 'u1', name: 'annual-report.pdf', size: 2048 }}
        occurrenceKey="u1:1"
        searchQuery="report"
        active
      />,
    )
    expect(getByRole('link').querySelector('mark.search-hl-active')?.textContent).toBe('report')
  })
})