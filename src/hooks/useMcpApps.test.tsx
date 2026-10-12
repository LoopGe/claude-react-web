import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, renderHook, screen, waitFor } from '@testing-library/react'
import { McpAppsProvider, extractMcpAppResourceUri, useMcpAppTool } from './useMcpApps'
import type { McpServerStatus } from '../types'
import { api } from './useApi'

vi.mock('./useApi', () => ({
  api: { get: vi.fn() },
}))

describe('extractMcpAppResourceUri', () => {
  it('reads the structured ui.resourceUri and the deprecated flat key', () => {
    expect(extractMcpAppResourceUri({ ui: { resourceUri: 'ui://a/b.html' } })).toBe('ui://a/b.html')
    expect(extractMcpAppResourceUri({ 'ui/resourceUri': 'ui://a/b.html' })).toBe('ui://a/b.html')
  })

  it('rejects non-ui:// schemes and malformed metas', () => {
    expect(extractMcpAppResourceUri({ ui: { resourceUri: 'https://evil.example' } })).toBeUndefined()
    expect(extractMcpAppResourceUri({ ui: 'not-an-object' })).toBeUndefined()
    expect(extractMcpAppResourceUri(undefined)).toBeUndefined()
    expect(extractMcpAppResourceUri({})).toBeUndefined()
  })
})

function Probe({ toolName }: { toolName: string }) {
  const app = useMcpAppTool(toolName)
  return <div>{app ? `${app.server}|${app.uri}` : 'none'}</div>
}

describe('McpAppsProvider lookup', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset()
  })

  it('keys the map by the full mcp__server__tool name and carries the server segment', async () => {
    const statuses = [
      {
        name: 'basic',
        status: 'connected',
        tools: [{ name: 'get-time', _meta: { ui: { resourceUri: 'ui://get-time/mcp-app.html' } } }],
      },
      {
        name: 'plain',
        status: 'connected',
        tools: [{ name: 'no-ui' }],
      },
    ] as unknown as McpServerStatus[]
    vi.mocked(api.get).mockResolvedValue({ mcp: statuses })

    render(
      <McpAppsProvider sessionId="s1">
        <Probe toolName="mcp__basic__get-time" />
        <Probe toolName="mcp__plain__no-ui" />
        <Probe toolName="Bash" />
      </McpAppsProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText('basic|ui://get-time/mcp-app.html')).toBeTruthy()
    })
    // Two matches: the no-UI MCP tool and a built-in tool name both render 'none'.
    expect(screen.getAllByText('none')).toHaveLength(2)
  })

  it('leaves the lookup empty when the status read fails (transcript unaffected)', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('dormant'))
    render(
      <McpAppsProvider sessionId="s1">
        <Probe toolName="mcp__basic__get-time" />
      </McpAppsProvider>,
    )
    await waitFor(() => {
      expect(api.get).toHaveBeenCalled()
    })
    expect(screen.getByText('none')).toBeTruthy()
  })

  it('does not fetch for transcripts that never touch an mcp__ tool', async () => {
    vi.mocked(api.get).mockResolvedValue({ mcp: [] })
    render(
      <McpAppsProvider sessionId="s1">
        <Probe toolName="Bash" />
        <Probe toolName="Read" />
      </McpAppsProvider>,
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(api.get).not.toHaveBeenCalled()
  })

  it('resets the map and refetches when the session switches (stale settles retired)', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      mcp: [{ name: 'basic', status: 'connected', tools: [{ name: 'get-time', _meta: { ui: { resourceUri: 'ui://g/t.html' } } }] }] as unknown as McpServerStatus[],
    })
    const { rerender } = render(
      <McpAppsProvider sessionId="s1">
        <Probe toolName="mcp__basic__get-time" />
      </McpAppsProvider>,
    )
    await waitFor(() => {
      expect(screen.getByText('basic|ui://g/t.html')).toBeTruthy()
    })

    // Switch to s2: the old session's map must not leak across, and s2 gets
    // its own fetch (its status names no apps → 'none').
    vi.mocked(api.get).mockResolvedValueOnce({ mcp: [] })
    rerender(
      <McpAppsProvider sessionId="s2">
        <Probe toolName="mcp__basic__get-time" />
      </McpAppsProvider>,
    )
    await waitFor(() => {
      expect(api.get).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      // Not the old session's entry — s2 genuinely has no apps.
      expect(screen.getByText('none')).toBeTruthy()
    })
  })

  it('retries after a failed fetch when another mcp__ lookup lands (failure is not cached)', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('dormant'))
    vi.mocked(api.get).mockResolvedValueOnce({
      mcp: [{ name: 'basic', status: 'connected', tools: [{ name: 'get-time', _meta: { ui: { resourceUri: 'ui://g/t.html' } } }] }] as unknown as McpServerStatus[],
    })
    // Base impl for any demand beyond the scripted two (the test asserts the
    // exact call count below).
    vi.mocked(api.get).mockResolvedValue({ mcp: [] })
    render(
      <McpAppsProvider sessionId="s1">
        <Probe toolName="mcp__basic__get-time" />
        <Probe toolName="mcp__other__tool" />
      </McpAppsProvider>,
    )
    // First demand fails (dormant session) → the second lookup retries and lands.
    await waitFor(() => {
      expect(screen.getAllByText('none').length).toBeLessThan(2)
    })
    await waitFor(() => {
      expect(screen.getByText('basic|ui://g/t.html')).toBeTruthy()
    })
    expect(api.get).toHaveBeenCalledTimes(2)
  })
})

// Type-level smoke for the exported hook shape (renderHook path).
describe('useMcpApps shape', () => {
  it('returns an empty map outside a provider', () => {
    const { result } = renderHook(() => useMcpAppTool('mcp__x__y'))
    expect(result.current).toBeUndefined()
  })
})
