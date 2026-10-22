// Desktop-host wizard navigation.
//
// Regression: goNext/goBack computed the neighbouring step as id±1, but the
// desktop STEPS array omits id 6 (no Autostart step — the Electron host has
// no TCP daemon to auto-start). Advancing past 'Updates' therefore landed on
// step id 6, stepMeta(6) returned undefined, and the render crashed with
// "TypeError: Cannot read properties of undefined (reading 'subtitle')" —
// the error screen of the packaged desktop app, first seen right after the
// CLI check started passing (the crash lives one step past it).
//
// STEPS is a module-level const built from isDesktopHost(), so this file
// installs the desktop bridge BEFORE re-importing the module (resetModules),
// exercising the real host gate rather than mocking the step list.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { api } from '../hooks/useApi'

vi.mock('../hooks/useApi', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
// Same stubs as SetupPage.test.tsx — mount-time browser hooks irrelevant here.
vi.mock('../hooks/useNotifications', () => ({
  useNotifications: () => ({
    enabled: false,
    permission: 'default',
    toggle: vi.fn(async () => {}),
    notify: vi.fn(() => false),
    notifyWithActions: vi.fn(() => false),
    closeByTag: vi.fn(async () => {}),
  }),
}))
vi.mock('../hooks/useUpdateInfo', () => ({
  useUpdateInfo: () => ({
    info: null,
    loading: false,
    refreshing: false,
    error: null,
    refresh: vi.fn(),
  }),
}))
vi.mock('../hooks/useOverlayScrollbar', () => ({ useOverlayScrollbar: () => () => {} }))

/** Default GET map for the desktop wizard. Extracted so a test can special-case
 *  one path (e.g. the pre-screen's enumeration) and delegate the rest here,
 *  instead of re-implementing the whole map. */
function defaultGet(url: string): Promise<unknown> {
  if (url.startsWith('/health/claude')) return Promise.resolve({ ok: true, version: '1.0.0' })
  // 前置屏（SetupWebImport）的枚举探测：源目录不存在 ⇒ 三栏全空。
  if (url === '/config/web-import')
    return Promise.resolve({ sourceDir: '/tmp/.claude-react-web', exists: false, credentials: null, mcp: [], marketplaces: [] })
  if (url === '/profiles') return Promise.resolve({ profiles: [], activeProfileId: 'default' })
  if (url === '/mcp-config/claude-import') return Promise.resolve({ servers: [] })
  if (url === '/config/claude-defaults')
    return Promise.resolve({ hasKey: true, settingsPath: '/tmp/settings.json' })
  if (url === '/daemon/status')
    return Promise.resolve({
      supported: false,
      mechanism: null,
      configEnabled: false,
      osRegistered: false,
      drift: false,
      daemonAlive: false,
      child: null,
    })
  return Promise.resolve({})
}

beforeEach(() => {
  ;(window as unknown as { __CRW_DESKTOP__?: unknown }).__CRW_DESKTOP__ = { platform: 'win32' }
  vi.mocked(api.get).mockImplementation(defaultGet)
})

afterEach(() => {
  delete (window as unknown as { __CRW_DESKTOP__?: unknown }).__CRW_DESKTOP__
  vi.clearAllMocks()
})

/** Re-import a module with the desktop bridge on/off on window, so its
 *  module-level host-shape evaluation (the STEPS array) matches the request. */
async function importInHostShape<T>(desktop: boolean, loader: () => Promise<T>): Promise<T> {
  vi.resetModules()
  const w = window as unknown as { __CRW_DESKTOP__?: unknown }
  if (desktop) w.__CRW_DESKTOP__ = { platform: 'win32' }
  else delete w.__CRW_DESKTOP__
  return loader()
}

async function importDesktopSetupPage() {
  const mod = await importInHostShape(true, () => import('./SetupPage'))
  return mod.SetupPage
}

/** 桌面宿主的向导之前有一屏"从网页版导入"（SetupWebImport）——先点 Next 跳过它。
 *  Step 0's Continue, the token, then Next up to the Finish step. */
async function walkToFinish() {
  fireEvent.click(await screen.findByText('Next'))          // 前置屏 → step 0
  fireEvent.click(await screen.findByText('Continue'))      // step 0 → step 1
  fireEvent.change(screen.getByPlaceholderText('sk-ant-...'), { target: { value: 'sk-test' } })
  // Desktop: 1→2→3→4→5→7 —— 前置屏已经占用了一次 Next，这里仍是 5 次
  // （pre-fix the fifth renders step id 6 and throws）。
  for (let i = 0; i < 5; i++) fireEvent.click(screen.getByText('Next'))
}

describe('SetupPage — desktop wizard (no Autostart step)', () => {
  // 头号路径：凭证经前置屏导入，再由用户按 Next 收尾 ⇒ SetupPage 走既有收尾
  // 路径交接（onConfigured({ openNewSession: true })），用户不必重走一遍向导。
  // 导入本身不跳转（勾选只是选择、落盘要按 Import selected），所以这里
  // 必须先导入、再按 Next 收尾。
  // 这条链此前没有自动化覆盖：desktop 用例里前置屏一直是 exists:false，
  // SetupWebImport 的用例只到组件自己那一层（onConfigured 是个 spy）。
  it('hands over to onConfigured({ openNewSession: true }) after importing credentials and pressing Next', async () => {
    vi.mocked(api.get).mockImplementation((url: string) =>
      url === '/config/web-import'
        ? Promise.resolve({
          sourceDir: '/tmp/.claude-react-web',
          exists: true,
          credentials: {
            available: true, hasToken: true, profileName: 'Work',
            authTokenMasked: '****1234', baseUrl: 'https://api.example.com', modelCount: 1,
          },
          mcp: [],
          marketplaces: [],
        })
        : defaultGet(url))
    vi.mocked(api.post).mockResolvedValue({
      credentials: { imported: true, configured: true },
      mcp: { imported: [], skipped: [], failed: [] },
      marketplaces: { imported: [], skipped: [], failed: [] },
    })

    const SetupPage = await importDesktopSetupPage()
    const onConfigured = vi.fn(async () => {})
    render(<SetupPage onConfigured={onConfigured} />)

    // 前置屏列出凭证那一行 → 勾上（Select all importable）+ Import selected
    // 才把它 POST 出去（勾选本身不写盘）。
    expect(await screen.findByText('Work')).toBeTruthy()
    fireEvent.click(screen.getByText('Select all importable'))
    fireEvent.click(screen.getByText('Import selected (1)'))
    // 导入了 ≠ 交接了：导入只导入，屏幕留着。
    await waitFor(() => expect(screen.getByText('Imported')).toBeTruthy())
    expect(onConfigured).not.toHaveBeenCalled()

    // Next 才是唯一的交接口（此时服务端已 configured）。
    fireEvent.click(screen.getByText('Next'))
    await waitFor(() => expect(onConfigured).toHaveBeenCalledWith({ openNewSession: true }))
    expect(onConfigured).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.post)).toHaveBeenCalledWith(
      '/config/web-import',
      { credentials: true, mcp: [], marketplaces: [] },
      { timeoutMs: 180_000 },
    )
  })

  it('renders the web-import pre-screen first, and Next reveals step 1 of 7', async () => {
    const SetupPage = await importDesktopSetupPage()
    render(<SetupPage onConfigured={vi.fn(async () => {})} />)

    // 前置屏：没有进度点、没有步数计数器。
    expect(await screen.findByText(/Reading your Claude Web config|Nothing importable from the web version/)).toBeTruthy()
    expect(screen.queryByText(/^Step \d+ of \d+$/)).toBeNull()
    // 进度点只有 aria-label、没有可匹配的文本，上面那条正则抓不到它 —— 必须
    // 单独按 DOM 选择器钉一次，否则"前置屏不出现进度点"这半条要求是漏测的。
    expect(document.querySelector('.setup-progress')).toBeNull()

    fireEvent.click(screen.getByText('Next'))
    expect(await screen.findByText('Step 1 of 7')).toBeTruthy()
    expect(screen.getByText('Continue')).toBeTruthy()
    // 同一个选择器在向导里必须抓得到（否则上面那句 toBeNull 只证明选择器写错了，
    // 证明不了进度点不存在）。
    expect(document.querySelector('.setup-progress')).not.toBeNull()
  })

  it('advances Updates → Finish without crashing on the missing id 6', async () => {
    const SetupPage = await importDesktopSetupPage()
    render(<SetupPage onConfigured={vi.fn(async () => {})} />)

    await walkToFinish()

    expect(await screen.findByText('Create New Session')).toBeTruthy()
    // Ordinal comes from the array index: Finish is the 7th of 7 desktop
    // steps — the old id+1 header would have printed "Step 8 of 7".
    expect(screen.getByText('Step 7 of 7')).toBeTruthy()
  })

  it('goes Back from Finish to Updates (the previous array entry), not to a missing step', async () => {
    const SetupPage = await importDesktopSetupPage()
    render(<SetupPage onConfigured={vi.fn(async () => {})} />)

    await walkToFinish()
    fireEvent.click(screen.getByText('Back'))

    expect(await screen.findByText(/Choose the npm registry/)).toBeTruthy()
    expect(screen.getByText('Step 6 of 7')).toBeTruthy()
  })

  it('STEPS ids ascend along the array on BOTH hosts — the invariant the remaining id comparisons rely on', async () => {
    // Navigation now walks the array, but visited-dot state (s < step), the
    // Enter gate (step >= LAST_STEP) and the footer gating (step > 0 &&
    // step < LAST_STEP) still compare ids against id constants. Those are
    // correct only while ids ascend monotonically along STEPS — this pins
    // the invariant so a future step edit that violates it turns the suite
    // red instead of silently corrupting the ordinals on one host.
    for (const desktop of [false, true]) {
      const { STEPS } = await importInHostShape(desktop, () => import('./setup-steps'))
      for (let i = 1; i < STEPS.length; i++) {
        expect(STEPS[i].id, `${desktop ? 'desktop' : 'web'}: step #${i}`).toBeGreaterThan(STEPS[i - 1].id)
      }
    }
  })
})
