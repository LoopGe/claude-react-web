// Modal for exporting the configured MCP servers as a versioned JSON file.
// Lets the user pick which servers to export and whether to include secret
// env/header values.

import { useEffect, useMemo, useState } from 'react'
import { api } from '../hooks/useApi'
import { downloadJson } from '../utils/downloadJson'
import type { McpServerConfigMeta, McpExportFile } from '../types'
import { Overlay } from './Overlay'
import { IconX } from './icons/ToolIcons'

interface Props {
  open?: boolean
  servers: McpServerConfigMeta[]
  onClose: () => void
}

export function McpExportDialog({ open = true, servers, onClose }: Props) {
  const names = useMemo(() => servers.map((s) => s.name), [servers])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset to all-checked whenever the server list or open state changes.
  /* eslint-disable react-hooks/set-state-in-effect -- intentional UI reset on open / server-list change */
  useEffect(() => {
    setSelected(Object.fromEntries(names.map((n) => [n, true])))
  }, [names, open])
  /* eslint-enable react-hooks/set-state-in-effect */

  const selectedCount = names.filter((n) => selected[n]).length

  const download = async () => {
    const chosen = names.filter((n) => selected[n])
    if (chosen.length === 0) return
    setError(null)
    setExporting(true)
    try {
      const params = new URLSearchParams()
      if (includeSecrets) params.set('includeSecrets', '1')
      if (chosen.length !== names.length) params.set('names', chosen.join(','))
      const qs = params.toString()
      const data = await api.get<McpExportFile>(qs ? `/mcp-config/export?${qs}` : '/mcp-config/export')
      downloadJson('claude-react-web-mcp-servers.json', data)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  return (
    <Overlay
      variant="modal"
      portal
      open={open}
      onClose={onClose}
      inertOnExit
      cardStyle={{ width: 'min(520px, 92vw)' }}
      ariaLabel="Export MCP servers"
    >
      <div className="modal-header">
        <h3>Export MCP Servers</h3>
        <button className="btn" onClick={onClose} style={{ padding: '2px 10px' }} aria-label="Close"><IconX size={14} /></button>
      </div>
      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10, maxHeight: '60vh', overflowY: 'auto' }}>
        <div className="settings-section-head" style={{ alignItems: 'center' }}>
          <span className="settings-note">{servers.length} server{servers.length !== 1 ? 's' : ''}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => setSelected(Object.fromEntries(names.map((n) => [n, true])))}>Select all</button>
            <button className="btn" onClick={() => setSelected(Object.fromEntries(names.map((n) => [n, false])))}>Select none</button>
          </div>
        </div>
        {servers.length === 0 && <div className="hint">No MCP servers configured.</div>}
        {servers.map((srv) => (
          <label key={srv.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={!!selected[srv.name]}
              onChange={(e) => setSelected((prev) => ({ ...prev, [srv.name]: e.target.checked }))}
            />
            <span style={{ fontWeight: 500 }}>{srv.name}</span>
            <span className="settings-card-badge">{srv.type}</span>
          </label>
        ))}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={includeSecrets} onChange={(e) => setIncludeSecrets(e.target.checked)} />
          Include secret values (env/headers)
        </label>
        {!includeSecrets && (
          <span className="settings-note">Secrets will be blanked — re-enter them on the target machine.</span>
        )}
        {error && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>}
      </div>
      <div className="modal-footer">
        <span className="hint">Press Esc to cancel.</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void download()} disabled={exporting || selectedCount === 0}>
            {exporting ? 'Exporting…' : 'Download'}
          </button>
        </div>
      </div>
    </Overlay>
  )
}
