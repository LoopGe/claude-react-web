import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

/** 主按钮的文案带选中数（`Import selected (2)`），这里只按前缀取。 */
const importSelectedBtn = () => screen.getByText(/^Import selected \(/) as HTMLButtonElement
const selectAllBtn = () => screen.getByText('Select all importable') as HTMLButtonElement
const box = (label: string) => screen.getByLabelText(label) as HTMLInputElement

describe('SetupWebImport', () => {
  // ── 分区：每一类自己的标题 + 计数 ──────────────────────────────────────────
  it('shows the probe row first, then the three labelled sections', async () => {
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)
    expect(screen.getByText(/Reading your Claude Web config/)).toBeTruthy()
    expect(await screen.findByText('Work')).toBeTruthy()
    // 三者不再是一条无头平铺清单：每类都有自己的标题 + 计数。
    expect(screen.getByText('Credentials and models (1)')).toBeTruthy()
    expect(screen.getByText('MCP servers (1)')).toBeTruthy()
    expect(screen.getByText('Marketplaces (1)')).toBeTruthy()
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
    const dirLine = screen.getByText(ENUMERATION.sourceDir)
    expect(dirLine).toBeTruthy()
    // 用户选的 `--state-dir` 是任意长的无断点串（Windows 反斜杠没有断点），
    // 这一行与那些 URL 同一处置。
    expect((dirLine as HTMLElement).style.overflowWrap).toBe('anywhere')
  })

  it('offers Retry when the probe itself fails', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('boom'))
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)
    expect(await screen.findByText('Retry')).toBeTruthy()
  })

  // ── 勾选是"选择"，不是立刻写 ────────────────────────────────────────────────
  // 人报的两件事之一："勾了就撤不回来"。勾选只落进组件里的选择集，一个请求都不发；
  // 撤回必须能完整回到原状（计数、payload、行状态）。
  it('never writes on a tick, and unticking reverts the selection completely', async () => {
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)
    await screen.findByText('Work')

    // 什么都没勾：0 个选中，主按钮禁用。
    expect(importSelectedBtn().textContent).toBe('Import selected (0)')
    expect(importSelectedBtn().disabled).toBe(true)

    fireEvent.click(box('Import credentials'))
    expect(box('Import credentials').checked).toBe(true)
    // 一次勾选没有任何副作用：不发请求，行上也没有任何状态位。
    expect(vi.mocked(api.post)).not.toHaveBeenCalled()
    expect(screen.queryByText('Importing…')).toBeNull()
    expect(importSelectedBtn().textContent).toBe('Import selected (1)')
    expect(importSelectedBtn().disabled).toBe(false)

    fireEvent.click(box('Import ctx7'))
    expect(importSelectedBtn().textContent).toBe('Import selected (2)')

    // 逐条撤回 → 完全回到原状。
    fireEvent.click(box('Import ctx7'))
    expect(box('Import ctx7').checked).toBe(false)
    expect(importSelectedBtn().textContent).toBe('Import selected (1)')
    fireEvent.click(box('Import credentials'))
    expect(box('Import credentials').checked).toBe(false)
    expect(importSelectedBtn().textContent).toBe('Import selected (0)')
    expect(importSelectedBtn().disabled).toBe(true)
    expect(vi.mocked(api.post)).not.toHaveBeenCalled()
  })

  it('imports exactly the selected subset when Import selected is pressed', async () => {
    vi.mocked(api.post).mockResolvedValue({
      credentials: { imported: true, configured: true },
      mcp: { imported: ['ctx7'], skipped: [], failed: [] },
      marketplaces: { imported: [], skipped: [], failed: [] },
    })
    const onConfigured = vi.fn()
    const onContinue = vi.fn()
    render(<SetupWebImport onContinue={onContinue} onConfigured={onConfigured} />)
    await screen.findByText('Work')

    // 只勾凭证与 MCP 那两条；市场（已有同 id）不在这份选择里。
    fireEvent.click(box('Import credentials'))
    fireEvent.click(box('Import ctx7'))
    fireEvent.click(importSelectedBtn())

    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/config/web-import', {
      credentials: true,
      mcp: ['ctx7'],
      marketplaces: [],
      // 明确给足超时：这次 POST 要拷最多上百 MB，transport 的 30 s 默认值
      // 够得着（客户端 abort 时服务端照旧跑完并落盘，用户会误以为失败）。
      // 硬编码 180_000 就是那一条要求的钉子，改小这里必须是有意的。
    }, { timeoutMs: 180_000 })

    // 导入行为不变：状态位照常落；Import selected 自己不交接，屏幕留着。
    await waitFor(() => expect(screen.getAllByText('Imported')).toHaveLength(2))
    expect(onConfigured).not.toHaveBeenCalled()
    expect(onContinue).not.toHaveBeenCalled()
    expect(screen.getByText('Next')).toBeTruthy()
  })

  // happy path 仍是两击：Select all importable → Import selected (n)。
  it('selects every importable row in one click, and only those', async () => {
    vi.mocked(api.post).mockResolvedValue({
      credentials: { imported: true, configured: true },
      mcp: { imported: ['ctx7'], skipped: [], failed: [] },
      marketplaces: { imported: [], skipped: ['claude-code'], failed: [] },
    })
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)
    await screen.findByText('Work')

    fireEvent.click(selectAllBtn())
    expect(box('Import credentials').checked).toBe(true)
    expect(box('Import ctx7').checked).toBe(true)
    // 已完成的行（已有同 id 的市场）照旧勾着 + 禁用，但**不进**这份选择：
    // 计数与 payload 都只算"还能导入"的那些。
    expect(box('Import claude-code').checked).toBe(true)
    expect(box('Import claude-code').disabled).toBe(true)
    expect(importSelectedBtn().textContent).toBe('Import selected (2)')

    fireEvent.click(importSelectedBtn())
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/config/web-import', {
      credentials: true,
      mcp: ['ctx7'],
      marketplaces: [],
    }, { timeoutMs: 180_000 })
  })

  it('disables both controls while a request is in flight', async () => {
    let settle: (res: unknown) => void = () => {}
    vi.mocked(api.post).mockImplementation(
      () => new Promise<unknown>((resolve) => { settle = resolve }),
    )
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)
    await screen.findByText('Work')

    fireEvent.click(selectAllBtn())
    // 已有同 id 的市场不进选择 → 选中 2 条（凭证 + ctx7）。
    expect(importSelectedBtn().textContent).toBe('Import selected (2)')
    fireEvent.click(importSelectedBtn())

    // 在飞：主按钮换成 Importing… 且禁用，Select all 与行上的勾选框一并锁住。
    const importingBtn = screen.getByRole('button', { name: 'Importing…' }) as HTMLButtonElement
    expect(importingBtn.disabled).toBe(true)
    expect(selectAllBtn().disabled).toBe(true)
    expect(box('Import ctx7').disabled).toBe(true)

    await act(async () => {
      settle({
        credentials: { imported: true, configured: false },
        mcp: { imported: ['ctx7'], skipped: [], failed: [] },
        marketplaces: { imported: [], skipped: [], failed: [] },
      })
    })
    // 全部落定 → 选中的那些已经不能导入：计数归零，两个控件都禁用。
    await waitFor(() => expect(screen.getAllByText('Imported')).toHaveLength(2))
    expect(importSelectedBtn().textContent).toBe('Import selected (0)')
    expect(importSelectedBtn().disabled).toBe(true)
    expect(selectAllBtn().disabled).toBe(true)
    // 已落定的行是终态：勾着 + 禁用。
    expect(box('Import ctx7').checked).toBe(true)
    expect(box('Import ctx7').disabled).toBe(true)
  })

  // 用户勾一行 = "这次要导入这一项"，绝不是"收尾"：即使服务端回 configured: true
  // （本屏只在未配置时渲染，所以它只可能来自本屏自己那次导入），也必须留在
  // 屏上等用户自己按 Next。
  it('does not hand over when only the credentials row is selected, even if the server reports configured', async () => {
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

    fireEvent.click(box('Import credentials'))
    fireEvent.click(importSelectedBtn())
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

    fireEvent.click(box('Import credentials'))
    fireEvent.click(importSelectedBtn())
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

    fireEvent.click(selectAllBtn())
    fireEvent.click(importSelectedBtn())
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
  // "对面应用没配过东西"——正是本功能要消灭的误判。错误行留在自己那一栏里，
  // 标题与计数照常（用户知道它在说哪一类）。
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
    expect(screen.getByText('Credentials and models (0)')).toBeTruthy()
    expect(screen.getByText('MCP servers (0)')).toBeTruthy()
    // 另外两栏坏掉不影响这一栏：市场照常列出可导入项。
    expect(screen.getByText('claude-code')).toBeTruthy()
    expect(screen.getByText('Marketplaces (1)')).toBeTruthy()
  })

  it('says why the marketplace section is empty when its source file could not be read', async () => {
    vi.mocked(api.get).mockResolvedValue({
      ...ENUMERATION,
      marketplaces: [],
      marketplacesError: 'marketplaces.json is not valid JSON: Unexpected token <',
    })
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)

    expect(await screen.findByText(/Marketplaces unavailable: marketplaces\.json/)).toBeTruthy()
    expect(screen.getByText('Marketplaces (0)')).toBeTruthy()
  })

  // 源的克隆目录不在了 → 导入必然失败（服务端 `clone dir is missing`），
  // 所以这一行不可提供：勾选框禁用 + 不进 Select all / payload。
  it('does not offer a marketplace whose clone dir is gone', async () => {
    vi.mocked(api.get).mockResolvedValue({
      ...ENUMERATION,
      marketplaces: [{ ...ENUMERATION.marketplaces[0], exists: false, cloneExists: false }],
    })
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)
    await screen.findByText('Work')

    expect(box('Import claude-code').disabled).toBe(true)
    // 行上照旧说明原因（复用既有措辞）。
    expect(screen.getByText(/clone missing/)).toBeTruthy()

    fireEvent.click(selectAllBtn())
    expect(box('Import claude-code').checked).toBe(false)
    expect(importSelectedBtn().textContent).toBe('Import selected (2)')

    fireEvent.click(importSelectedBtn())
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalled())
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/config/web-import', {
      credentials: true,
      mcp: ['ctx7'],
      marketplaces: [],
    }, { timeoutMs: 180_000 })
  })

  // 校验不过的 MCP 行同理：服务端会逐项判 failed，不提供一个必然失败的点击；
  // 旁边能导入的那条照常进 payload（predicate 与选择集同构）。
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

    expect(box('Import broken').disabled).toBe(true)
    // 原因行照旧显示。
    expect(screen.getByText('command is required')).toBeTruthy()

    fireEvent.click(selectAllBtn())
    expect(box('Import broken').checked).toBe(false)
    expect(importSelectedBtn().textContent).toBe('Import selected (2)')

    fireEvent.click(importSelectedBtn())
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalled())
    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/config/web-import', {
      credentials: true,
      mcp: ['ctx7'],
      marketplaces: [],
    }, { timeoutMs: 180_000 })
  })

  // 一行都导不进去时，两个控件都是禁用的（不给一个必然空转的点击）。
  it('disables both controls when nothing is importable', async () => {
    vi.mocked(api.get).mockResolvedValue({
      ...ENUMERATION,
      credentials: null,
      mcp: [{ ...ENUMERATION.mcp[0], importErrors: ['command is required'] }],
    })
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)
    await screen.findByText('ctx7')

    expect(selectAllBtn().disabled).toBe(true)
    expect(importSelectedBtn().textContent).toBe('Import selected (0)')
    expect(importSelectedBtn().disabled).toBe(true)
  })

  // 源里没有可用 profile（服务端 `available: false`）时那一行**导不进去**：按
