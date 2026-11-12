import { useEffect, useRef, useState } from 'react'
import { useProfiles } from '../hooks/useProfiles'
import { useFloatingSurface, FloatingSurfaceProvider } from '../hooks/useFloatingSurface'
import { useOutsideMouseDown } from '../hooks/useOutsideMouseDown'
import type { FloatingDismissReason } from '../hooks/floating-surface-registry'
import { api } from '../hooks/useApi'
import { ProfileActivateDialog } from './ProfileActivateDialog'
import { HoverHint } from './HoverHint'
import { IconChevronDown, IconChevronUp } from './icons/ToolIcons'
import { useToast } from '../hooks/useToast'
import type { SessionInfo } from '../types'
import type { ProviderProfile } from '../types/config'
import { formatError } from '../utils/format-error'

/** State for the "restart sessions on switch" dialog: the profile being
 *  activated and the idle follow-global sessions available to restart. */
interface PendingSwitch {
  profile: ProviderProfile
  sessions: SessionInfo[]
}

export function ProfileSwitcher({ onManageProfiles }: { onManageProfiles?: () => void }) {
  const { profiles, activeProfileId, activate } = useProfiles()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<PendingSwitch | null>(null)
  const [busy, setBusy] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const selectionGenerationRef = useRef(0)
  const restoreTriggerFocusRef = useRef(false)
  const closeMenu = (reason?: FloatingDismissReason, restoreTriggerFocus = false) => {
    selectionGenerationRef.current++
    setOpen(false)
    const active = document.activeElement
    const inMenuFlow = triggerRef.current?.contains(active) || menuRef.current?.contains(active)
    if (restoreTriggerFocus) restoreTriggerFocusRef.current = true
    else if (!reason && inMenuFlow) triggerRef.current?.focus({ preventScroll: true })
  }
  useEffect(() => {
    if (open || pending || !restoreTriggerFocusRef.current) return
    restoreTriggerFocusRef.current = false
    triggerRef.current?.focus({ preventScroll: true })
  }, [open, pending])
  const { surfaceId } = useFloatingSurface({
    kind: 'menu',
    active: open,
    phase: 'open',
    getContainer: () => menuRef.current,
    getTrigger: () => triggerRef.current,
    onDismiss: closeMenu,
    onEscape: () => closeMenu(),
  })
  useOutsideMouseDown({ ref: menuRef, onClose: closeMenu, triggerRef, surfaceId, active: open })
  const active = profiles.find((p) => p.id === activeProfileId) ?? profiles[0]

  // (The hook itself re-fetches on `crw-profiles-changed`, so mutations that
  // originate elsewhere — Settings → Profiles edit — keep this list live.)

  const handleSelect = async (profile: ProviderProfile) => {
    if (busy) return
    if (profile.isActive) {
      closeMenu()
      return
    }
    const generation = ++selectionGenerationRef.current
    // Collect live sessions that follow the global profile. Only these would
    // actually change on a switch (pinned sessions keep their pin), and only
    // idle ones can restart in place — a working session defers a restart.
    let candidates: SessionInfo[] = []
    try {
      const { sessions } = await api.get<{ sessions: SessionInfo[] }>('/sessions')
      if (generation !== selectionGenerationRef.current) return
      candidates = (sessions ?? []).filter((s) => s.running && s.phase === 'idle' && !s.profileId)
    } catch (e) {
      if (generation === selectionGenerationRef.current) toast.error(`Couldn't load sessions: ${formatError(e)}`)
      return
    }
    if (generation !== selectionGenerationRef.current) return
    if (candidates.length === 0) {
      setBusy(true)
      try {
        await activate(profile.id)
        if (generation === selectionGenerationRef.current) closeMenu()
      } catch (e) {
        toast.error(`Couldn't switch profile: ${formatError(e)}`)
      } finally {
        setBusy(false)
      }
      return
    }
    if (generation === selectionGenerationRef.current) setPending({ profile, sessions: candidates })
  }

  const confirmSwitch = async (ids: string[]) => {
    if (!pending) return
    setBusy(true)
    try {
      const res = await activate(pending.profile.id, ids)
      if (res?.skipped && res.skipped.length > 0) {
        toast.info(`${res.skipped.length} busy session${res.skipped.length === 1 ? '' : 's'} will switch on their next restart`)
      }
      closeMenu(undefined, true)
      setPending(null)
    } catch (e) {
      toast.error(`Couldn't switch profile: ${formatError(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="profile-switcher">
      <HoverHint label={active ? `Profile: ${active.name}` : 'No profile'} side="bottom" align="start">
        <button
          ref={triggerRef}
          type="button"
          className="profile-switcher__trigger"
          onClick={() => (open ? closeMenu() : setOpen(true))}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <span className="profile-switcher__dot" aria-hidden />
          <span className="profile-switcher__name">{active?.name ?? 'Default'}</span>
          <span className="profile-switcher__chevron" aria-hidden>
            {open ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
          </span>
        </button>
      </HoverHint>
      {open && (
        <FloatingSurfaceProvider surfaceId={surfaceId}>
          <div ref={menuRef} className="profile-switcher__menu" role="menu">
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitemradio"
              aria-checked={p.id === activeProfileId}
              className="profile-switcher__item"
              disabled={busy}
              onClick={() => { void handleSelect(p) }}
            >
              <span className="profile-switcher__item-name truncate">{p.name}</span>
              {p.id === activeProfileId && <span className="profile-switcher__check" aria-hidden>{'✓'}</span>}
            </button>
          ))}
          {profiles.length > 0 && (
            <div className="profile-switcher__separator" />
          )}
          <button
            type="button"
            role="menuitem"
            className="profile-switcher__item"
            onClick={() => { closeMenu(); onManageProfiles?.() }}
          >
            <span className="profile-switcher__item-name truncate">Manage profiles…</span>
          </button>
          {profiles.length === 0 && <div className="profile-switcher__empty">No profiles</div>}
          </div>
        </FloatingSurfaceProvider>
      )}
      {pending && (
        <ProfileActivateDialog
          surfaceParentId={surfaceId}
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
