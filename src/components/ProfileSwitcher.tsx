import { useState } from 'react'
import { useProfiles } from '../hooks/useProfiles'
import { IconChevronDown, IconChevronUp } from './icons/ToolIcons'

export function ProfileSwitcher({ onManageProfiles }: { onManageProfiles?: () => void }) {
  const { profiles, activeProfileId, activate } = useProfiles()
  const [open, setOpen] = useState(false)
  const active = profiles.find((p) => p.id === activeProfileId) ?? profiles[0]

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
              onClick={() => { void activate(p.id).then(() => setOpen(false)) }}
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
    </div>
  )
}
