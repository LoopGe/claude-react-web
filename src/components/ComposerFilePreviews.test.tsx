import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { ComposerFilePreviews } from './ComposerFilePreviews'
import type { DraftFile } from '../hooks/useFileDrafts'

const ready: DraftFile = {
  key: 'a', status: 'ready', loaded: 3, total: 3,
  upload: { id: 'u1', name: 'a.pdf', size: 3 },
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
    expect(getByText('a.pdf')).toBeTruthy()
    expect(getByText('Uploading…')).toBeTruthy()
    expect(getByText('boom')).toBeTruthy()
    expect(getByLabelText('Remove a.pdf')).toBeTruthy()
    const bar = container.querySelector('.file-preview-bar') as HTMLElement | null
    expect(bar?.style.width).toBe('25%')
  })

  it('links a ready chip to the stored copy and exposes retry/remove', () => {
    const onRemove = vi.fn()
    const onRetry = vi.fn()
    const { getByText, getByLabelText } = render(
      <ComposerFilePreviews files={[ready, failed]} onRemove={onRemove} onRetry={onRetry} />,
    )
    expect(getByText('a.pdf').closest('a')?.getAttribute('href')).toBe('/api/uploads/u1/content')
    fireEvent.click(getByText('Retry'))
    expect(onRetry).toHaveBeenCalledWith('c')
    fireEvent.click(getByLabelText('Remove a.pdf'))
    expect(onRemove).toHaveBeenCalledWith('a')
  })
})