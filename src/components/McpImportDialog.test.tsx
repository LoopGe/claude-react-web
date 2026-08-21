// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { McpImportDialog } from './McpImportDialog'

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))
import { api } from '../hooks/useApi'

afterEach(() => { cleanup(); vi.clearAllMocks() })

function makeFile(content: string): File {
  return new File([content], 'servers.json', { type: 'application/json' })
}

describe('McpImportDialog', () => {
  it('previews new/conflict/invalid sections and imports the checked selection', async () => {
    const preview = {
      servers: [
        { name: 'fresh', type: 'stdio', command: 'npx', errors: [], exists: false },
        { name: 'exists', type: 'stdio', command: 'node', errors: [], exists: true },
        { name: 'bad', type: 'stdio', errors: ['command is required for stdio type'], exists: false },
      ],
    }
    const importResult = { imported: ['fresh'], updated: [], skipped: ['exists'], failed: [] }
    vi.mocked(api.post)
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce(importResult)

    const onImported = vi.fn()
    render(<McpImportDialog open file={makeFile(JSON.stringify({ servers: preview.servers }))} onClose={vi.fn()} onImported={onImported} />)

    // preview renders all three names
    await waitFor(() => expect(document.body.textContent).toContain('fresh'))
    expect(document.body.textContent).toContain('exists')
    expect(document.body.textContent).toContain('bad')

    // fresh (new) + exists (conflict) + "overwrite all existing" — the
    // invalid row renders with no checkbox
    const checkboxes = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    expect(checkboxes).toHaveLength(3)
    expect(checkboxes[0].checked).toBe(true) // fresh (new) default checked
    expect(checkboxes[1].checked).toBe(false) // exists (conflict) default unchecked
    expect(checkboxes[2].checked).toBe(false) // "overwrite all existing" toggle

    // check the conflict row to overwrite it, then import
    fireEvent.click(checkboxes[1])
    fireEvent.click(document.body.querySelector('.btn-primary')!)

    await waitFor(() =>
      expect(api.post).toHaveBeenLastCalledWith('/mcp-config/import', {
        file: expect.stringContaining('fresh'),
        names: ['fresh', 'exists'],
        overwrite: true,
      }),
    )
    // summary shown
    await waitFor(() => expect(document.body.textContent).toContain('Imported: 1'))
    expect(onImported).toHaveBeenCalled()
  })
})
