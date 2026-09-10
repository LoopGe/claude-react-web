import { useState } from 'react'
import { useDiagnostics } from '../hooks/useDiagnostics'
import { SettingsRow } from './SettingsRow'
import { Skeleton } from './Skeleton'

/** Lines shown in the Diagnostics tab — full context for deep inspection. */
const STDERR_PANEL_LINES = 100

export function DiagnosticsPanel({ sessionId }: { sessionId: string }) {
  const { data, loading, error, refresh, setCliDebug } = useDiagnostics(sessionId)
  const [saving, setSaving] = useState(false)
  const [mutationError, setMutationError] = useState<string | null>(null)

  async function choose(value: boolean | null) {
    setSaving(true)
    setMutationError(null)
    try {
      await setCliDebug(value)
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (loading && !data) {
    return (
      <div className="settings-section">
        <span className="settings-note">Loading diagnostics…</span>
        <Skeleton rows={2} />
      </div>
    )
  }
  if (error && !data) {
    return <div className="settings-section"><div className="settings-card-error">{error}</div></div>
  }

  const stderrLines = data?.stderrTail ?? []

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h4>Diagnostics</h4>
        <button className="btn btn-sm" onClick={() => void refresh()}>Refresh</button>
      </div>

      <div className="settings-stack">
        <section className="settings-group">
          <div className="settings-group-head">
            <h4>CLI debugging</h4>
            <span className="settings-group-desc">Verbose logging from the CLI subprocess backing this session.</span>
          </div>
          <SettingsRow
            stack
            title="CLI debug logging"
            hint={<>Toggles debug output for this session. Applies on the next session start.</>}
          >
            <select
              className="select"
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
          </SettingsRow>
        </section>

        <section className="settings-group">
          <div className="settings-group-head">
            <h4>Process output</h4>
            <span className="settings-group-desc">Live stderr recently captured from the CLI subprocess.</span>
          </div>
          <SettingsRow stack title="stderr tail" hint={`${stderrLines.length} lines captured`}>
            <pre className="diag-stderr">
              {stderrLines.slice(-STDERR_PANEL_LINES).join('\n') || '(no stderr yet)'}
            </pre>
          </SettingsRow>
        </section>

        {data?.debugLog.exists && (
          <section className="settings-group">
            <div className="settings-group-head">
              <h4>Debug log</h4>
              <span className="settings-group-desc">On-disk log file written for this session.</span>
            </div>
            <SettingsRow stack title="Log path">
              <code className="settings-note">{data.debugLog.path}</code>
              <span className="settings-note"> ({data.debugLog.size} bytes)</span>
            </SettingsRow>
          </section>
        )}
      </div>

      {mutationError && <div className="settings-card-error">{mutationError}</div>}
    </div>
  )
}
