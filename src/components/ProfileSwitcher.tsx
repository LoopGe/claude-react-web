import { useEffect, useState } from 'react'
import { useProfiles } from '../hooks/useProfiles'
import { api } from '../hooks/useApi'
import { onProfilesChanged } from '../utils/profiles-events'
import { ProfileActivateDialog } from './ProfileActivateDialog'
import { IconChevronDown, IconChevronUp } from './icons/ToolIcons'
import { useToast } from '../hooks/useToast'
import type { SessionInfo } from '../types'
import type { ProviderProfile } from '../types/config'

/** State for the "restart sessions on switch" dialog: the profile being
 *  activated and the idle follow-global sessions available to restart. */
interface PendingSwitch {
  profile: ProviderProfile
  sessions: SessionInfo[]
}

export function ProfileSwitcher({ onManageProfiles }: { onManageProfiles?: () => void }) {
  const { profiles, activeProfileId, refresh, activate } = useProfiles()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<PendingSwitch | null>(null)
  const [busy, setBusy] = useState(false)
  const active = profiles.find((p) => p.id === activeProfileId) ?? profiles[0]

  // Profile mutations can originate elsewhere (Settings → Profiles edit).
  // useProfiles only refetches after ITS OWN mutations, so subscribe to the
  // `crw-profiles-changed` window event (mirroring useModelOptions) to keep
  // the switcher's list live without a page refresh.
  useEffect(() => onProfilesChanged(() => void refresh()), [refresh])

  const handleSelect = async (profile: ProviderProfile) => {
    if (profile.isActive) {
      setOpen(false)
      return
    }
    // Collect live sessions that follow the global profile. Only these would
    // actually change on a switch (pinned sessions keep their pin), and only
    // idle ones can restart in place — a working session defers a restart.
    let candidates: SessionInfo[] = []
    try {
      const { sessions } = await api.get<{ sessions: SessionInfo[] }>('/sessions')
      candidates = (sessions ?? []).filter((s) => s.running && s.phase === 'idle' && !s.profileId)
    } catch {
      candidates = []
    }
    if (candidates.length === 0) {
      try {
        await activate(profile.id)
        setOpen(false)
      } catch (e) {
        toast.error(`Couldn't switch profile: ${e instanceof Error ? e.message : String(e)}`)
      }
      return
    }
    setPending({ profile, sessions: candidates })
  }

  const confirmSwitch = async (ids: string[]) => {
    if (!pending) return
    setBusy(true)
    try {
      const res = await activate(pending.profile.id, ids)
      if (res?.skipped && res.skipped.length > 0) {
        toast.info(`${res.skipped.length} busy session${res.skipped.length === 1 ? '' : 's'} will switch on their next restart`)
      }
      setOpen(false)
      setPending(null)
    } catch (e) {
      toast.error(`Couldn't switch profile: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="profile-switcher">
      <button
        type="button"
        className="profile-switcher__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={active ? `Profile: ${active.name}` : 'No profile'}
      >
        <span className="profile-switcher__dot" aria-hidden />
        <span className="profile-switcher__name">{active?.name ?? 'Default'}</span>
        <span className="profile-switcher__chevron" aria-hidden>
          {open ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
        </span>
      </button>
      {open && (
        <div className="profile-switcher__menu" role="menu">
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitemradio"
              aria-checked={p.id === activeProfileId}
              className="profile-switcher__item"
              onClick={() => { void handleSelect(p) }}
            >
              <span className="profile-switcher__item-name">{p.name}</span>
              {p.id === activeProfileId && <span className="profile-switcher__check" aria-hidden>{'✓'}</span>}
            </button>
          ))}
          {profiles.length > 0 && (
            <div className="profile-switcher__separator" />
          )}
          <button
            type="button"
            role="menuitem"
            className="profile-switcher__item profile-switcher__manage"
            onClick={() => { setOpen(false); onManageProfiles?.() }}
          >
            <span className="profile-switcher__item-name">Manage profiles…</span>
          </button>
          {profiles.length === 0 && <div className="profile-switcher__empty">No profiles</div>}
        </div>
      )}
      {pending && (
        <ProfileActivateDialog
          profileName={pending.profile.name}
          sessions={pending.sessions}
          busy={busy}
          onConfirm={(ids) => void confirmSwitch(ids)}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  )
}
