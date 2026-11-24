import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { ComposerFilePreviews } from './ComposerFilePreviews'
import type { DraftFile } from '../hooks/useFileDrafts'

// The modal's byte source + viewer are owned by UploadPdfModal.test.tsx;
// stub it so the chip tests pin the OPEN/CLOSE behavior (button → preview by
// id → onClose unmounts it). The stub's close button exercises the list's
// setPdfPreview(null) path.
vi.mock('./UploadPdfModal', () => ({
  UploadPdfModal: ({ file, onClose }: { file: { id: string }; onClose: () => void }) => (
    <div data-testid="upload-pdf-modal" data-upload-id={file.id}>
      <button type="button" onClick={onClose}>Close stub</button>
    </div>
  ),
}))

const ready: DraftFile = {
  key: 'a', status: 'ready', loaded: 3, total: 3,
  upload: { id: 'u1', name: 'a.txt', size: 3 },
}
const readyPdf: DraftFile = {
  key: 'p', status: 'ready', loaded: 3, total: 3,
  upload: { id: 'u9', name: 'paper.pdf', size: 3 },
}
const uploading: DraftFile = {
  key: 'b', status: 'uploading', loaded: 1, total: 4,
  file: new File(['x'], 'b.bin'),
}
const failed: DraftFile = {
  key: 'c', status: 'error', loaded: 0, total: 5,
  file: new File(['x'], 'c.bin'), error: 'boom',
}

describe('ComposerFilePreviews', () => {
  it('renders ready, uploading and failed states', () => {
    const { getByText, getByLabelText, container } = render(
      <ComposerFilePreviews files={[ready, uploading, failed]} onRemove={vi.fn()} onRetry={vi.fn()} />,
    )
    expect(getByText('a.txt')).toBeTruthy()
    expect(getByText('Uploading…')).toBeTruthy()
    expect(getByText('boom')).toBeTruthy()
    expect(getByLabelText('Remove a.txt')).toBeTruthy()
    const bar = container.querySelector('.file-preview-bar') as HTMLElement | null
    expect(bar?.style.width).toBe('25%')
  })

  it('links a ready non-PDF chip to the stored copy and exposes retry/remove', () => {
    const onRemove = vi.fn()
    const onRetry = vi.fn()
    const { getByText, getByLabelText } = render(
      <ComposerFilePreviews files={[ready, failed]} onRemove={onRemove} onRetry={onRetry} />,
    )
    expect(getByText('a.txt').closest('a')?.getAttribute('href')).toBe('/api/uploads/u1/content')
    fireEvent.click(getByText('Retry'))
    expect(onRetry).toHaveBeenCalledWith('c')
    fireEvent.click(getByLabelText('Remove a.txt'))
    expect(onRemove).toHaveBeenCalledWith('a')
  })

  it('opens the in-app preview from a ready PDF chip instead of a download link', () => {
    const { getByText, getByTestId, queryByTestId } = render(
      <ComposerFilePreviews files={[readyPdf, ready]} onRemove={vi.fn()} onRetry={vi.fn()} />,
    )
    const pdfChip = getByText('paper.pdf').closest('button')
    expect(pdfChip).not.toBeNull()
    expect(getByText('paper.pdf').closest('a')).toBeNull()
    // The non-PDF sibling keeps its download link.
    expect(getByText('a.txt').closest('a')?.getAttribute('href')).toBe('/api/uploads/u1/content')
    expect(queryByTestId('upload-pdf-modal')).toBeNull()
    fireEvent.click(pdfChip as HTMLElement)
    expect(getByTestId('upload-pdf-modal').getAttribute('data-upload-id')).toBe('u9')
    fireEvent.click(getByText('Close stub'))
    expect(queryByTestId('upload-pdf-modal')).toBeNull()
  })

  it('never opens a preview from an uploading or failed chip', () => {
    const { container, queryByTestId } = render(
      <ComposerFilePreviews files={[uploading, failed]} onRemove={vi.fn()} onRetry={vi.fn()} />,
    )
    expect(container.querySelector('button.file-preview-body')).toBeNull()
    expect(container.querySelector('a.file-preview-body')).toBeNull()
    expect(queryByTestId('upload-pdf-modal')).toBeNull()
  })
})
