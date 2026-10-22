// 桌面版首启的"从网页版导入"前置屏。
//
// 它不是向导的一步（不进 setup-steps.ts 的 STEPS），SetupPage 里早返回渲染，
// 所以进度点 / 步数计数器天然不出现。
//
// DOM / 类名 / 文案 / 状态机照抄既有两处模式：
//   - step 0 与 step 3 的 health 行：探测中 / 失败 + Retry，且都允许继续；
//   - step 3 的 MCP 导入清单：每类自己的 `.setup-label` + `.setup-hint` 表头、
//     行内 checkbox、状态位文案 Importing… / Imported / Already exists / Failed。
// 一处有意**不**照抄 step 3：那里的 checkbox 勾上就立刻写盘，本屏的 checkbox 只是
// 选择（人报的"勾了就撤不回来"），落盘只发生在 Import selected 那一次 POST 上。
// 不新增 CSS，颜色只用主题变量。

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../hooks/useApi'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { IconCheck } from './icons/ToolIcons'
import type { WebImportEnumeration, WebImportMarketplaceView, WebImportMcpView, WebImportResult } from '../../shared/web-import'

type RowStatus = 'idle' | 'importing' | 'imported' | 'exists' | 'failed'

interface Props {
  /** 用户按 Next 时服务端还没 configured（没导入凭证，或只导了 MCP / 市场）
   *  → 走向导第一步。 */
  onContinue: () => void
  /** 用户按 Next 时服务端已 configured（本次导入写成的）→ 交给 SetupPage 走
   *  既有收尾路径。 */
  onConfigured: () => void | Promise<void>
}

/** 行 key：credentials / mcp:<name> / mp:<id> —— 一个字典管三栏的状态位，
 *  同一个 key 也是选择集里的成员标识。 */
const CREDENTIALS_ROW = 'credentials'
const mcpRow = (name: string) => `mcp:${name}`
const mpRow = (id: string) => `mp:${id}`

/** 这一次 POST 的超时。spec 把它定成"一次请求里要拷最多上百 MB"（本机 6 个
 *  市场共 122 MB），transport 的 30 s 默认值（src/transport/web.ts 的
 *  DEFAULT_TIMEOUT_MS）在慢盘 / 开着实时扫描的 Windows 上够得着。客户端一旦
 *  超时 abort，服务端**照旧跑完并落盘**（含 config.json），用户会停在超时文案上
 *  而 app 其实已经配好了——所以这个上限必须给足。180 s 与市场拉取
 *  （src/marketplace-update.ts 的 MARKETPLACE_PULL_TIMEOUT_MS）同量级。 */
const WEB_IMPORT_TIMEOUT_MS = 180_000

