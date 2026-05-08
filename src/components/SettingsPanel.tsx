// Right-side settings drawer. Focuses on mid-session controls — options that
// can only be set at session creation are shown read-only at the top.

import { useEffect, useState } from 'react'
import { api } from '../hooks/useApi'
import type { ModelInfo, PermissionMode, SessionInfo } from '../types'

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto']

interface Props {
  session: SessionInfo
  onClose: () => void
  onSessionUpdate: (s: SessionInfo) => void
}

export function SettingsPanel({ session, onClose, onSessionUpdate }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [settingsText, setSettingsText] = useState('{}')
  const [usage, setUsage] = useState<unknown>(null)
  const [mcp, setMcp] = useState<unknown>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Load supported models and MCP status when the panel opens. Parent
  // remounts this component on session switch (via `key={session.id}`),
  // so there's no need to imperatively reset state here. All three calls
  // forward SDK control requests to the subprocess — if the session isn't
  // running the server returns 410; skip them rather than surface noise.
  useEffect(() => {
    if (!session.running) return
    ;(async () => {
      try {
        const m = await api.get<{ models: ModelInfo[] }>(`/sessions/${session.id}/models`)
        setModels(m.models)
      } catch (e) {
        // Supported models fails if SDK hasn't initialized yet — retry silently
        console.warn('could not load models:', (e as Error).message)
      }
      try {
        const u = await api.get<{ usage: unknown }>(`/sessions/${session.id}/context-usage`)
        setUsage(u.usage)
      } catch {
        /* ignore */
      }
      try {
        const r = await api.get<{ mcp: unknown }>(`/sessions/${session.id}/mcp-status`)
        setMcp(r.mcp)
      } catch {
        /* ignore */
      }
    })()
  }, [session.id, session.running])

  const runAndRefresh = async (fn: () => Promise<{ session: SessionInfo }>) => {
    setBusy(true)
    setErr(null)
    try {
      const r = await fn()
      onSessionUpdate(r.session)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const changeModel = (model: string) =>
    runAndRefresh(() => api.post<{ session: SessionInfo }>(`/sessions/${session.id}/model`, { model: model || undefined }))

  const changePermissionMode = (mode: PermissionMode) =>
    runAndRefresh(() => api.post<{ session: SessionInfo }>(`/sessions/${session.id}/permission-mode`, { mode }))

  const applySettings = async () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(settingsText || '{}')
    } catch (e) {
      setErr(`Invalid JSON: ${(e as Error).message}`)
      return
    }
    await runAndRefresh(() =>
      api.post<{ session: SessionInfo }>(`/sessions/${session.id}/settings`, { settings: parsed }),
    )
  }

  return (
    <aside className="settings-panel">
      <h3>
        Session settings
        <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={onClose}>
          Close
        </button>
      </h3>

      {err && <div className="error-bar">{err}</div>}

      <div className="settings-section">
        <h4>Read-only (set at create)</h4>
        <ReadOnlyField label="Session ID" value={session.id} mono />
        <ReadOnlyField label="CWD" value={session.cwd ?? '—'} mono />
        <ReadOnlyField label="Title" value={session.title ?? '—'} />
        <ReadOnlyField label="Created" value={new Date(session.createdAt).toLocaleString()} />
      </div>

      <div className="settings-section">
        <h4>Live controls</h4>
        <div className="settings-field">
          <label>Model</label>
          <select
            className="select"
            value={session.model ?? ''}
            onChange={(e) => void changeModel(e.target.value)}
            disabled={busy || session.terminated}
          >
            <option value="">(default)</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name ?? m.id}
              </option>
            ))}
          </select>
          <span className="hint">Changes apply to the next assistant turn.</span>
        </div>

        <div className="settings-field">
          <label>Permission mode</label>
          <select
            className="select"
            value={session.permissionMode ?? 'default'}
            onChange={(e) => void changePermissionMode(e.target.value as PermissionMode)}
            disabled={busy || session.terminated}
          >
            {PERMISSION_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-field">
          <label>Merge flag settings (JSON)</label>
          <textarea
            className="textarea"
            rows={6}
            value={settingsText}
            onChange={(e) => setSettingsText(e.target.value)}
            placeholder='{"permissions": {...}, "env": {...}}'
          />
          <span className="hint">
            Calls <code>Query.applyFlagSettings()</code>. Top-level keys are shallow-merged across calls.
          </span>
          <button className="btn btn-primary" onClick={applySettings} disabled={busy || session.terminated}>
            Apply settings
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h4>Context usage</h4>
        <pre className="tool-input" style={{ maxHeight: 220, overflow: 'auto' }}>
          {usage ? formatJson(usage) : '—'}
        </pre>
      </div>

      <div className="settings-section">
        <h4>MCP servers</h4>
        <pre className="tool-input" style={{ maxHeight: 220, overflow: 'auto' }}>
          {mcp ? formatJson(mcp) : '—'}
        </pre>
      </div>
    </aside>
  )
}

function ReadOnlyField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="settings-field">
      <label>{label}</label>
      <div
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          padding: '6px 8px',
          borderRadius: 6,
          fontFamily: mono ? 'var(--mono)' : undefined,
          fontSize: mono ? 12 : undefined,
          color: 'var(--fg-muted)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={value}
      >
        {value}
      </div>
    </div>
  )
}

function formatJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}
