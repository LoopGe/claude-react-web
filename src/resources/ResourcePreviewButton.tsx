// Header affordance for the resource preview (replaces the old right-edge
// reopen pill): shows the FOCUSED panel's open-resource count and toggles that
// session's modal. Rendered in the app header next to "Uploaded files".

import { useCallback, useSyncExternalStore } from 'react'
import { IconEye } from '../components/icons/ToolIcons'
import { useResourcePaneStore } from './context'
import type { ResourcePaneState } from './tab-store'

const EMPTY_STATE: ResourcePaneState = { tabs: [], activeTabId: null, expanded: false }

export function ResourcePreviewButton({ sessionId }: { sessionId: string | null }) {
  const store = useResourcePaneStore()
  const getSnapshot = useCallback(
    () => (sessionId ? store.getState(sessionId) : EMPTY_STATE),
    [store, sessionId],
  )
  const state = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
  if (!sessionId) return null

  const tabs = state.tabs.length
  const expanded = state.expanded
  const label = expanded ? 'Hide resource preview' : 'Show resource preview'
  return (
    <button
      type="button"
      className={`btn btn-icon resource-preview-btn${expanded ? ' active' : ''}`}
      title={tabs === 0 ? 'No resource previews open in this panel' : label}
      aria-label={tabs > 0 ? `${label} (${tabs} open)` : label}
      aria-pressed={expanded}
      onClick={() => {
        // No tabs yet → nothing to show; the button stays enabled so it reads
        // as a normal toolbar control instead of a greyed-out one.
        if (tabs > 0) store.setExpanded(sessionId, !expanded)
      }}
    >
      <IconEye size={16} />
      {tabs > 0 && (
        <span className="resource-preview-count" aria-hidden>
          {tabs}
        </span>
      )}
    </button>
  )
}