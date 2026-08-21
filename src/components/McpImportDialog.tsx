// Modal for importing MCP servers from a JSON file. Receives the chosen
// File from the parent, posts it to /import/preview to get a masked preview,
// renders new / conflict / invalid sections, then posts the checked
// selection to /import.

import { useEffect, useState } from 'react'
import { api } from '../hooks/useApi'
import type { McpImportPreviewServer, McpImportResult } from '../types'
import { Overlay } from './Overlay'
import { IconX } from './icons/ToolIcons'

interface Props {
  open?: boolean
  file: File | null
  onClose: () => void
  onImported: () => void
}

type Phase = 'loading' | 'preview' | 'importing' | 'summary'

export function McpImportDialog({ open = true, file, onClose, onImported }: Props) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [preview, setPreview] = useState<McpImportPreviewServer[]>([])
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [fileText, setFileText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<McpImportResult | null>(null)

  // Load + preview the file each time the dialog opens with a file present.
  /* eslint-disable react-hooks/set-state-in-effect -- intentional UI reset on open / file change */
  useEffect(() => {
    if (!open || !file) return
    let cancelled = false
    setPhase('loading')
    setError(null)
    setSummary(null)
    void (async () => {
      try {
        const text = await file.text()
        if (cancelled) return
        setFileText(text)
        const r = await api.post<{ servers: McpImportPreviewServer[] }>('/mcp-config/import/preview', { file: text })
        if (cancelled) return
        setPreview(r.servers)
        setChecked(Object.fromEntries(
          r.servers.filter((s) => s.errors.length === 0).map((s) => [s.name, !s.exists]),
        ))
        setPhase('preview')
      } catch (e) {
        if (cancelled) return
        setError((e as Error).message)
        setPhase('preview')
      }
    })()
    return () => { cancelled = true }
  }, [open, file])
  /* eslint-enable react-hooks/set-state-in-effect */

  const newServers = preview.filter((s) => s.errors.length === 0 && !s.exists)
  const conflicts = preview.filter((s) => s.errors.length === 0 && s.exists)
  const invalid = preview.filter((s) => s.errors.length > 0)

  const checkedNames = preview.filter((s) => checked[s.name]).map((s) => s.name)
  const anyConflictChecked = conflicts.some((s) => checked[s.name])
  const validSelected = checkedNames.length > 0

  const toggleConflict = (value: boolean) => {
    setChecked((prev) => ({ ...prev, ...Object.fromEntries(conflicts.map((s) => [s.name, value])) }))
  }

  const doImport = async () => {
    if (checkedNames.length === 0) return
    setPhase('importing')
    setError(null)
    try {
      const r = await api.post<McpImportResult>('/mcp-config/import', {
        file: fileText,
        names: checkedNames,
        overwrite: anyConflictChecked,
      })
      setSummary(r)
      setPhase('summary')
      onImported()
    } catch (e) {
      setError((e as Error).message)
      setPhase('preview')
    }
  }

  return (
    <Overlay
      variant="modal"
      portal
      open={open}
      onClose={onClose}
      inertOnExit
      cardStyle={{ width: 'min(560px, 92vw)' }}
      ariaLabel="Import MCP servers"
    >
      <div className="modal-header">
        <h3>Import MCP Servers</h3>
        <button className="btn" onClick={onClose} style={{ padding: '2px 10px' }} aria-label="Close"><IconX size={14} /></button>
      </div>

      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '62vh', overflowY: 'auto' }}>
        {phase === 'loading' && <div className="hint">Reading file…</div>}
        {phase === 'importing' && <div className="hint">Importing…</div>}

        {phase === 'preview' && error && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>}

        {phase === 'preview' && !error && preview.length === 0 && (
          <div className="hint">No servers found in this file.</div>
        )}

        {phase === 'preview' && !error && (
          <>
            {newServers.length > 0 && (
              <>
                <div className="settings-note">New servers</div>
                {newServers.map((s) => (
                  <ImportRow key={s.name} srv={s} checked={!!checked[s.name]} onToggle={(v) => setChecked((prev) => ({ ...prev, [s.name]: v }))} />
                ))}
              </>
            )}

            {conflicts.length > 0 && (
              <div className="settings-card" style={{ borderColor: 'var(--warn)' }}>
                <div className="settings-note" style={{ color: 'var(--warn)' }}>
                  Already exist — checking a row will overwrite it
                </div>
                {conflicts.map((s) => (
                  <ImportRow key={s.name} srv={s} checked={!!checked[s.name]} onToggle={(v) => setChecked((prev) => ({ ...prev, [s.name]: v }))} />
                ))}
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 4 }}>
                  <input type="checkbox" checked={conflicts.length > 0 && conflicts.every((s) => checked[s.name])} onChange={(e) => toggleConflict(e.target.checked)} />
                  Overwrite all existing
                </label>
              </div>
            )}

            {invalid.length > 0 && (
              <>
                <div className="settings-note" style={{ color: 'var(--danger)' }}>Invalid (skipped)</div>
                {invalid.map((s) => (
                  <div key={s.name} className="settings-card" style={{ borderColor: 'var(--danger)', opacity: 0.7 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                      <span style={{ fontWeight: 500 }}>{s.name}</span>
                      <span style={{ color: 'var(--danger)', fontSize: 12 }}>{s.errors.join('; ')}</span>
                    </div>
                  </div>
                ))}
              </>
            )}
          </>
        )}

        {phase === 'summary' && summary && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
            <div>Imported: {summary.imported.length}</div>
            <div>Updated: {summary.updated.length}</div>
            <div>Skipped: {summary.skipped.length}</div>
            {summary.failed.length > 0 && (
              <div style={{ color: 'var(--danger)' }}>
                Failed: {summary.failed.map((f) => `${f.name}: ${f.error}`).join('; ')}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="modal-footer">
        <span className="hint">Press Esc to cancel.</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={onClose} disabled={phase === 'importing'}>
            {phase === 'summary' ? 'Done' : 'Cancel'}
          </button>
          {phase === 'preview' && !error && (
            <button className="btn btn-primary" onClick={() => void doImport()} disabled={!validSelected}>
              {validSelected ? `Import ${checkedNames.length}` : 'Import'}
            </button>
          )}
        </div>
      </div>
    </Overlay>
  )
}

function ImportRow({ srv, checked, onToggle }: {
  srv: McpImportPreviewServer
  checked: boolean
  onToggle: (v: boolean) => void
}) {
  const secretKeys = [...(srv.envKeys ?? []), ...(srv.headerKeys ?? [])]
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} />
      <span style={{ fontWeight: 500 }}>{srv.name}</span>
      <span className="settings-card-badge">{srv.type}</span>
      {secretKeys.length > 0 && (
        <span className="settings-note" style={{ fontSize: 11, marginLeft: 'auto' }}>
          needs: {secretKeys.join(', ')}
        </span>
      )}
    </label>
  )
}
