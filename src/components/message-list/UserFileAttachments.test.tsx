import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { UserFileAttachments } from './UserFileAttachments'

// The modal's byte source + viewer are owned by UploadPdfModal.test.tsx;
// stub it so the chip tests pin the OPEN/CLOSE behavior (button → preview by
// id → onClose unmounts it). The stub's close button exercises the chip's
// setPreviewOpen(false) path.
vi.mock('../UploadPdfModal', () => ({
  UploadPdfModal: ({ file, onClose }: { file: { id: string }; onClose: () => void }) => (
    <div data-testid="upload-pdf-modal" data-upload-id={file.id}>
      <button type="button" onClick={onClose}>Close stub</button>
    </div>
  ),
}))

describe('UserFileAttachments', () => {
  it('renders a non-PDF file chip linked to the stored copy', () => {
    const { getByText, getByRole } = render(
      <UserFileAttachments
        file={{ id: 'u1', name: 'a.txt', size: 2048 }}
        occurrenceKey="u1:1"
      />,
    )
    expect(getByText('2.0 KB')).toBeTruthy()
    expect(getByRole('link').getAttribute('href')).toBe('/api/uploads/u1/content')
    expect(getByRole('link').getAttribute('data-file-occurrence')).toBe('u1:1')
  })

  it('renders a PDF chip as a button that opens the in-app preview, not a download link', () => {
    const { getByRole, getByTestId, queryByRole, queryByTestId } = render(
      <UserFileAttachments
        file={{ id: 'u1', name: 'annual-report.pdf', size: 2048 }}
        occurrenceKey="u1:1"
        searchQuery="report"
      />,
    )
    const chip = getByRole('button')
    expect(chip.getAttribute('data-file-occurrence')).toBe('u1:1')
    expect(chip.querySelector('mark.search-hl')?.textContent).toBe('report')
    expect(queryByRole('link')).toBeNull()
    expect(queryByTestId('upload-pdf-modal')).toBeNull()
    fireEvent.click(chip)
    expect(getByTestId('upload-pdf-modal').getAttribute('data-upload-id')).toBe('u1')
    fireEvent.click(getByRole('button', { name: 'Close stub' }))
    expect(queryByTestId('upload-pdf-modal')).toBeNull()
  })

  it('highlights only the matched file name and marks the active occurrence', () => {
    const { getByRole, rerender } = render(
      <UserFileAttachments
        file={{ id: 'u1', name: 'annual-report.txt', size: 2048 }}
        occurrenceKey="u1:1"
        searchQuery="report"
        active={false}
      />,
    )
    expect(getByRole('link').querySelector('mark.search-hl')?.textContent).toBe('report')
    expect(getByRole('link').querySelector('mark.search-hl-active')).toBeNull()

    rerender(
      <UserFileAttachments
        file={{ id: 'u1', name: 'annual-report.txt', size: 2048 }}
        occurrenceKey="u1:1"
        searchQuery="report"
        active
      />,
    )
    expect(getByRole('link').querySelector('mark.search-hl-active')?.textContent).toBe('report')
  })
})
