// 桌面版首启的"从网页版导入"前置屏。
//
// 它不是向导的一步（不进 setup-steps.ts 的 STEPS），SetupPage 里早返回渲染，
// 所以进度点 / 步数计数器天然不出现。
//
// DOM / 类名 / 文案 / 状态机照抄既有两处模式：
//   - step 0 与 step 3 的 health 行：探测中 / 失败 + Retry，且都允许继续；
//   - step 3 的 MCP 导入清单：行内 checkbox 即时导入、Import all 批量导入、
//     状态位文案 Importing… / Imported / Already exists / Failed。
// 不新增 CSS，颜色只用主题变量。

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../hooks/useApi'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { IconCheck } from './icons/ToolIcons'
import type { WebImportEnumeration, WebImportMarketplaceView, WebImportMcpView, WebImportResult } from '../../shared/web-import'

type RowStatus = 'idle' | 'importing' | 'imported' | 'exists' | 'failed'

interface Props {
  /** 用户没导入凭证（或只导了 MCP / 市场）→ 走向导第一步。 */
  onContinue: () => void
  /** 凭证已写入且服务端 configured → 交给 SetupPage 走既有收尾路径。 */
  onConfigured: () => void | Promise<void>
}

/** 行 key：credentials / mcp:<name> / mp:<id> —— 一个字典管三栏的状态位。 */
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
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
   *  anyImportable 把 'importing' 当"在飞"，Import all 会跟着消失，用户没有
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

  /** 发一次导入请求。成功后：只要服务端已 configured 就收尾（这正是用户选的
   *  "凭证导入成功即收尾"），否则留在本屏让状态位更新。 */
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
    let handOff = false
    try {
      const res = await api.post<WebImportResult>('/config/web-import', sel, { timeoutMs: WEB_IMPORT_TIMEOUT_MS })
      settleStatuses(sel, res)
      // 逐项失败不弹错、不阻断：行上的 Failed 就是信号（与 step 3 一致）。
      handOff = !!res.credentials?.configured
    } catch (err) {
      // 请求本身抛了（超时 / 网络 / 5xx / 400）：整批落 Failed，行因此可重试。
      settleStatuses(sel, null)
      setError(err instanceof Error ? err.message : 'Import failed')
    }
    if (handOff) {
      // 收尾（hand-off）刻意放在导入那个 try **之外**：onConfigured 是 parent
      // 的 best-effort 收尾（App.tsx 的 handleConfigured 会吞掉自己那次 /config
      // 刷新的失败）。它抛错时这次导入其实**已经成功了**——上面刚把行标成
      // Imported——借 import 的 catch 把这句说成 "Import failed" 是谎报。
      // 于是照 handleConfigured 那一侧的先例：只记一行日志，不改屏上状态。
      try {
        await onConfigured()
        // 交接成功：parent 会因为已配置而卸载本屏，所以**刻意不 reset
        // `submitting`**——setSubmitting(false) 只是在卸载后写 state（dev 下会
        // 报 set-state-on-unmounted），与 SetupPage.finalize 的收尾同形，
        // 不要"顺手修"成 finally。
        return
      } catch (err) {
        console.error('[SetupWebImport] hand-off after web import failed:', err)
        // 相反地，onConfigured 抛错时本屏**没有**被卸载（parent 的收尾没能
        // 完成），必须往下走去复位 submitting——否则 Next、每个勾选框和
        // Import all 会一直禁用下去，用户连重试交接都做不到。
      }
    }
    setSubmitting(false)
  }, [submitting, onConfigured, settleStatuses])

  /** 渲染期一律读 state，不读 ref：ref 是给异步 handler 读"最新值"用的，在这里
   *  没有任何异步 handler 需要它，用 ref 反而会慢一帧（anyImportable 这类派生值
   *  会因此算错）。 */
  const statusOf = (key: string): RowStatus => status[key] ?? 'idle'
  const doneOrRunning = (key: string) => {
    const s = statusOf(key)
    return s === 'importing' || s === 'imported' || s === 'exists'
  }

  /** 一栏里"还能导入"的判定。两处必须同构（step 3 的 importAllMcp 与它那个
   *  `claudeMcp.some(...)` 是同一写法），否则 Import all 会变成一个点不动的
   *  按钮、或者选进一个必然失败的项：
   *    - importErrors 非空的 MCP：服务端会逐项判 failed（校验不过）；
   *    - cloneExists 为 false 的市场：源的克隆目录不在了，导入必然
   *      `clone dir is missing`（shared/web-import.ts 的 cloneExists 注释
   *      也是这么约定的——该行不可导入）。
   *  状态那一半只排除 doneOrRunning（imported / exists / importing），
   *  **failed 不排除**——这就是 step 3 的 rowDisabled 判据：一次批量导入把某行
   *  弄成 Failed 之后，那一行还能重试，Import all 也不会因为"没有 idle 的项"
   *  而整个消失。
   *  行上禁用勾选框用的也是同一条状态判据（写成 done || importing，等价于
   *  doneOrRunning），另加"结构上导不进去"的 unimportable。 */
  const mcpImportable = (s: WebImportMcpView) =>
    s.importErrors.length === 0 && !doneOrRunning(mcpRow(s.name))
  const mpImportable = (m: WebImportMarketplaceView) =>
    m.cloneExists && !doneOrRunning(mpRow(m.id))

  const importing = submitting
  const nothingToImport = data !== undefined && !probeError && (
    !data.credentials && data.mcp.length === 0 && data.marketplaces.length === 0
  )

  /** 批量导入：把还没导入 / 还没存在的、且确实能导入的项一次 POST 出去。 */
  const importAll = () => {
    const sel = {
      credentials: !doneOrRunning(CREDENTIALS_ROW) && data?.credentials != null,
      mcp: (data?.mcp ?? []).filter(mcpImportable).map((s) => s.name),
      marketplaces: (data?.marketplaces ?? []).filter(mpImportable).map((m) => m.id),
    }
    if (!sel.credentials && sel.mcp.length === 0 && sel.marketplaces.length === 0) return
    void runImport(sel)
  }

  /** 任意一项可导入 ⇒ Import all 有活干（predicate 与 importAll 的 filter 同构）。 */
  const anyImportable = data !== undefined && (
    (data.credentials != null && !doneOrRunning(CREDENTIALS_ROW))
    || data.mcp.some(mcpImportable)
    || data.marketplaces.some(mpImportable)
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
   * `unimportable`：这一项结构上就导不进去（MCP 校验不过 / 源的克隆目录不在）。
   * 与 done / importing 一样禁用勾选框——目标是"不要提供一个必然失败的点击"，
   * 而行上已把原因写着（MCP 的 importErrors 行、市场的 `· clone missing`）。
   */
  const checkbox = (key: string, label: string, onCheck: () => void, unimportable = false) => {
    const s = statusOf(key)
    const done = s === 'imported' || s === 'exists'
    return (
      <input
        type="checkbox"
        checked={done}
        disabled={done || s === 'importing' || submitting || unimportable}
        onChange={onCheck}
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
              <p className="setup-prefilled-hint">{probeError}</p>
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
                <p className="setup-prefilled-hint">{data.sourceDir}</p>
              </div>
            </div>
            <p className="setup-hint">
              You can keep going and configure this app by hand — nothing to import here.
            </p>
          </>
        )}

        {data !== undefined && data.exists && (
          <>
            <div className="setup-field">
              <label className="setup-label">From the web version</label>
              <p className="setup-hint">
                Read from <code style={styles.code}>{data.sourceDir}</code>. Everything you
                import is copied into this app; the web version is left untouched.
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {/* 凭证与模型 —— 有凭证才渲染这一行；`available` 是常量 true，
                    不是信号，不要拿它做闸门。 */}
                {data.credentials && (
                  <div style={styles.row}>
                    {checkbox(CREDENTIALS_ROW, 'Import credentials', () => void runImport({ credentials: true, mcp: [], marketplaces: [] }))}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <code style={{ ...styles.code, fontSize: 'var(--fs-sm)' }}>{data.credentials.profileName}</code>
                        <span className="setup-hint" style={{ fontSize: 'var(--fs-xs)' }}>
                          credentials + models
                          {data.credentials.authTokenMasked ? ` · ${data.credentials.authTokenMasked}` : ''}
                          {` · ${data.credentials.modelCount} model(s)`}
                        </span>
                      </div>
                    </div>
                    <span className="setup-hint" style={{ fontSize: 'var(--fs-xs)', flexShrink: 0, marginTop: 2 }}>
                      {statusLabel(CREDENTIALS_ROW)}
                    </span>
                  </div>
                )}
                {data.credentialsError && (
                  <p className="setup-hint">Credentials unavailable: {data.credentialsError}</p>
                )}

                {/* 全局 MCP */}
                {data.mcp.map((s) => (
                  <div
                    key={s.name}
                    // 校验不过的行整行压暗（step 3 对 invalid 行的同一处置）。
                    style={{ ...styles.row, opacity: s.importErrors.length > 0 ? 0.55 : 1 }}
                  >
                    {checkbox(mcpRow(s.name), `Import ${s.name}`, () => void runImport({ credentials: false, mcp: [s.name], marketplaces: [] }), s.importErrors.length > 0)}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <code style={{ ...styles.code, fontSize: 'var(--fs-sm)' }}>{s.name}</code>
                        <span className="setup-hint" style={{ fontSize: 'var(--fs-xs)' }}>
                          {s.type}
                          {s.command ? ` · ${s.command}` : ''}
                          {s.url ? ` · ${s.url}` : ''}
                        </span>
                      </div>
                      {s.envKeys && s.envKeys.length > 0 && (
                        <p className="setup-hint" style={{ fontSize: 'var(--fs-xs)', marginTop: 2 }}>
                          env: {s.envKeys.join(', ')}
                        </p>
                      )}
                      {s.importErrors.length > 0 && (
                        <p className="setup-hint" style={{ fontSize: 'var(--fs-xs)', marginTop: 2, color: 'var(--msg-error-fg)' }}>
                          {s.importErrors.join('; ')}
                        </p>
                      )}
                    </div>
                    <span className="setup-hint" style={{ fontSize: 'var(--fs-xs)', flexShrink: 0, marginTop: 2 }}>
                      {statusLabel(mcpRow(s.name))}
                    </span>
                  </div>
                ))}
                {data.mcpError && (
                  <p className="setup-hint">MCP servers unavailable: {data.mcpError}</p>
                )}

                {/* Marketplaces */}
                {data.marketplaces.map((m) => (
                  <div
                    key={m.id}
                    // 克隆目录不在的行整行压暗，与上面的 invalid MCP 行同一处置。
                    style={{ ...styles.row, opacity: !m.cloneExists ? 0.55 : 1 }}
                  >
                    {checkbox(mpRow(m.id), `Import ${m.id}`, () => void runImport({ credentials: false, mcp: [], marketplaces: [m.id] }), !m.cloneExists)}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <code style={{ ...styles.code, fontSize: 'var(--fs-sm)' }}>{m.id}</code>
                        <span className="setup-hint" style={{ fontSize: 'var(--fs-xs)' }}>
                          {`${m.pluginCount} plugin(s)`}
                          {m.cloneExists ? '' : ' · clone missing'}
                        </span>
                      </div>
                      <p className="setup-hint" style={{ fontSize: 'var(--fs-xs)', marginTop: 2 }}>{m.sourceUrl}</p>
                    </div>
                    <span className="setup-hint" style={{ fontSize: 'var(--fs-xs)', flexShrink: 0, marginTop: 2 }}>
                      {statusLabel(mpRow(m.id))}
                    </span>
                  </div>
                ))}
                {data.marketplacesError && (
                  <p className="setup-hint">Marketplaces unavailable: {data.marketplacesError}</p>
                )}

                {anyImportable && (
                  <button
                    type="button"
                    onClick={importAll}
                    disabled={importing}
                    style={{ ...styles.secondaryBtn, alignSelf: 'flex-start', marginTop: 4 }}
                  >
                    {importing ? 'Importing…' : 'Import all'}
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {error && <p role="alert" className="setup-field-error">{error}</p>}

        <div style={styles.footer}>
          <div style={styles.footerLeft} />
          <div style={styles.footerRight}>
            <button
              type="button"
              onClick={onContinue}
              disabled={submitting}
              // 导入可能是"拷一整个克隆目录"量级的等待，禁用必须看得出来
              // （step 0 的 Continue / step 4 的两个按钮同一写法）。
              style={{ ...styles.submitBtn, ...(submitting ? styles.submitBtnDisabled : null) }}
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

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
