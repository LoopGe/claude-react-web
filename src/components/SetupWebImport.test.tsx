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

  it('reports "nothing importable" instead of an empty list when the source has nothing', async () => {
    vi.mocked(api.get).mockResolvedValue({ ...ENUMERATION, exists: false, credentials: null, mcp: [], marketplaces: [] })
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)
    expect(await screen.findByText('Nothing importable from the web version.')).toBeTruthy()
    // 真正探测到的目录照常显示，用户可以自己去看那一份。
    expect(screen.getByText(ENUMERATION.sourceDir)).toBeTruthy()
  })

  it('offers Retry when the probe itself fails', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('boom'))
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)
    expect(await screen.findByText('Retry')).toBeTruthy()
  })

  // 行勾选与 Import all 只**导入**，不跳转：勾一行读作"导入这一项"，不该把整屏
  // 收掉。收尾是 Next 的事（见下面三条用例）。
  it('posts every not-yet-imported item from the bulk button without handing over', async () => {
    vi.mocked(api.post).mockResolvedValue({
      credentials: { imported: true, configured: true },
      mcp: { imported: ['ctx7'], skipped: [], failed: [] },
      marketplaces: { imported: [], skipped: ['claude-code'], failed: [] },
    })
    const onConfigured = vi.fn()
    const onContinue = vi.fn()
    render(<SetupWebImport onContinue={onContinue} onConfigured={onConfigured} />)
    await screen.findByText('Work')

    fireEvent.click(screen.getByText('Import all'))
    // 响应说 configured: true，但 Import all 自己不交接：状态位照常落
    // （导入行为没变），屏幕留着。
    await waitFor(() => expect(screen.getAllByText('Imported')).toHaveLength(2))
    expect(onConfigured).not.toHaveBeenCalled()
    expect(onContinue).not.toHaveBeenCalled()
    expect(screen.getByText('Next')).toBeTruthy()
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/config/web-import', {
      credentials: true,
      mcp: ['ctx7'],
      marketplaces: [],
      // 明确给足超时：这次 POST 要拷最多上百 MB，transport 的 30 s 默认值
      // 够得着（客户端 abort 时服务端照旧跑完并落盘，用户会误以为失败）。
      // 硬编码 180_000 就是那一条要求的钉子，改小这里必须是有意的。
    }, { timeoutMs: 180_000 })
  })

  // 用户勾一行 = "导入这一项"，绝不是"收尾"：即使服务端回 configured: true
  // （本屏只在未配置时渲染，所以它只可能来自本屏自己那次导入），也必须留在
  // 屏上等用户自己按 Next。
  it('does not hand over when only the credentials row is ticked, even if the server reports configured', async () => {
    vi.mocked(api.get).mockResolvedValue({ ...ENUMERATION, mcp: [], marketplaces: [] })
    vi.mocked(api.post).mockResolvedValue({
      credentials: { imported: true, configured: true },
      mcp: { imported: [], skipped: [], failed: [] },
      marketplaces: { imported: [], skipped: [], failed: [] },
    })
    const onConfigured = vi.fn()
    const onContinue = vi.fn()
    render(<SetupWebImport onContinue={onContinue} onConfigured={onConfigured} />)
    await screen.findByText('Work')

    fireEvent.click(screen.getByLabelText('Import credentials'))
    await waitFor(() => expect(screen.getByText('Imported')).toBeTruthy())

    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/config/web-import', {
      credentials: true,
      mcp: [],
      marketplaces: [],
    }, { timeoutMs: 180_000 })
    expect(onConfigured).not.toHaveBeenCalled()
    expect(onContinue).not.toHaveBeenCalled()
    // 屏幕还在（Next 就是它自己的按钮）。
    expect(screen.getByText('Next')).toBeTruthy()
  })

  // Next 是本屏唯一的交接口：服务端已 configured（由某次带凭证的导入写成）
  // 时点 Next 才收尾。
  it('hands over to onConfigured from Next when an import left the server configured', async () => {
    vi.mocked(api.get).mockResolvedValue({ ...ENUMERATION, mcp: [], marketplaces: [] })
    vi.mocked(api.post).mockResolvedValue({
      credentials: { imported: true, configured: true },
      mcp: { imported: [], skipped: [], failed: [] },
      marketplaces: { imported: [], skipped: [], failed: [] },
    })
    const onConfigured = vi.fn()
    const onContinue = vi.fn()
    render(<SetupWebImport onContinue={onContinue} onConfigured={onConfigured} />)
    await screen.findByText('Work')

    fireEvent.click(screen.getByLabelText('Import credentials'))
    await waitFor(() => expect(screen.getByText('Imported')).toBeTruthy())
    expect(onConfigured).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Next'))
    await waitFor(() => expect(onConfigured).toHaveBeenCalledTimes(1))
    expect(onContinue).not.toHaveBeenCalled()
  })

  // 什么都没导入（或导入没让服务端 configured）→ Next 照旧进向导。
  it('goes to onContinue from Next when nothing left the server configured', async () => {
    const onConfigured = vi.fn()
    const onContinue = vi.fn()
    render(<SetupWebImport onContinue={onContinue} onConfigured={onConfigured} />)
    await screen.findByText('Work')

    fireEvent.click(screen.getByText('Next'))
    expect(onContinue).toHaveBeenCalledTimes(1)
    expect(onConfigured).not.toHaveBeenCalled()
  })

  it('stays on the screen when the import leaves the server unconfigured, and Next continues the wizard', async () => {
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
    // 等导入落定：Next 在 submitting 期间禁用（这里也顺带证明导入结束后它
    // 重新可用）。
    await waitFor(() => expect(screen.getByText('Imported')).toBeTruthy())
    await waitFor(() => expect((screen.getByText('Next') as HTMLButtonElement).disabled).toBe(false))
    expect(onConfigured).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Next'))
    expect(onContinue).toHaveBeenCalledTimes(1)
    expect(onConfigured).not.toHaveBeenCalled()
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

  // 源的克隆目录不在了 → 导入必然失败（服务端 `clone dir is missing`），
  // 所以这一行不可提供：勾选框禁用 + 不进 Import all 的 payload。
  it('does not offer a marketplace whose clone dir is gone', async () => {
    vi.mocked(api.get).mockResolvedValue({
      ...ENUMERATION,
      marketplaces: [{ ...ENUMERATION.marketplaces[0], exists: false, cloneExists: false }],
    })
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)
    await screen.findByText('Work')

    expect((screen.getByLabelText('Import claude-code') as HTMLInputElement).disabled).toBe(true)
    // 行上照旧说明原因（复用既有措辞）。
    expect(screen.getByText(/clone missing/)).toBeTruthy()

    fireEvent.click(screen.getByText('Import all'))
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalled())
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/config/web-import', {
      credentials: true,
      mcp: ['ctx7'],
      marketplaces: [],
    }, { timeoutMs: 180_000 })
  })

  // 校验不过的 MCP 行同理：服务端会逐项判 failed，不提供一个必然失败的点击；
  // 旁边能导入的那条照常进 payload（predicate 与 filter 同构）。
  it('does not offer an MCP server that fails validation', async () => {
    vi.mocked(api.get).mockResolvedValue({
      ...ENUMERATION,
      mcp: [
        { ...ENUMERATION.mcp[0], name: 'broken', importErrors: ['command is required'] },
        ENUMERATION.mcp[0],
      ],
    })
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)
    await screen.findByText('Work')

    expect((screen.getByLabelText('Import broken') as HTMLInputElement).disabled).toBe(true)
    // 原因行照旧显示。
    expect(screen.getByText('command is required')).toBeTruthy()

    fireEvent.click(screen.getByText('Import all'))
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalled())
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/config/web-import', {
      credentials: true,
      mcp: ['ctx7'],
      marketplaces: [],
    }, { timeoutMs: 180_000 })
  })

  // 一次导入把某些行弄成 Failed 之后，那些行要能重试、按钮不能因此消失
  // （step 3 的 rowDisabled 只排除 imported/exists/importing，failed 不算）。
  it('keeps offering Import all after a failed import, and retries that row', async () => {
    // 凭证那一栏故意缺席：留着它的话，凭证行自己就会把 Import all 撑住，
    // "按钮会不会因为 failed 而消失"这一半就测不到了。
    vi.mocked(api.get).mockResolvedValue({ ...ENUMERATION, credentials: null })
    vi.mocked(api.post)
      .mockResolvedValueOnce({
        credentials: null,
        mcp: { imported: [], skipped: [], failed: [{ name: 'ctx7', error: 'boom' }] },
        marketplaces: { imported: [], skipped: [], failed: [] },
      })
      .mockResolvedValueOnce({
        credentials: null,
        mcp: { imported: ['ctx7'], skipped: [], failed: [] },
        marketplaces: { imported: [], skipped: [], failed: [] },
      })
    const onConfigured = vi.fn()
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={onConfigured} />)
    await screen.findByText('ctx7')

    fireEvent.click(screen.getByText('Import all'))
    // ctx7 落成 Failed —— 此时已经没有 idle 的项了。
    await waitFor(() => expect(screen.getAllByText('Failed')).toHaveLength(1))

    // 按钮仍在，且下一次 POST 又把 ctx7 带上（failed 行重新可导入）。
    fireEvent.click(screen.getByText('Import all'))
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.post)).toHaveBeenLastCalledWith('/config/web-import', {
      credentials: false,
      mcp: ['ctx7'],
      marketplaces: [],
    }, { timeoutMs: 180_000 })
    expect(onConfigured).not.toHaveBeenCalled()
  })

  // onConfigured 是 parent 的 best-effort 收尾（App.handleConfigured 自己吞掉
  // 那次 /config 刷新的失败），且它与导入是两次独立的动作：抛错只进 console，
  // 绝不能在屏上冒出 "Import failed"（导入本身早就成功了）。
  it('does not report the import as failed when the hand-off itself rejects', async () => {
    vi.mocked(api.post).mockResolvedValue({
      credentials: { imported: true, configured: true },
      mcp: { imported: ['ctx7'], skipped: [], failed: [] },
      marketplaces: { imported: [], skipped: [], failed: [] },
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onConfigured = vi.fn(async () => { throw new Error('refresh blew up') })
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={onConfigured} />)
    await screen.findByText('Work')

    fireEvent.click(screen.getByText('Import all'))
    await waitFor(() => expect(screen.getAllByText('Imported')).toHaveLength(2))
    fireEvent.click(screen.getByText('Next'))
    await waitFor(() => expect(onConfigured).toHaveBeenCalledTimes(1))
    // 失败进 console（与 App.handleConfigured 同侧），不是顶部的 Import failed。
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    errSpy.mockRestore()

    // 导入本身成功：行上还是 Imported，没有 "Import failed"，也没有原始错误文案。
    expect((screen.getByLabelText('Import credentials') as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByText('Import failed')).toBeNull()
    expect(screen.queryByText('refresh blew up')).toBeNull()
  })

  // 交接自己抛错时本屏没被卸载 —— 屏幕必须留在原处且控件可用，用户能再点一次
  // Next 重试（parent 那次 /config 刷新失败是可恢复的）。
  it('keeps the screen usable when the hand-off rejects', async () => {
    vi.mocked(api.post).mockResolvedValue({
      credentials: { imported: true, configured: true },
      mcp: { imported: ['ctx7'], skipped: [], failed: [] },
      marketplaces: { imported: [], skipped: [], failed: [] },
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onConfigured = vi.fn(async () => { throw new Error('refresh blew up') })
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={onConfigured} />)
    await screen.findByText('Work')

    fireEvent.click(screen.getByText('Import all'))
    await waitFor(() => expect(screen.getAllByText('Imported')).toHaveLength(2))
    fireEvent.click(screen.getByText('Next'))
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    errSpy.mockRestore()

    expect((screen.getByText('Next') as HTMLButtonElement).disabled).toBe(false)
    // 已经 Imported 的凭证行照旧勾上、且可交互判定不变；市场那一行（源里
    // already exists）也没被这半条路径改坏。
    expect((screen.getByLabelText('Import credentials') as HTMLInputElement).checked).toBe(true)
  })

  // 请求本身抛了（超时 / 网络 / 5xx / 400）：被选中的行必须落 Failed 而不是
  // 永远停在 Importing… —— 否则行被禁用、anyImportable 把 importing 当"在飞"、
  // Import all 直接消失，用户没有任何重试口。
  it('marks the selected rows Failed (and keeps Import all) when the request itself rejects', async () => {
    // 凭证那栏故意缺席：留着它的话，凭证行自己会把 Import all 撑住，
    // "按钮会不会因为 importing 而消失"这一半就测不到了。
    vi.mocked(api.get).mockResolvedValue({ ...ENUMERATION, credentials: null, marketplaces: [] })
    vi.mocked(api.post).mockRejectedValue(new Error('Request timed out after 180s'))
    const onConfigured = vi.fn()
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={onConfigured} />)
    await screen.findByText('ctx7')

    fireEvent.click(screen.getByText('Import all'))
    await waitFor(() => expect(screen.getByText('Failed')).toBeTruthy())
    // 错误行照常渲染（role=alert 就是那句 error 行）。
    expect(screen.getByRole('alert').textContent).toContain('Request timed out after 180s')
    // 行可重试：勾选框不再禁用。
    expect((screen.getByLabelText('Import ctx7') as HTMLInputElement).disabled).toBe(false)
    // Import all 仍在（不是被 importing 卡成 Importing… 而消失）。
    expect(screen.getByText('Import all')).toBeTruthy()
    expect(onConfigured).not.toHaveBeenCalled()
  })
})
