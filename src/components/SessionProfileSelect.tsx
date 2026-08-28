import { useState } from 'react'
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

  const choose = async (profileId: string, mode: 'now' | 'deferred') => {
    const res = await api.post<{ session?: SessionInfo }>(`/sessions/${session.id}/profile`, {
      profileId, apply: mode,
    })
    setValue(profileId)
    if (res.session) onSessionUpdate(res.session)
  }

  return (
    <div className="session-profile-select">
      <label>
        Profile
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={profiles.length === 0}
        >
          <option value="">Follow global ({activeProfileId})</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>
      {value && value !== session.profileId && (
        <div className="session-profile-select__actions">
          <button type="button" onClick={() => void choose(value, 'now')}>Restart now</button>
          <button type="button" onClick={() => void choose(value, 'deferred')}>Apply next restart</button>
        </div>
      )}
    </div>
  )
}
