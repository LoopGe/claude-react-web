import { useId, useState } from 'react'
import { api } from '../hooks/useApi'
import { useProfiles } from '../hooks/useProfiles'
import { apiErrorToastOpts, useToast } from '../hooks/useToast'
import { SettingsRow } from './SettingsRow'
import type { SessionInfo } from '../types'

export function SessionProfileSelect({
  session,
  onSessionUpdate,
}: {
  session: SessionInfo
  onSessionUpdate: (s: SessionInfo) => void
}) {
  const { profiles, activeProfileId } = useProfiles()
  const [value, setValue] = useState(session.profileId ?? '')
  // True while a switch POST is in flight — 'now' drives a server-side
  // respawn, so the call can take seconds. The select and both actions
  // disable meanwhile: a second click would queue another full restart, and
  // a mid-flight re-selection would be silently reverted by the resolve's
  // setValue(profileId).
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const uid = useId()

  const choose = async (profileId: string, mode: 'now' | 'deferred') => {
    setBusy(true)
    try {
      const res = await api.post<{ session?: SessionInfo }>(`/sessions/${session.id}/profile`, {
        profileId, apply: mode,
      })
      setValue(profileId)
      if (res.session) onSessionUpdate(res.session)
    } catch (e) {
      // Surface the failure — a swallowed rejection here reads as a dead
      // button (the server's 502 means the pin/restart did NOT apply).
      toast.error(`Couldn't switch profile: ${(e as Error).message}`, apiErrorToastOpts(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsRow
      stack
      title={<label htmlFor={uid}>Profile</label>}
      hint="Credentials and model set for this session."
    >
      <select
        id={uid}
        className="select"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={profiles.length === 0 || busy}
      >
        <option value="">Follow global ({profiles.find((p) => p.id === activeProfileId)?.name ?? activeProfileId})</option>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      {value && value !== session.profileId && (
        <div className="session-profile-select__actions">
          <button type="button" className="btn btn-xs" disabled={busy} onClick={() => void choose(value, 'now')}>Restart now</button>
          <button type="button" className="btn btn-xs" disabled={busy} onClick={() => void choose(value, 'deferred')}>Apply next restart</button>
        </div>
      )}
    </SettingsRow>
  )
}
