import { useId, useState } from 'react'
import { api } from '../hooks/useApi'
import { useProfiles } from '../hooks/useProfiles'
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
  const uid = useId()

  const choose = async (profileId: string, mode: 'now' | 'deferred') => {
    const res = await api.post<{ session?: SessionInfo }>(`/sessions/${session.id}/profile`, {
      profileId, apply: mode,
    })
    setValue(profileId)
    if (res.session) onSessionUpdate(res.session)
  }

  return (
    <div className="settings-field">
      <label htmlFor={uid}>Profile</label>
      <select
        id={uid}
        className="select"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={profiles.length === 0}
      >
        <option value="">Follow global ({profiles.find((p) => p.id === activeProfileId)?.name ?? activeProfileId})</option>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <span className="hint">Credentials and model set for this session.</span>
      {value && value !== session.profileId && (
        <div className="session-profile-select__actions">
          <button type="button" className="btn btn-xs" onClick={() => void choose(value, 'now')}>Restart now</button>
          <button type="button" className="btn btn-xs" onClick={() => void choose(value, 'deferred')}>Apply next restart</button>
        </div>
      )}
    </div>
  )
}
