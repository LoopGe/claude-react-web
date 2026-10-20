// Global Settings → Server tab section for daemon auto-start. Deliberately
// NOT part of the unified Save: every action here is an immediate POST
// (enable/disable/start/stop) whose side effect is OS registration, not a
// config.json field edit. Status is self-fetched — the toggle reflects the
// server-reported actual state, never an optimistic guess.
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../hooks/useApi'
import { isDesktopHost } from '../../host-capabilities'
import { Switch } from '../Switch'
import { SettingsRow } from '../SettingsRow'

interface DaemonStatus {
  supported: boolean
  supportReason?: string
  mechanism: string
  configEnabled: boolean
  osRegistered: boolean
  drift: boolean
  daemonAlive: boolean
  child: { state: string; uptimeSec: number; restartCount: number; lastError: string | null } | null
}

type DaemonAction = '/daemon/enable' | '/daemon/disable' | '/daemon/start' | '/daemon/stop'

export function DaemonSection() {
  const [status, setStatus] = useState<DaemonStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const desktop = isDesktopHost()

  const refresh = useCallback(async () => {
    // Status only — error state is owned by the callers (act / initial load),
    // so a successful refresh never erases an action error that was just set.
    try {
      setStatus(await api.get<DaemonStatus>('/daemon/status'))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    if (desktop) return
    // refresh is async — every setState inside runs after an await, never
    // synchronously in the effect body (same pattern as SetupPage's probe).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [desktop, refresh])

  if (desktop || status == null) return null

  const act = async (path: DaemonAction) => {
    setBusy(true)
    try {
      setStatus(await api.post<DaemonStatus>(path, {}))
      setError(null)
    } catch (e) {
      // Surface the raw error, then re-read the server's actual state so the
      // toggle falls back to reality instead of an optimistic guess.
      setError((e as Error).message)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const checked = status.osRegistered

  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <h4>Auto-start (daemon)</h4>
        <span className="settings-group-desc">
          Run the server automatically when you log in, supervised in the
          background ({status.mechanism}).
        </span>
      </div>
      <SettingsRow
        title="Run automatically at login"
        hint="The server starts hidden at login and restarts automatically if it crashes. Turning this off removes the OS registration but does not stop a running daemon."
      >
        <Switch
          label="Run automatically at login"
          checked={checked}
          disabled={busy}
          onChange={(v) => void act(v ? '/daemon/enable' : '/daemon/disable')}
        />
      </SettingsRow>
      {status.drift && (
        <SettingsRow
          title="Registration drift detected"
          hint="Config says auto-start is on, but the OS registration is missing (removed manually, or the install path changed). Re-register to repair."
        >
          <button type="button" className="btn" disabled={busy} onClick={() => void act('/daemon/enable')}>Re-register</button>
        </SettingsRow>
      )}
      {status.daemonAlive && (
        <SettingsRow
          title={`Daemon running — server ${status.child ? status.child.state : 'unknown'}`}
          hint={status.child
            ? `Uptime ${status.child.uptimeSec}s, ${status.child.restartCount} restarts${status.child.lastError ? `, last error: ${status.child.lastError}` : ''}. Stopping here exits the supervised server; the daemon stays alive.`
            : 'Stopping here exits the supervised server; the daemon stays alive.'}
        >
          <button type="button" className="btn" disabled={busy} onClick={() => void act('/daemon/stop')}>
            Stop now
          </button>
        </SettingsRow>
      )}
      {!status.daemonAlive && status.osRegistered && (
        <SettingsRow
          title="Daemon not running"
          hint="Auto-start is registered but the daemon is not running right now."
        >
          <button type="button" className="btn" disabled={busy} onClick={() => void act('/daemon/start')}>
            Start now
          </button>
        </SettingsRow>
      )}
      {error && <p role="alert" className="settings-row-hint" style={{ color: 'var(--msg-error-fg)' }}>{error}</p>}
    </section>
  )
}
