import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { api } from '../hooks/useApi'

vi.mock('../hooks/useApi', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
vi.mock('../hooks/useOverlayScrollbar', () => ({ useOverlayScrollbar: () => () => {} }))

// 延迟 import：组件在模块顶层没有 host 判断，这里直接用静态 import 即可。
import { SetupWebImport } from './SetupWebImport'

const ENUMERATION = {
  sourceDir: '/home/me/.claude-react-web',
  exists: true,
  credentials: { available: true, hasToken: true, profileName: 'Work', authTokenMasked: '****1234', baseUrl: 'https://api.example.com', modelCount: 2 },
  mcp: [{ name: 'ctx7', type: 'stdio' as const, command: 'npx', envKeys: ['API_KEY'], exists: false, importErrors: [] }],
  marketplaces: [{ id: 'claude-code', displayName: 'claude-code', sourceUrl: 'https://github.com/example/claude-code', pluginCount: 3, cloneExists: true, exists: true }],
}

beforeEach(() => {
  vi.mocked(api.get).mockResolvedValue(ENUMERATION)
  vi.mocked(api.post).mockResolvedValue({ credentials: null, mcp: { imported: [], skipped: [], failed: [] }, marketplaces: { imported: [], skipped: [], failed: [] } })
})
afterEach(() => vi.clearAllMocks())

describe('SetupWebImport', () => {
  it('shows the probe row first, then the three sections', async () => {
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)
    expect(screen.getByText(/Reading your Claude Web config/)).toBeTruthy()
    expect(await screen.findByText('Work')).toBeTruthy()
    expect(screen.getByText('ctx7')).toBeTruthy()
    expect(screen.getByText('claude-code')).toBeTruthy()
    // 已有同 id 的市场 → 状态位显示既有措辞。
    expect(screen.getByText('Already exists')).toBeTruthy()
  })

  it('reports "not found" instead of an empty list when the source has nothing', async () => {
    vi.mocked(api.get).mockResolvedValue({ ...ENUMERATION, exists: false, credentials: null, mcp: [], marketplaces: [] })
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)
    expect(await screen.findByText(/未找到网页版配置|No Claude Web config found/)).toBeTruthy()
  })

  it('offers Retry when the probe itself fails', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('boom'))
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)
    expect(await screen.findByText('Retry')).toBeTruthy()
  })

  it('posts every not-yet-imported item from the bulk button, then hands over to onConfigured', async () => {
    vi.mocked(api.post).mockResolvedValue({
      credentials: { imported: true, configured: true },
      mcp: { imported: ['ctx7'], skipped: [], failed: [] },
      marketplaces: { imported: [], skipped: ['claude-code'], failed: [] },
    })
    const onConfigured = vi.fn()
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={onConfigured} />)
    await screen.findByText('Work')

    fireEvent.click(screen.getByText('Import all'))
    await waitFor(() => expect(onConfigured).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/config/web-import', {
      credentials: true,
      mcp: ['ctx7'],
      marketplaces: [],
    })
  })

  it('stays on the screen when the import leaves the server unconfigured', async () => {
    vi.mocked(api.post).mockResolvedValue({
      credentials: { imported: true, configured: false },
      mcp: { imported: [], skipped: [], failed: [] },
      marketplaces: { imported: [], skipped: [], failed: [] },
    })
    const onConfigured = vi.fn()
    const onContinue = vi.fn()
    render(<SetupWebImport onContinue={onContinue} onConfigured={onConfigured} />)
    await screen.findByText('Work')

    fireEvent.click(screen.getByText('Import all'))
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalled())
    expect(onConfigured).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Next'))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  // 逐栏失败隔离：坏掉的那一栏必须说清"为什么空"，否则损坏会被读成
  // "对面应用没配过东西"——正是本功能要消灭的误判。
  it('says why a section is empty when its source file could not be read', async () => {
    vi.mocked(api.get).mockResolvedValue({
      ...ENUMERATION,
      credentials: null,
      credentialsError: 'config.json is not valid JSON: Unexpected token <',
      mcp: [],
      mcpError: 'mcp-config.json is not valid JSON: Unexpected token <',
    })
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)

    expect(await screen.findByText(/Credentials unavailable: config\.json/)).toBeTruthy()
    expect(screen.getByText(/MCP servers unavailable: mcp-config\.json/)).toBeTruthy()
    // 另外两栏坏掉不影响这一栏：市场照常列出可导入项。
    expect(screen.getByText('claude-code')).toBeTruthy()
  })

  it('says why the marketplace section is empty when its source file could not be read', async () => {
    vi.mocked(api.get).mockResolvedValue({
      ...ENUMERATION,
      marketplaces: [],
      marketplacesError: 'marketplaces.json is not valid JSON: Unexpected token <',
    })
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)

    expect(await screen.findByText(/Marketplaces unavailable: marketplaces\.json/)).toBeTruthy()
  })
})