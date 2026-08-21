// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { McpExportDialog } from './McpExportDialog'
import type { McpServerConfigMeta } from '../types'

const { downloadJson } = vi.hoisted(() => ({ downloadJson: vi.fn() }))

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))
vi.mock('../utils/downloadJson', () => ({ downloadJson }))

import { api } from '../hooks/useApi'

afterEach(() => { cleanup(); vi.clearAllMocks() })

const servers: McpServerConfigMeta[] = [
  { name: 'git', type: 'stdio', command: 'npx', createdAt: 1, updatedAt: 1 },
  { name: 'fs', type: 'stdio', command: 'node', createdAt: 1, updatedAt: 1 },
]

describe('McpExportDialog', () => {
  it('requests all servers by default and triggers a download', async () => {
    const mockGet = vi.mocked(api.get).mockResolvedValue({ format: 'claude-react-web-mcp', version: 1, exportedAt: 1, secretScope: 'masked', servers: [] })
    render(<McpExportDialog open servers={servers} onClose={vi.fn()} />)

    fireEvent.click(document.body.querySelector('.btn-primary')!)

    expect(mockGet).toHaveBeenCalledWith('/mcp-config/export')
    await waitFor(() =>
      expect(downloadJson).toHaveBeenCalledWith('claude-react-web-mcp-servers.json', expect.objectContaining({ format: 'claude-react-web-mcp' })),
    )
  })

  it('filters by the selected subset and appends includeSecrets when checked', async () => {
    const mockGet = vi.mocked(api.get).mockResolvedValue({ format: 'claude-react-web-mcp', version: 1, exportedAt: 1, secretScope: 'full', servers: [] })
    render(<McpExportDialog open servers={servers} onClose={vi.fn()} />)

    const checkboxes = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    // first server checkbox, then fs checkbox, then includeSecrets checkbox
    const fsCheckbox = checkboxes[1]
    fireEvent.click(fsCheckbox) // uncheck fs
    const secretsCheckbox = checkboxes[2]
    fireEvent.click(secretsCheckbox) // check include secrets

    fireEvent.click(document.body.querySelector('.btn-primary')!)

    expect(mockGet).toHaveBeenCalledWith('/mcp-config/export?includeSecrets=1&names=git')
  })
})
