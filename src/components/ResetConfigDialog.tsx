import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useExitPresence } from '../hooks/useExitPresence'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useToast } from '../hooks/useToast'
import { useResetConfig } from '../hooks/useResetConfig'
import { IconX } from './icons/ToolIcons'
import { SERVER_RESET_ITEMS, DANGER_ITEMS, type ServerResetItem, type BrowserDataItem } from '../../shared/reset'

const BROWSER_CHILDREN: BrowserDataItem[] = ['input-history', 'drafts', 'appearance']
const SERVER_LABELS: Record<ServerResetItem, string> = {
  'app-settings': 'App settings (reset to defaults; keeps connection)',
  'mcp-configs': 'MCP server configurations',
  'marketplaces': 'Marketplaces & enabled plugins',
  'snippets': 'Composer snippets',
  'ui-state': 'Session groups & sidebar order',
  'logs': 'Persisted log files (clears all; today reopens empty)',
  'credentials': 'Connection credentials (authToken, baseUrl, access token)',
  'sessions': 'All sessions & transcript caches',
}
const BROWSER_LABELS: Record<BrowserDataItem, string> = {
  'input-history': 'Input history',
  'drafts': 'Composer drafts',
  'appearance': 'Theme, layout & recent picks',
}

interface Props { open: boolean; onClose: () => void }

export function ResetConfigDialog({ open, onClose }: Props) {
  const presence = useExitPresence(open)
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef, { restoreFocus: true })
  const toast = useToast()
  const { reset, clearing } = useResetConfig()

  const [server, setServer] = useState<Set<ServerResetItem>>(new Set())
  const [browser, setBrowser] = useState<Set<BrowserDataItem>>(new Set())
  const [confirmGate, setConfirmGate] = useState(false)
  const [confirmText, setConfirmText] = useState('')

  // Reset state when dialog closes, synchronously before first paint so the
  // user never sees stale content from a previous invocation.
  /* eslint-disable react-hooks/set-state-in-effect -- intentional UI reset on open */
  useLayoutEffect(() => {
    if (!open) {
      setServer(new Set()); setBrowser(new Set()); setConfirmGate(false); setConfirmText('')
    }
  }, [open])
  /* eslint-enable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!presence.shouldRender) return null

  const toggleServer = (it: ServerResetItem) => setServer((s) => {
    const n = new Set(s); if (n.has(it)) { n.delete(it) } else { n.add(it) }; return n
  })
  const toggleBrowser = (it: BrowserDataItem) => setBrowser((s) => {
    const n = new Set(s); if (n.has(it)) { n.delete(it) } else { n.add(it) }; return n
  })
  const allBrowser = BROWSER_CHILDREN.every((c) => browser.has(c))
  const someBrowser = BROWSER_CHILDREN.some((c) => browser.has(c)) && !allBrowser
  const toggleAllBrowser = () => setBrowser(allBrowser ? new Set() : new Set(BROWSER_CHILDREN))

  const hasDanger = [...server].some((s) => (DANGER_ITEMS as readonly string[]).includes(s))
  const totalSelected = server.size + browser.size

  const doClear = async () => {
    if (hasDanger && !confirmGate) { setConfirmGate(true); return }
    if (hasDanger && confirmText !== 'reset') return
    try {
      const res = await reset({ server: [...server], browser: [...browser] })
      const okCount = Object.values(res.results).filter((r) => r?.ok).length
      const failed = Object.entries(res.results).filter(([, r]) => r && !r.ok)
      if (failed.length > 0) {
        // Partial failure: keep the dialog open so the user can see which
        // server items failed and retry/adjust. Reloading would destroy this
        // toast within 400ms — and for `credentials` a silent failure is a
        // safety gap on shared machines. Browser-side items already ran.
        const detail = failed
          .map(([k, r]) => `${SERVER_LABELS[k as ServerResetItem] ?? k}: ${(r as { error?: string }).error ?? 'failed'}`)
          .join('; ')
        toast.error(`Cleared ${okCount}; ${failed.length} failed — ${detail}`)
        return
      }
      toast.success(`Cleared ${okCount} item(s)`)
      onClose()
      setTimeout(() => location.reload(), 400)
    } catch (e) {
      // Server POST failed (network/5xx/abort). useResetConfig's finally has
      // already reset `clearing`; browser-side items were NOT cleared (they
      // run only after a successful POST). Keep the dialog open so the user
      // can retry/adjust — do not reload, since server state is uncertain.
      toast.error(`Reset failed: ${(e as Error).message}`)
    }
  }

  const renderServer = (it: ServerResetItem) => (
    <label key={it} className="reset-row">
      <input type="checkbox" checked={server.has(it)} onChange={() => toggleServer(it)} />
      <span>{SERVER_LABELS[it]}</span>
    </label>
  )
  const normalServer = (SERVER_RESET_ITEMS.filter((it) => !(DANGER_ITEMS as readonly string[]).includes(it)) as ServerResetItem[])

  return (
    <div className="modal-backdrop" data-state={open ? 'open' : 'closing'} role="dialog" aria-modal={open ? 'true' : 'false'} aria-hidden={!open}
      onMouseDown={(e) => open && !clearing && e.target === e.currentTarget && onClose()}>
      <div className="modal modal-reset-config" ref={dialogRef}>
        <div className="modal-header">
          <h3>Clear configuration &amp; data</h3>
          <button className="btn btn-icon-sm" onClick={onClose} disabled={clearing} aria-label="Close"><IconX size={14} /></button>
        </div>
        <div className="modal-section reset-config-body">
          <div className="reset-group">
            <div className="reset-group-label">Configuration &amp; data</div>
            {normalServer.map(renderServer)}
          </div>
          <div className="reset-group">
            <div className="reset-group-label">Browser data</div>
            <label className="reset-row">
              <input type="checkbox" ref={(el) => { if (el) el.indeterminate = someBrowser }} checked={allBrowser} onChange={toggleAllBrowser} />
              <span><strong>Browser data</strong> (all local caches)</span>
            </label>
            <div className="reset-sub">
              {BROWSER_CHILDREN.map((c) => (
                <label key={c} className="reset-row"><input type="checkbox" checked={browser.has(c)} onChange={() => toggleBrowser(c)} /><span>{BROWSER_LABELS[c]}</span></label>
              ))}
            </div>
          </div>
          <div className="reset-group reset-danger-zone">
            <div className="reset-group-label">Danger zone</div>
            {(DANGER_ITEMS as readonly ServerResetItem[]).map(renderServer)}
          </div>
        </div>
        <div className="modal-footer">
          <span className="hint">{totalSelected ? `Will clear ${totalSelected} item(s)` : 'Select items to clear'}</span>
          <div className="modal-footer-actions">
            <button className="btn" onClick={onClose} disabled={clearing}>Cancel</button>
            {confirmGate ? (
              <>
                <input className="input" placeholder="type reset to confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} style={{ width: 160 }} />
                <button className="btn btn-danger" disabled={confirmText !== 'reset' || clearing} onClick={doClear}>Confirm</button>
              </>
            ) : (
              <button className="btn btn-danger" disabled={!totalSelected || clearing} onClick={doClear}>Clear selected</button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default ResetConfigDialog