export function SetupWebImport({ onContinue, onConfigured }: Props) {
  const setPageOs = useOverlayScrollbar({ autoHide: 'leave' })
  const [data, setData] = useState<WebImportEnumeration | undefined>(undefined)
  const [probeError, setProbeError] = useState<string | null>(null)
  const [status, setStatus] = useState<Record<string, RowStatus>>({})
  /** 这次要导入哪些行。勾选**只**改它（一个请求都不发），落盘只发生在
   *  Import selected 那一次 POST 上——一次误勾必须能整条撤回。 */
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 服务端是否已 configured，只由"这次导入的响应"喂：`WebImportResult.credentials`
   *  只在请求带了凭证时非 null（shared/web-import.ts 的
   *  WebImportCredentialsResult 才带 `configured`），而本屏只在服务端未配置时
   *  渲染，所以 `configured: true` 只可能来自本屏自己那次导入——不必再探一次
   *  GET /config。它决定按 Next 时是收尾还是进向导。 */
  const [configured, setConfigured] = useState(false)
  const probeCancelRef = useRef<(() => void) | null>(null)

  /** 探测：与 step 3 的 probeClaudeMcp 同形（可取消 + Retry 复用同一条路径）。 */
  const probe = useCallback(() => {
    probeCancelRef.current?.()
    let cancelled = false
    probeCancelRef.current = () => { cancelled = true }
    setProbeError(null)
    void api
      .get<WebImportEnumeration>('/config/web-import')
      .then((r) => {
        if (cancelled) return
        setData(r)
        // 桌面版已有的 MCP / 市场直接落成终态，勾选框像 step 3 一样禁用。
        setStatus((prev) => {
          const next = { ...prev }
          for (const s of r.mcp) if (s.exists) next[mcpRow(s.name)] = 'exists'
          for (const m of r.marketplaces) if (m.exists) next[mpRow(m.id)] = 'exists'
          return next
        })
      })
      .catch((err) => {
        if (cancelled) return
        setProbeError(err instanceof Error ? err.message : 'Failed to read the Claude Web config')
      })
  }, [])

  useEffect(() => {
    // probe() 在 await 之前同步 setProbeError(null)（Retry 复用同一条路径，
    // 重探时必须先清掉上一次的失败）。挂载时它本来就是 null，是一次 bail out
    // 的写入，不是级联渲染——与 SetupPage 的 probeClaudeMcp / probeClaudeHealth
    // 同一处置。本屏是探测屏，"先渲染探测中、再由 promise 落结果"正是目的。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    probe()
    return () => { probeCancelRef.current?.() }
  }, [probe])

  /** 把一次导入的**选择集**落成状态位。成功与失败共用这一步——不是巧合，
   *  是两个分支必须同构：
   *    - 先整批落 'failed'（请求本身抛了时这就是最终答案；成功时下面用服务端
   *      的逐项结果覆盖）；
   *    - 再用服务端的 imported / skipped / failed 三个桶覆盖。
   *  早先失败分支只调 setError，被选中的行会永远停在 Importing… ——而
   *  anyImportable 把 'importing' 当"在飞"，Select all 会跟着消失，用户没有
   *  重试口。落 'failed'（而非回到 'idle'）与 step 3 的 importMcp /
   *  importAllMcp 的 catch 同一处置：行可重试、按钮不消失。
   *  落底那一遍同时兜住"服务端没把某项列进任何桶"的情况（否则同样停在
   *  Importing…）。 */
  const settleStatuses = useCallback(
    (sel: { credentials: boolean; mcp: string[]; marketplaces: string[] }, res: WebImportResult | null) => {
      setStatus((prev) => {
        const next = { ...prev }
        if (sel.credentials) next[CREDENTIALS_ROW] = 'failed'
        for (const n of sel.mcp) next[mcpRow(n)] = 'failed'
        for (const id of sel.marketplaces) next[mpRow(id)] = 'failed'
        if (!res) return next
        if (sel.credentials) next[CREDENTIALS_ROW] = res.credentials?.imported ? 'imported' : 'failed'
        for (const n of res.mcp.imported) next[mcpRow(n)] = 'imported'
        for (const n of res.mcp.skipped) next[mcpRow(n)] = 'exists'
        for (const f of res.mcp.failed) next[mcpRow(f.name)] = 'failed'
        for (const id of res.marketplaces.imported) next[mpRow(id)] = 'imported'
        for (const id of res.marketplaces.skipped) next[mpRow(id)] = 'exists'
        for (const f of res.marketplaces.failed) next[mpRow(f.name)] = 'failed'
        return next
      })
    },
    [],
  )

  /** 发一次导入请求并按结果落状态位。**不跳转**：Import selected 只是"导入"，
   *  而交出一整屏是一个导航决定，由用户按 Next 做出（见下面的 `handleNext`）。
   *  唯一带回来的是"服务端现在 configured 了吗"，它只改 `configured`，Next 再
   *  据此决定去哪。 */
  const runImport = useCallback(async (sel: { credentials: boolean; mcp: string[]; marketplaces: string[] }) => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    setStatus((prev) => {
      const next = { ...prev }
      if (sel.credentials) next[CREDENTIALS_ROW] = 'importing'
      for (const n of sel.mcp) next[mcpRow(n)] = 'importing'
      for (const id of sel.marketplaces) next[mpRow(id)] = 'importing'
      return next
    })
    try {
      const res = await api.post<WebImportResult>('/config/web-import', sel, { timeoutMs: WEB_IMPORT_TIMEOUT_MS })
      settleStatuses(sel, res)
      // 逐项失败不弹错、不阻断：行上的 Failed 就是信号（与 step 3 一致）。
      // 请求没带凭证时 res.credentials 是 null（没有 configured 可言）。
      if (res.credentials?.configured) setConfigured(true)
    } catch (err) {
      // 请求本身抛了（超时 / 网络 / 5xx / 400）：整批落 Failed，行因此可重试。
      settleStatuses(sel, null)
      setError(err instanceof Error ? err.message : 'Import failed')
    }
    setSubmitting(false)
  }, [submitting, settleStatuses])

  /** 本屏唯一的交接口。服务端已 configured（上面那次带凭证的导入写成的）→ 走
   *  SetupPage 的既有收尾路径；否则照常进向导 step 0。
   *  onConfigured 是 parent 的 best-effort 收尾（App.tsx 的 handleConfigured
   *  自己会吞掉那次 /config 刷新的失败），和上面那次导入是两个独立的动作，
   *  所以它抛错时照 handleConfigured 那一侧的先例只记一行日志：既不改屏上
   *  状态（导入早就成功了，说成 "Import failed" 是谎报），本屏也留着——parent
   *  没能收起它，用户可以直接再按一次 Next。 */
  const handleNext = useCallback(async () => {
    if (!configured) {
      onContinue()
      return
    }
    try {
      await onConfigured()
    } catch (err) {
      console.error('[SetupWebImport] hand-off on Next failed:', err)
    }
  }, [configured, onContinue, onConfigured])

  /** 渲染期一律读 state，不读 ref：ref 是给异步 handler 读"最新值"用的，在这里
   *  没有任何异步 handler 需要它，用 ref 反而会慢一帧（selectedCount 这类派生值
   *  会因此算错）。 */
  const statusOf = (key: string): RowStatus => status[key] ?? 'idle'
  const done = (key: string) => {
    const s = statusOf(key)
    return s === 'imported' || s === 'exists'
  }
  const doneOrRunning = (key: string) => statusOf(key) === 'importing' || done(key)

  /** 一栏里"还能导入"的判定。下面三处必须同构（step 3 的 importAllMcp 与它那个
   *  `claudeMcp.some(...)` 是同一写法）——selection 算 payload、selectAllImportable
   *  算"全勾上"、anyImportable 算按钮能不能点，任何一个漂移都会让按钮变成一个
   *  点不动的空转、或者选进一个必然失败的项：
   *    - importErrors 非空的 MCP：服务端会逐项判 failed（校验不过）；
   *    - cloneExists 为 false 的市场：源的克隆目录不在了，导入必然
   *      `clone dir is missing`（shared/web-import.ts 的 cloneExists 注释
   *      也是这么约定的——该行不可导入）。
   *  状态那一半只排除 doneOrRunning（imported / exists / importing），
   *  **failed 不排除**——这就是 step 3 的 rowDisabled 判据：一次导入把某行
   *  弄成 Failed 之后，那一行还能重试，Select all 也不会因为"没有 idle 的项"
   *  而整个消失。
   *  行上禁用勾选框用的也是同一条状态判据（写成 done || importing，等价于
   *  doneOrRunning），另加"结构上导不进去"的 unimportable——凭证那一行还有
   *  一条：源里没有可用 profile（`credentials.available === false`）时它一个
   *  字段都写不出来，判据与写入侧的 `imported` 是同一个函数。 */
  const mcpImportable = (s: WebImportMcpView) =>
    s.importErrors.length === 0 && !doneOrRunning(mcpRow(s.name))
  const mpImportable = (m: WebImportMarketplaceView) =>
    m.cloneExists && !doneOrRunning(mpRow(m.id))
  const credentialsImportable = data?.credentials != null && data.credentials.available
    && !doneOrRunning(CREDENTIALS_ROW)

  /** 这次"Import selected"真正会发出去的子集：选择集与"还能导入"的**交集**。
   *  交集而不是直接信任选择集本身——一次导入之后行会变成 imported / exists，
   *  它们留在 set 里也没有意义（勾选框已禁用、服务端只会回 skipped），按交集算
   *  计数与 payload，那些"已经落定的勾"就自动不参与（按钮计数随之归零）。 */
  const selection = {
    credentials: selected.has(CREDENTIALS_ROW) && credentialsImportable,
    mcp: (data?.mcp ?? []).filter((s) => selected.has(mcpRow(s.name)) && mcpImportable(s)).map((s) => s.name),
    marketplaces: (data?.marketplaces ?? []).filter((m) => selected.has(mpRow(m.id)) && mpImportable(m)).map((m) => m.id),
  }
  const selectedCount = (selection.credentials ? 1 : 0) + selection.mcp.length + selection.marketplaces.length

  /** 任意一项可导入 ⇒ Select all 有活干（predicate 与 selection 的 filter 同构）。 */
  const anyImportable = data !== undefined && (
    credentialsImportable || data.mcp.some(mcpImportable) || data.marketplaces.some(mpImportable)
  )

  const importing = submitting

  /** 勾选**只改选择集**：不发请求、不改任何行状态位。撤回就是再点一次，
   *  完整回到勾之前的样子。 */
  const toggleSelected = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** 一键把所有可导入的行勾上（happy path 仍是两击：Select all importable →
   *  Import selected）。**替换**选择集而不是并集：勾选是"这次要导入哪些"的
   *  声明，替换与它的字面意思一致，也顺手丢掉上一轮留下的死键。 */
  const selectAllImportable = () => {
    const next = new Set<string>()
    if (credentialsImportable) next.add(CREDENTIALS_ROW)
    for (const s of data?.mcp ?? []) if (mcpImportable(s)) next.add(mcpRow(s.name))
    for (const m of data?.marketplaces ?? []) if (mpImportable(m)) next.add(mpRow(m.id))
    setSelected(next)
  }

  /** 只发选中的那些：按钮在 0 个选中时是禁用的，所以这里不必再挡一次。 */
  const importSelected = () => { void runImport(selection) }

  const nothingToImport = data !== undefined && !probeError && (
    !data.credentials && data.mcp.length === 0 && data.marketplaces.length === 0
  )

  const statusLabel = (key: string) => {
    const s = statusOf(key)
    if (s === 'importing') return 'Importing…'
    if (s === 'imported') return <span style={styles.ok}><IconCheck size={12} /> Imported</span>
    if (s === 'exists') return 'Already exists'
    if (s === 'failed') return <span style={styles.fail}>Failed</span>
    return null
  }

  /**
   * 行的勾选框：勾上 = "这次把它一起导"。
   *   - 已落定（imported / exists）→ 勾着 + 禁用（终态，与 step 3 一致）；
   *   - importing / 请求在飞 → 禁用；
   *   - `unimportable`：这一项结构上就导不进去（MCP 校验不过 / 源的克隆目录
   *     不在）→ 禁用，目标是"不要提供一个必然失败的点击"，而行上已把原因写着
   *     （MCP 的 importErrors 行、市场的 `· clone missing`）。
   *  aria-label 沿用 `Import <name>`（与 step 3 的行同名）：它描述的是"这一行
   *  会被导入"，而落盘动作只有底下那个 Import selected 一个。
   */
  const checkbox = (key: string, label: string, unimportable = false) => {
    const s = statusOf(key)
    const isDone = s === 'imported' || s === 'exists'
    return (
      <input
        type="checkbox"
        checked={isDone || selected.has(key)}
        disabled={isDone || s === 'importing' || submitting || unimportable}
        onChange={() => toggleSelected(key)}
        style={{ marginTop: 3, flexShrink: 0 }}
        aria-label={label}
      />
    )
  }

  return (
    <div className="setup-page" ref={setPageOs}>
      <div className="setup-card">
        <h1 className="setup-title">Welcome to Claude Web</h1>
        <p className="setup-subtitle">Import your existing Claude Web configuration from the web version.</p>

        {/* 探测中 —— 与 step 3 的 "Reading your Claude CLI config…" 同形。 */}
        {data === undefined && !probeError && (
          <div className="setup-health-row setup-health-row-checking">
            <span className="setup-spinner spinner" aria-hidden="true" />
            <span className="setup-hint">Reading your Claude Web config…</span>
          </div>
        )}

        {/* 探测失败 —— 与 step 0 / step 3 的失败行同形，且允许继续。 */}
        {probeError && (
          <div className="setup-health-row setup-health-row-fail">
            <span className="setup-health-icon" aria-hidden="true">!</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ ...styles.hint, color: 'var(--fg)' }}>Could not read your Claude Web config.</p>
              {/* 服务端报错里带的是它实际试过的文件路径，同样是任意长的无断点串。 */}
              <p className="setup-prefilled-hint" style={styles.wrap}>{probeError}</p>
            </div>
            <button type="button" onClick={probe} style={styles.secondaryBtn}>Retry</button>
          </div>
        )}

        {/* 三栏全空 —— 明确说明，而不是渲染一张空清单。
            措辞必须对两种情况都成立：真的是空的，以及三个源文件都读不动。
            后者下面那三行 `…unavailable:` 会在同一屏里说清是**读不动**，所以
            这里只能断言"没有**能导入**的东西"，不能断言对面应用没有东西——
            "No Claude Web config found." 那种写法会与本屏的错误行自相矛盾。
            同理也不用 "Nothing to import from the web version."：文件读不动时
            "import from" 读起来像"这款应用没有什么可导出的"。 */}
        {data !== undefined && nothingToImport && (
          <>
            <div className="setup-health-row setup-health-row-fail">
              <span className="setup-health-icon" aria-hidden="true">!</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ ...styles.hint, color: 'var(--fg)' }}>Nothing importable from the web version.</p>
                {/* `--state-dir` 是用户选的路径：Windows 反斜杠串没有断点，
                    不折行就会把卡片顶宽（与行上那些 URL 同一处置）。 */}
                <p className="setup-prefilled-hint" style={styles.wrap}>{data.sourceDir}</p>
              </div>
            </div>
            <p className="setup-hint">
              You can keep going and configure this app by hand — nothing to import here.
            </p>
          </>
        )}

        {data !== undefined && data.exists && (
          <div className="setup-field">
            <label className="setup-label">From the web version</label>
            {/* 这句每次渲染都在，而 `<code>` 里是服务端报的实际路径（用户选的
                `--state-dir`，Windows 反斜杠串没有断点）——不折行就是"卡片比窗口
                宽、整页横向滚动"最常见的那个入口。 */}
            <p className="setup-hint" style={styles.wrap}>
              Read from <code style={{ ...styles.code, ...styles.wrap }}>{data.sourceDir}</code>. Everything you
              import is copied into this app; the web version is left untouched.
            </p>

            {/* ① 凭证与模型 —— 有凭证才渲染这一行。`available` 是"源 active profile
                里至少有一个可写字段"，不是常量：为 false 时这一行一个字段都写不出
                来，按"不可用"渲染（压暗 + 禁用 + 一行原因），不进任何一次提交。 */}
            <div style={styles.section}>
              <label className="setup-label">Credentials and models ({data.credentials ? 1 : 0})</label>
              <p className="setup-hint">
                The token and model list are copied into this app's active profile.
              </p>
              {data.credentials && (
                <div style={{ ...styles.row, opacity: data.credentials.available ? 1 : 0.55 }}>
                  {checkbox(CREDENTIALS_ROW, 'Import credentials', !data.credentials.available)}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={styles.metaRow}>
                      <code style={{ ...styles.code, fontSize: 'var(--fs-sm)', ...styles.wrap }}>{data.credentials.profileName}</code>
                      <span className="setup-hint" style={{ fontSize: 'var(--fs-xs)', ...styles.wrap }}>
                        credentials + models
                        {data.credentials.authTokenMasked ? ` · ${data.credentials.authTokenMasked}` : ''}
                        {/* 源里没有可用列表时服务端就不报条数（那时的列表是
                            fallback），这里跟着不显示——报默认值条数是谎报。 */}
                        {data.credentials.modelCount !== undefined ? ` · ${data.credentials.modelCount} model(s)` : ''}
                      </span>
                    </div>
                    {!data.credentials.available && (
                      <p className="setup-hint" style={styles.subLine}>
                        No token or model list to copy from this profile.
                      </p>
                    )}
                  </div>
                  <span className="setup-hint" style={styles.rowStatus}>
                    {statusLabel(CREDENTIALS_ROW)}
                  </span>
                </div>
              )}
              {data.credentialsError && (
                <p className="setup-hint" style={styles.wrap}>Credentials unavailable: {data.credentialsError}</p>
              )}
            </div>

            {/* ② 全局 MCP */}
            <div style={styles.section}>
              <label className="setup-label">MCP servers ({data.mcp.length})</label>
              <p className="setup-hint">
                Imported servers become global and are available to every new session.
              </p>
              {data.mcp.map((s) => (
                <div
                  key={s.name}
                  // 校验不过的行整行压暗（step 3 对 invalid 行的同一处置）。
                  style={{ ...styles.row, opacity: s.importErrors.length > 0 ? 0.55 : 1 }}
                >
                  {checkbox(mcpRow(s.name), `Import ${s.name}`, s.importErrors.length > 0)}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={styles.metaRow}>
                      <code style={{ ...styles.code, fontSize: 'var(--fs-sm)', ...styles.wrap }}>{s.name}</code>
                      <span className="setup-hint" style={{ fontSize: 'var(--fs-xs)', ...styles.wrap }}>
                        {s.type}
                        {s.command ? ` · ${s.command}` : ''}
                        {s.url ? ` · ${s.url}` : ''}
                      </span>
                    </div>
                    {s.envKeys && s.envKeys.length > 0 && (
                      <p className="setup-hint" style={styles.subLine}>
                        env: {s.envKeys.join(', ')}
                      </p>
                    )}
                    {s.importErrors.length > 0 && (
                      <p className="setup-hint" style={{ ...styles.subLine, color: 'var(--msg-error-fg)' }}>
                        {s.importErrors.join('; ')}
                      </p>
                    )}
                  </div>
                  <span className="setup-hint" style={styles.rowStatus}>
                    {statusLabel(mcpRow(s.name))}
                  </span>
                </div>
              ))}
              {data.mcpError && (
                <p className="setup-hint" style={styles.wrap}>MCP servers unavailable: {data.mcpError}</p>
              )}
            </div>

            {/* ③ Marketplaces */}
            <div style={styles.section}>
              <label className="setup-label">Marketplaces ({data.marketplaces.length})</label>
              <p className="setup-hint">
                Imported marketplaces are copied into this app together with their enabled plugins.
              </p>
              {data.marketplaces.map((m) => (
                <div
                  key={m.id}
                  // 克隆目录不在的行整行压暗，与上面的 invalid MCP 行同一处置。
                  style={{ ...styles.row, opacity: !m.cloneExists ? 0.55 : 1 }}
                >
                  {checkbox(mpRow(m.id), `Import ${m.id}`, !m.cloneExists)}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={styles.metaRow}>
                      <code style={{ ...styles.code, fontSize: 'var(--fs-sm)', ...styles.wrap }}>{m.id}</code>
                      <span className="setup-hint" style={{ fontSize: 'var(--fs-xs)', ...styles.wrap }}>
                        {`${m.pluginCount} plugin(s)`}
                        {m.cloneExists ? '' : ' · clone missing'}
                      </span>
                    </div>
                    <p className="setup-hint" style={styles.subLine}>{m.sourceUrl}</p>
                  </div>
                  <span className="setup-hint" style={styles.rowStatus}>
                    {statusLabel(mpRow(m.id))}
                  </span>
                </div>
              ))}
              {data.marketplacesError && (
                <p className="setup-hint" style={styles.wrap}>Marketplaces unavailable: {data.marketplacesError}</p>
              )}
            </div>

            {/* 一个明确的动作，而不是勾一下就写盘：主按钮只发选中的那些，
                旁边那条一键把可导入的全勾上（happy path 仍是两击）。 */}
            <div style={styles.actions}>
              <button
                type="button"
                onClick={importSelected}
                disabled={importing || selectedCount === 0}
                style={styles.secondaryBtn}
              >
                {importing ? 'Importing…' : `Import selected (${selectedCount})`}
              </button>
              <button
                type="button"
                onClick={selectAllImportable}
                disabled={importing || !anyImportable}
                style={styles.secondaryBtn}
              >
                Select all importable
              </button>
            </div>
          </div>
        )}

        {error && <p role="alert" className="setup-field-error">{error}</p>}

        <div style={styles.footer}>
          <div style={styles.footerLeft} />
          <div style={styles.footerRight}>
            <button
              type="button"
              onClick={() => void handleNext()}
              disabled={submitting}
              // 导入可能是"拷一整个克隆目录"量级的等待，禁用必须看得出来
              // （step 0 的 Continue / step 4 的两个按钮同一写法）。导入在飞时
              // 也不该放用户走——他刚点的那些行还没落定。
              //
              // 标签刻意**不是** Next：本屏的写入按钮是 Import selected，而一个叫
              // Next 的按钮读起来像"带着我勾的那些继续"，人报过这个误解。Skip =
              // 不导入、离开本屏：服务端已 configured 就收尾进主界面，否则进向导
              // step 0。两种读法（跳过导入 / 跳过剩下的向导）都不暗示"会导入"。
              style={{ ...styles.submitBtn, ...(submitting ? styles.submitBtnDisabled : null) }}
            >
              Skip
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 规则是**每一行承载服务端文本的地方**都折行，不只是 URL：URL（市场的
 *  sourceUrl、远程 MCP 的 url / command）、用户选的 `--state-dir` 路径（Windows
 *  反斜杠串没有断点）、以及服务端报的原始错误（里面就是文件路径）。任一处漏掉
 *  都会把卡片顶宽、整页横向滚动。
 *  `overflow-wrap: anywhere` 与 chat.css 的 .streaming-plain 同一处置：它是唯一
 *  **同时把 min-content 宽度算小**的写法（`word-break: break-word`，像
 *  messages.css 的 .diff-line 那样，不会），flex 子项因此才会收缩而不是把父级
 *  顶开。 */
