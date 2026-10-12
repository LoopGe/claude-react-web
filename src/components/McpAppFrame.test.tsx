import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { McpAppFrame } from './McpAppFrame'
import { api } from '../hooks/useApi'

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn() },
}))

const PROPS = {
  sessionId: 's1',
  server: 'basic',
  resourceUri: 'ui://get-time/mcp-app.html',
  toolName: 'mcp__basic__get-time',
}

describe('McpAppFrame (MCP Apps read-only render)', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset()
  })

  it('fetches the resource through the session route and renders a sandboxed iframe', async () => {
    vi.mocked(api.get).mockResolvedValue({ mimeType: 'text/html;profile=mcp-app', html: '<html><body>APP</body></html>' })
    const { container } = render(<McpAppFrame {...PROPS} />)

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith(
        `/sessions/s1/mcp-app-resource?server=basic&uri=${encodeURIComponent('ui://get-time/mcp-app.html')}`,
      )
    })
    const frame = await waitFor(() => container.querySelector('iframe'))
    expect(frame).not.toBeNull()
    // Security boundary: scripts may run, but the document gets an opaque
    // origin — no allow-same-origin means it can never reach this app.
    expect(frame!.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame!.getAttribute('srcdoc')).toContain('APP')
  })

  it('shows an error note when the route rejects', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('resource is not an MCP Apps HTML document'))
    render(<McpAppFrame {...PROPS} />)

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain("Couldn't load app UI")
    })
    expect(document.querySelector('iframe')).toBeNull()
  })
})
