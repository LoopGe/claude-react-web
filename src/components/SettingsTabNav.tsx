import { memo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

export interface SettingsNavLeaf<K extends string> {
  key: K
  label: ReactNode
}

export interface SettingsNavGroup<K extends string> {
  /** Group key is an opaque pill identity (plain string) — selection is
   *  always a leaf key, so groups don't share the leaf key type. */
  key: string
  label: ReactNode
  tabs: SettingsNavLeaf<K>[]
}

interface SettingsTabNavProps<K extends string> {
  groups: SettingsNavGroup<K>[]
  /** The active leaf key (NOT the group key). */
  active: K
  onSelect: (leaf: K) => void
}

/**
 * Two-level settings navigation: a row of group pills over a row of leaf
 * tabs. Both SettingsPanel (session settings) and GlobalSettingsModal use
 * it; the tab STATE stays a flat leaf key in each owner — the grouping is
 * purely presentational, so deep links (e.g. the `/mcp` tabRequest) keep
 * working by deriving the active group from the active leaf.
 *
 * Clicking a group lands on the leaf last visited in that group, falling
 * back to the group's first leaf. How long that memory lasts follows each
 * host's mount lifecycle: the session SettingsPanel stays mounted across
 * opens (Chat.tsx keepMounted), so there the memory spans opens; the global
 * modal unmounts on close and intentionally starts fresh each time.
 *
 * memo'd: hosts pass a module-stable groups array plus a useCallback'd
 * switchTab, so unrelated parent re-renders (e.g. WS session updates while
 * the panel is open) don't re-diff the two button rows.
 */
function SettingsTabNavInner<K extends string>({ groups, active, onSelect }: SettingsTabNavProps<K>) {
  const populated = groups.filter((g) => g.tabs.length > 0)
  const activeGroup = populated.find((g) => g.tabs.some((t) => t.key === active)) ?? populated[0]!

  const [lastVisited, setLastVisited] = useState<Partial<Record<string, K>>>({})
  // Render-phase state adjustment (react.dev: "adjusting state when a prop
  // changes") rather than an effect — recording the active leaf for its group
  // must cover EVERY path that changes `active`, including deep links (e.g.
  // the `/mcp` tabRequest) that never pass through onSelect. React discards
  // the in-progress render and re-renders with the updated record.
  if (lastVisited[activeGroup.key] !== active) {
    setLastVisited((v) => ({ ...v, [activeGroup.key]: active }))
  }

  return (
    <div className="global-settings-tabs settings-tabs-grouped">
      <div className="settings-tab-groups" role="group" aria-label="Settings sections">
        {populated.map((g) => (
          <button
            key={g.key}
            aria-pressed={g.key === activeGroup.key}
            className={`settings-tab-group${g.key === activeGroup.key ? ' active' : ''}`}
            onClick={() => onSelect(lastVisited[g.key] ?? g.tabs[0]!.key)}
          >
            {g.label}
          </button>
        ))}
      </div>
      <div className="settings-tab-leaves" role="group" aria-label={`${activeGroup.label} tabs`}>
        {activeGroup.tabs.map((t) => (
          <button
            key={t.key}
            aria-current={t.key === active ? 'true' : undefined}
            className={`global-settings-tab${t.key === active ? ' active' : ''}`}
            onClick={() => onSelect(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// memo drops the generic parameter; restate it for callers.
export const SettingsTabNav = memo(SettingsTabNavInner) as <K extends string>(
  props: SettingsTabNavProps<K>,
) => ReactElement