const WRAP_ANYWHERE: React.CSSProperties = { overflowWrap: 'anywhere' }

const styles: Record<string, React.CSSProperties> = {
  hint: { margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--fg-muted)', lineHeight: 1.4 },
  code: {
    fontFamily: 'var(--mono)', fontSize: 'var(--fs-xs)', padding: '1px 5px',
    background: 'var(--bg-elev-2)', borderRadius: 'var(--radius-xs)',
  },
  row: {
    display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 8px',
    background: 'var(--bg-elev-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)',
  },
  /** 三类各成一节：`.setup-label` + `.setup-hint` 表头与行拉开一点距离，
   *  否则节与节之间只剩 .setup-field 的 6px，看不出是三个分组。 */
  section: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 },
  metaRow: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' },
  subLine: { fontSize: 'var(--fs-xs)', marginTop: 2, ...WRAP_ANYWHERE },
  rowStatus: { fontSize: 'var(--fs-xs)', flexShrink: 0, marginTop: 2 },
  actions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 },
  wrap: WRAP_ANYWHERE,
  ok: { display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--accent)' },
  fail: { color: 'var(--msg-error-fg)' },
  footer: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 4 },
  footerLeft: { display: 'flex', gap: 8 },
  footerRight: { display: 'flex', gap: 8 },
  submitBtn: {
    minHeight: 44, padding: '0 16px', fontSize: 'var(--fs-md)', fontWeight: 600, fontFamily: 'inherit',
    background: 'var(--accent)', border: 'none', borderRadius: 'var(--radius-sm)', color: 'var(--on-accent)',
    cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  secondaryBtn: {
    minHeight: 44, padding: '0 14px', fontSize: 'var(--fs-base)', fontFamily: 'inherit',
    background: 'var(--bg-elev-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
    color: 'var(--fg)', cursor: 'pointer',
  },
  submitBtnDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
}
