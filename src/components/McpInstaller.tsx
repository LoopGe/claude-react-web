// Modal form for adding or editing a global MCP server config.
//
// Renders a structured form instead of raw JSON. Dynamic key-value rows
// for env vars and headers, type-specific fields, client + server validation.

import { useEffect, useState } from 'react'
import { api } from '../hooks/useApi'
import type { McpServerConfigMeta, McpServerInput } from '../types'

interface Props {
  /** If set, we're editing an existing server (name is locked). */
  server?: McpServerConfigMeta
  onSave: () => void
  onClose: () => void
}

interface KvRow {
  id: string
  key: string
  value: string
}

let _kvId = 0
const nextKvId = () => String(++_kvId)

function recordFromRows(rows: KvRow[]): Record<string, string> | undefined {
  const entries = rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value])
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

export function McpInstaller({ server, onSave, onClose }: Props) {
  const isEdit = !!server

  const [name, setName] = useState(server?.name ?? '')
  const [type, setType] = useState<'stdio' | 'sse' | 'http'>(server?.type ?? 'stdio')
  const [command, setCommand] = useState(server?.command ?? '')
  const [argsText, setArgsText] = useState(server?.args?.join('\n') ?? '')
  const [url, setUrl] = useState(server?.url ?? '')
  const [alwaysLoad, setAlwaysLoad] = useState(server?.alwaysLoad ?? false)
  // When editing, pre-populate with existing keys (values are masked,
  // so value fields are left empty — the server merges on PUT).
  const [envRows, setEnvRows] = useState<KvRow[]>(() =>
    server?.envKeys && server.envKeys.length > 0
      ? server.envKeys.map((k) => ({ id: nextKvId(), key: k, value: '' }))
      : [{ id: nextKvId(), key: '', value: '' }],
  )
  const [headerRows, setHeaderRows] = useState<KvRow[]>(() =>
    server?.headerKeys && server.headerKeys.length > 0
      ? server.headerKeys.map((k) => ({ id: nextKvId(), key: k, value: '' }))
      : [{ id: nextKvId(), key: '', value: '' }],
  )
  const [errors, setErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  // Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const updateRow = (rows: KvRow[], setter: (r: KvRow[]) => void, id: string, field: 'key' | 'value', val: string) => {
    setter(rows.map((r) => (r.id === id ? { ...r, [field]: val } : r)))
  }

  const addRow = (rows: KvRow[], setter: (r: KvRow[]) => void) => {
    setter([...rows, { id: nextKvId(), key: '', value: '' }])
  }

  const removeRow = (rows: KvRow[], setter: (r: KvRow[]) => void, id: string) => {
    const next = rows.filter((r) => r.id !== id)
    if (next.length === 0) next.push({ id: nextKvId(), key: '', value: '' })
    setter(next)
  }

  const submit = async () => {
    setErrors([])

    // Build input
    const input: McpServerInput = {
      name: name.trim(),
      type,
      alwaysLoad: alwaysLoad || undefined,
    }
    if (type === 'stdio') {
      input.command = command.trim() || undefined
      const args = argsText.split('\n').map((l) => l.trim()).filter(Boolean)
      if (args.length > 0) input.args = args
    } else {
      input.url = url.trim() || undefined
    }
    const env = recordFromRows(envRows)
    if (env) input.env = env
    const headers = recordFromRows(headerRows)
    if (headers) input.headers = headers

    // Client-side validate
    if (!input.name) { setErrors(['Name is required']); return }
    if (type === 'stdio' && !input.command) { setErrors(['Command is required for stdio type']); return }
    if (type !== 'stdio' && !input.url) { setErrors([`URL is required for ${type} type`]); return }

    // Server-side validate
    try {
      const v = await api.post<{ valid: boolean; errors: string[] }>('/mcp-config/validate', input)
      if (!v.valid) { setErrors(v.errors); return }
    } catch (e) {
      setErrors([(e as Error).message])
      return
    }

    setSaving(true)
    try {
      if (isEdit) {
        // On edit, only send changed fields (env/headers with empty values
        // are omitted so they don't accidentally clear existing secrets).
        const update: Partial<McpServerInput> = {}
        if (type !== server!.type) update.type = type
        if (type === 'stdio') {
          if (command.trim() !== (server!.command ?? '')) update.command = command.trim()
          const newArgs = argsText.split('\n').map((l) => l.trim()).filter(Boolean)
          update.args = newArgs
        } else {
          if (url.trim() !== (server!.url ?? '')) update.url = url.trim()
        }
        // Only send env/headers when user typed new values
        const envUpdate = recordFromRows(envRows.filter((r) => r.value.trim()))
        if (envUpdate) update.env = envUpdate
        const hdrUpdate = recordFromRows(headerRows.filter((r) => r.value.trim()))
        if (hdrUpdate) update.headers = hdrUpdate
        if (alwaysLoad !== (server!.alwaysLoad ?? false)) update.alwaysLoad = alwaysLoad
        await api.put(`/mcp-config/${encodeURIComponent(name)}`, update)
      } else {
        await api.post('/mcp-config', input)
      }
      onSave()
    } catch (e) {
      setErrors([(e as Error).message])
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 'min(520px, 92vw)' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{isEdit ? `Edit: ${server!.name}` : 'Add MCP Server'}</h3>
          <button className="btn" onClick={onClose} style={{ padding: '2px 10px' }}>✕</button>
        </div>

        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '65vh', overflowY: 'auto' }}>
          {/* Name */}
          <div className="settings-field">
            <label>Name</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isEdit}
              placeholder="my-mcp-server"
            />
          </div>

          {/* Type */}
          <div className="settings-field">
            <label>Type</label>
            <select
              className="input"
              value={type}
              onChange={(e) => setType(e.target.value as 'stdio' | 'sse' | 'http')}
              disabled={isEdit}
            >
              <option value="stdio">stdio (spawn a process)</option>
              <option value="sse">SSE (Server-Sent Events)</option>
              <option value="http">HTTP (Streamable HTTP)</option>
            </select>
          </div>

          {/* stdio: command + args */}
          {type === 'stdio' && (
            <>
              <div className="settings-field">
                <label>Command</label>
                <input
                  className="input"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx"
                />
              </div>
              <div className="settings-field">
                <label>Arguments (one per line)</label>
                <textarea
                  className="textarea"
                  rows={3}
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  placeholder={'-y\n@anthropic-ai/mcp-server-example'}
                />
              </div>
            </>
          )}

          {/* sse / http: url */}
          {type !== 'stdio' && (
            <div className="settings-field">
              <label>URL</label>
              <input
                className="input"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="http://localhost:3000"
              />
            </div>
          )}

          {/* Env vars (stdio) */}
          {type === 'stdio' && (
            <KvEditor
              label="Environment Variables"
              rows={envRows}
              onUpdate={(id, field, val) => updateRow(envRows, setEnvRows, id, field, val)}
              onAdd={() => addRow(envRows, setEnvRows)}
              onRemove={(id) => removeRow(envRows, setEnvRows, id)}
              valuePlaceholder={isEdit ? 'leave empty to keep' : 'value'}
            />
          )}

          {/* Headers (sse/http) */}
          {type !== 'stdio' && (
            <KvEditor
              label="Request Headers"
              rows={headerRows}
              onUpdate={(id, field, val) => updateRow(headerRows, setHeaderRows, id, field, val)}
              onAdd={() => addRow(headerRows, setHeaderRows)}
              onRemove={(id) => removeRow(headerRows, setHeaderRows, id)}
              valuePlaceholder={isEdit ? 'leave empty to keep' : 'value'}
            />
          )}

          {/* alwaysLoad */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={alwaysLoad}
              onChange={(e) => setAlwaysLoad(e.target.checked)}
            />
            Always load tools (included in every prompt)
          </label>

          {/* Errors */}
          {errors.length > 0 && (
            <div style={{ color: 'var(--danger)', fontSize: 13 }}>
              {errors.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <span className="hint">Press Esc to cancel.</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={submit} disabled={saving}>
              {saving ? 'Saving…' : isEdit ? 'Save' : 'Add Server'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Key-Value row editor ──────────────────────────────────────────

function KvEditor({
  label,
  rows,
  onUpdate,
  onAdd,
  onRemove,
  valuePlaceholder,
}: {
  label: string
  rows: KvRow[]
  onUpdate: (id: string, field: 'key' | 'value', val: string) => void
  onAdd: () => void
  onRemove: (id: string) => void
  valuePlaceholder?: string
}) {
  return (
    <div className="settings-field">
      <label>{label}</label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rows.map((row) => (
          <div key={row.id} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              className="input"
              style={{ flex: 1, fontSize: 12 }}
              placeholder="key"
              value={row.key}
              onChange={(e) => onUpdate(row.id, 'key', e.target.value)}
            />
            <input
              className="input"
              type="password"
              style={{ flex: 1, fontSize: 12 }}
              placeholder={valuePlaceholder ?? 'value'}
              value={row.value}
              onChange={(e) => onUpdate(row.id, 'value', e.target.value)}
            />
            <button
              className="btn"
              style={{ padding: '2px 6px', fontSize: 11, flexShrink: 0 }}
              onClick={() => onRemove(row.id)}
              title="Remove"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          className="btn"
          style={{ fontSize: 11, alignSelf: 'flex-start', padding: '2px 8px' }}
          onClick={onAdd}
        >
          + Add
        </button>
      </div>
    </div>
  )
}
