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
import type { WebImportEnumeration, WebImportResult } from '../../shared/web-import'

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

  /** 发一次导入请求。成功后：只要服务端已 configured 就收尾（这正是用户选的
   *  "凭证导入成功即收尾"），否则留在本屏让状态位更新。
   *
   *  成功且 configured 的分支**刻意不 reset `submitting`**：parent（SetupPage）
   *  会因为已配置而卸载本屏，`setSubmitting(false)` 只是在卸载后写 state
   *  （dev 下会报 set-state-on-unmounted）——与 SetupPage.finalize 的收尾同形，
   *  不要"顺手修"成 finally。另一个分支（导入了但服务端仍未 configured）留在
   *  本屏，必须复位，否则 Next / Import all 会永久禁用。 */
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
      const res = await api.post<WebImportResult>('/config/web-import', sel)
      setStatus((prev) => {
        const next = { ...prev }
        if (sel.credentials) next[CREDENTIALS_ROW] = res.credentials?.imported ? 'imported' : 'failed'
        for (const n of res.mcp.imported) next[mcpRow(n)] = 'imported'
        for (const n of res.mcp.skipped) next[mcpRow(n)] = 'exists'
        for (const f of res.mcp.failed) next[mcpRow(f.name)] = 'failed'
        for (const id of res.marketplaces.imported) next[mpRow(id)] = 'imported'
        for (const id of res.marketplaces.skipped) next[mpRow(id)] = 'exists'
        for (const f of res.marketplaces.failed) next[mpRow(f.name)] = 'failed'
        return next
      })
      // 逐项失败不弹错、不阻断：行上的 Failed 就是信号（与 step 3 一致）。
      if (res.credentials?.configured) {
        await onConfigured()
        return
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    }
    setSubmitting(false)
  }, [submitting, onConfigured])

  /** 渲染期一律读 state，不读 ref：ref 是给异步 handler 读"最新值"用的，在这里
   *  没有任何异步 handler 需要它，用 ref 反而会慢一帧（anyImportable 这类派生值
   *  会因此算错）。 */
  const statusOf = (key: string): RowStatus => status[key] ?? 'idle'
  const doneOrRunning = (key: string) => {
    const s = statusOf(key)
    return s === 'importing' || s === 'imported' || s === 'exists'
  }

  const importing = submitting
  const nothingToImport = data !== undefined && !probeError && (
    !data.credentials && data.mcp.length === 0 && data.marketplaces.length === 0
  )

  /** 批量导入：把还没导入 / 还没存在的项一次 POST 出去。 */
  const importAll = () => {
    const sel = {
      credentials: !doneOrRunning(CREDENTIALS_ROW) && data?.credentials != null,
      mcp: (data?.mcp ?? []).filter((s) => statusOf(mcpRow(s.name)) === 'idle').map((s) => s.name),
      marketplaces: (data?.marketplaces ?? []).filter((m) => statusOf(mpRow(m.id)) === 'idle').map((m) => m.id),
    }
    if (!sel.credentials && sel.mcp.length === 0 && sel.marketplaces.length === 0) return
    void runImport(sel)
  }

  /** 任意一项可导入 ⇒ Import all 有活干（predicate 与 importAll 的 filter 同构）。 */
  const anyImportable = data !== undefined && (
    (data.credentials != null && !doneOrRunning(CREDENTIALS_ROW))
    || data.mcp.some((s) => statusOf(mcpRow(s.name)) === 'idle')
    || data.marketplaces.some((m) => statusOf(mpRow(m.id)) === 'idle')
  )

  const statusLabel = (key: string) => {
    const s = statusOf(key)
    if (s === 'importing') return 'Importing…'
    if (s === 'imported') return <span style={styles.ok}><IconCheck size={12} /> Imported</span>
    if (s === 'exists') return 'Already exists'
    if (s === 'failed') return <span style={styles.fail}>Failed</span>
    return null
  }

  const checkbox = (key: string, label: string, onCheck: () => void) => {
    const s = statusOf(key)
    const done = s === 'imported' || s === 'exists'
    return (
      <input
        type="checkbox"
        checked={done}
        disabled={done || s === 'importing' || submitting}
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

        {/* 源里什么都没有 —— 明确说明，而不是渲染一张空清单。 */}
        {data !== undefined && nothingToImport && (
          <>
            <div className="setup-health-row setup-health-row-fail">
              <span className="setup-health-icon" aria-hidden="true">!</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ ...styles.hint, color: 'var(--fg)' }}>No Claude Web config found.</p>
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
                  <div key={s.name} style={styles.row}>
                    {checkbox(mcpRow(s.name), `Import ${s.name}`, () => void runImport({ credentials: false, mcp: [s.name], marketplaces: [] }))}
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
                  <div key={m.id} style={styles.row}>
                    {checkbox(mpRow(m.id), `Import ${m.id}`, () => void runImport({ credentials: false, mcp: [], marketplaces: [m.id] }))}
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
              style={styles.submitBtn}
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
}