// "不可用"渲染（压暗 + 禁用 + 一行原因），而不是一个既没有原因、也无从成功的
// `Failed`；它同时不进 Import selected 与 Select all importable。
  // 顺带钉住 modelCount 不再谎报：源里的列表活不过 coercion，服务端就不报条数
  // （那时的列表是 fallback 默认值）。
  it('renders an unusable credentials row as unavailable, and never counts a fallback list', async () => {
    vi.mocked(api.get).mockResolvedValue({
      ...ENUMERATION,
      credentials: { available: false, hasToken: false, profileName: 'Default', baseUrl: 'https://api.anthropic.com' },
      mcp: [],
      marketplaces: [],
    })
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)
    await screen.findByText('Default')

    // 行照旧列出来（用户知道有这么一栏），但不可点、整行压暗。
    expect(screen.getByText('Credentials and models (1)')).toBeTruthy()
    expect(box('Import credentials').disabled).toBe(true)
    expect(box('Import credentials').checked).toBe(false)
    expect((box('Import credentials').parentElement as HTMLElement).style.opacity).toBe('0.55')
    // 一行原因，不是没有解释的 Failed。
    expect(screen.getByText('No token or model list to copy from this profile.')).toBeTruthy()
    // 不报模型条数（源里那份活不过 coercion）。
    expect(screen.queryByText(/model\(s\)/)).toBeNull()
    // 两个控件都把它排除在外。
    expect(selectAllBtn().disabled).toBe(true)
    expect(importSelectedBtn().textContent).toBe('Import selected (0)')
    expect(importSelectedBtn().disabled).toBe(true)
    // 而且按下 Import selected 也不会发出请求（按钮禁用只是第一层）。
    expect(vi.mocked(api.post)).not.toHaveBeenCalled()
  })

  // 一次导入把某些行弄成 Failed 之后，那些行要能重试、控件不能因此消失
  // （失败不算"在飞"，也不算"已落定"：failed 行重新可导入，且它仍在选择集里）。
  it('keeps a failed row selectable and retries it without re-ticking', async () => {
    // 凭证那一栏故意缺席：留着它的话，凭证行自己就会把按钮撑住，
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

    fireEvent.click(selectAllBtn())
    fireEvent.click(importSelectedBtn())
    // ctx7 落成 Failed —— 此时已经没有 idle 的项了。
    await waitFor(() => expect(screen.getAllByText('Failed')).toHaveLength(1))

    // 控件仍在、行仍可导入：再点一次就是重试（不用重新勾）。
    expect(importSelectedBtn().textContent).toBe('Import selected (1)')
    expect(importSelectedBtn().disabled).toBe(false)
    expect(box('Import ctx7').disabled).toBe(false)

    fireEvent.click(importSelectedBtn())
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

    fireEvent.click(selectAllBtn())
    fireEvent.click(importSelectedBtn())
    await waitFor(() => expect(screen.getAllByText('Imported')).toHaveLength(2))
    fireEvent.click(screen.getByText('Next'))
    await waitFor(() => expect(onConfigured).toHaveBeenCalledTimes(1))
    // 失败进 console（与 App.handleConfigured 同侧），不是顶部的 Import failed。
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    errSpy.mockRestore()

    // 导入本身成功：行上还是 Imported，没有 "Import failed"，也没有原始错误文案。
    expect(box('Import credentials').checked).toBe(true)
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

    fireEvent.click(selectAllBtn())
    fireEvent.click(importSelectedBtn())
    await waitFor(() => expect(screen.getAllByText('Imported')).toHaveLength(2))
    fireEvent.click(screen.getByText('Next'))
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    errSpy.mockRestore()

    expect((screen.getByText('Next') as HTMLButtonElement).disabled).toBe(false)
    // 已经 Imported 的凭证行照旧勾上、且可交互判定不变；市场那一行（源里
    // already exists）也没被这半条路径改坏。
    expect(box('Import credentials').checked).toBe(true)
  })

  // 请求本身抛了（超时 / 网络 / 5xx / 400）：被选中的行必须落 Failed 而不是
  // 永远停在 Importing… —— 否则行被禁用、选择集还在但按钮文案卡在 Importing…，
  // 用户没有任何重试口。
  it('marks the selected rows Failed (and keeps the retry affordance) when the request itself rejects', async () => {
    // 凭证那栏故意缺席：留着它的话，凭证行自己会把按钮撑住，
    // "按钮会不会因为 importing 而消失"这一半就测不到了。
    vi.mocked(api.get).mockResolvedValue({ ...ENUMERATION, credentials: null, marketplaces: [] })
    vi.mocked(api.post).mockRejectedValue(new Error('Request timed out after 180s'))
    const onConfigured = vi.fn()
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={onConfigured} />)
    await screen.findByText('ctx7')

    fireEvent.click(selectAllBtn())
    fireEvent.click(importSelectedBtn())
    await waitFor(() => expect(screen.getByText('Failed')).toBeTruthy())
    // 错误行照常渲染（role=alert 就是那句 error 行）。
    expect(screen.getByRole('alert').textContent).toContain('Request timed out after 180s')
    // 行可重试：勾选框不再禁用，选择也还在。
    expect(box('Import ctx7').disabled).toBe(false)
    expect(box('Import ctx7').checked).toBe(true)
    expect(importSelectedBtn().textContent).toBe('Import selected (1)')
    expect(importSelectedBtn().disabled).toBe(false)
    expect(onConfigured).not.toHaveBeenCalled()
  })

  // ── 任意长的 URL 不能把卡片撑宽 ───────────────────────────────────────────
  // 行上唯一可能带任意 URL 的两处（市场的 sourceUrl、远程 MCP 的 url）用
  // `overflow-wrap: anywhere` 就地折行 —— 与 chat.css 的 .streaming-plain 同一处置。
  it('lets an arbitrarily long url wrap instead of widening the card', async () => {
    const longUrl = `https://git.example.com/${'a'.repeat(160)}/repo`
    vi.mocked(api.get).mockResolvedValue({
      ...ENUMERATION,
      mcp: [{ name: 'remote', type: 'http' as const, url: 'https://mcp.example.com/some/very/long/path', exists: false, importErrors: [] }],
      marketplaces: [{ ...ENUMERATION.marketplaces[0], exists: false, sourceUrl: longUrl }],
    })
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)
    await screen.findByText('Work')

    // 市场那一行整条 URL 自己占一行（块级），MCP 那条在描述行里。
    expect((screen.getByText(longUrl) as HTMLElement).style.overflowWrap).toBe('anywhere')
    expect((screen.getByText(/some\/very\/long\/path/) as HTMLElement).style.overflowWrap).toBe('anywhere')
  })

  // Minor 1 的规则：**每一行承载服务端文本的地方**都折行，不只 URL。这句引导语
  // 每次渲染都在，里面是服务端报的实际路径（用户选的 `--state-dir`）。
  it('wraps every line that carries server-supplied text', async () => {
    const longDir = `C:\\Users\\${'a'.repeat(120)}\\claude-react-web`
    vi.mocked(api.get).mockResolvedValue({
      ...ENUMERATION,
      sourceDir: longDir,
      mcp: [],
      mcpError: `mcp-config.json is not valid JSON: Unexpected token < at position ${'9'.repeat(80)}`,
    })
    render(<SetupWebImport onContinue={vi.fn()} onConfigured={vi.fn()} />)

    // 引导语里的实际路径：`<code>` 自己、以及它所在的那一行。
    const code = (await screen.findByText(longDir)) as HTMLElement
    expect(code.style.overflowWrap).toBe('anywhere')
    expect((code.closest('p') as HTMLElement).style.overflowWrap).toBe('anywhere')
    // 那一栏的服务端原始报错（里面也是文件路径）。
    expect((screen.getByText(/MCP servers unavailable:/) as HTMLElement).style.overflowWrap)
      .toBe('anywhere')
  })
})