import { useState } from 'react'
import { useDiagnostics } from '../hooks/useDiagnostics'

export function DiagnosticsPanel({ sessionId }: { sessionId: string }) {
  const { data, loading, error, refresh, setCliDebug } = useDiagnostics(sessionId)
  const [saving, setSaving] = useState(false)

  async function choose(value: boolean | null) {
    setSaving(true)
    try {
      await setCliDebug(value)
    } catch {
      // keep minimal — the hook keeps prior data; a toast could be added later
    } finally {
      setSaving(false)
    }
  }

  if (loading && !data) return <div className="settings-field">Loading diagnostics…</div>
  if (error && !data) return <div className="settings-card-error">{error}</div>

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h4>Diagnostics</h4>
        <button className="btn btn-sm" onClick={() => void refresh()}>Refresh</button>
      </div>

      <label className="settings-field">
        <span>CLI debug logging</span>
        <select
          value={data?.cliDebug.perSession === undefined ? '' : data.cliDebug.perSession ? 'on' : 'off'}
          onChange={(e) => {
            const v = e.target.value
            void choose(v === '' ? null : v === 'on')
          }}
          disabled={saving}>
          <option value="">Global ({data?.cliDebug.global ? 'on' : 'off'})</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
        <span className="settings-hint">Applies on the next session start.</span>
      </label>

      <div className="settings-field settings-field-block">
        <span>stderr tail</span>
        <pre className="diag-stderr">
          {(data?.stderrTail ?? []).slice(-100).join('\n') || '(no stderr yet)'}
        </pre>
        <span className="settings-hint">{(data?.stderrTail ?? []).length} lines captured</span>
      </div>

      {data?.debugLog.exists && (
        <div className="settings-field">
          <span>Debug log</span>
          <code className="settings-hint">{data.debugLog.path}</code>
          <span className="settings-hint"> ({data.debugLog.size} bytes)</span>
        </div>
      )}
    </div>
  )
}