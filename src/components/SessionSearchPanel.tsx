import { useEffect, useMemo, useRef, useState } from 'react'
import { IconX } from './icons/ToolIcons'
import { SearchField } from './SearchField'
import { SessionSearchPreview } from './SessionSearchPreview'
import { useListSelection } from '../hooks/useListSelection'
import { useSessionSearch } from '../hooks/useSessionSearch'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import { useMergedRef } from '../utils/mergedRef'
import type { MessagePreviewTarget } from '../hooks/useMessagePreview'
import { renderMatchMarks } from '../utils/highlight-matches'
import type { SessionSearchHit, SessionSearchRole } from '../../shared/session-search'

interface Props {
  sessionId: string
  initialQuery?: string
  /** CommandPalette entry: open straight into this message's preview. */
  initialTarget?: MessagePreviewTarget
  /** Transcript display prefs, resolved by Chat. */
  toolGroupCards?: boolean
  showMessageHeaders?: boolean
  autoExpandRunningGroups?: boolean
  /** Session cwd for resource/file links in the preview. */
  cwd?: string
  onClose: () => void
}

function roleLabel(role: SessionSearchRole): string {
  return role === 'user' ? 'You' : role === 'tool_result' ? 'Tool' : 'Claude'
}

function formatTime(timestamp?: number): string {
  if (timestamp == null) return ''
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}


/**
 * Session-level full-history search panel. Rendered inside <Chat> through the
 * same body-only Overlay used by GitPanel/TasksPanel. Selecting a hit drills
 * into a read-only preview inside this panel; the live transcript is never
 * re-anchored or moved.
 */
export function SessionSearchPanel({
  sessionId,
  initialQuery,
  initialTarget,
  toolGroupCards,
  showMessageHeaders,
  autoExpandRunningGroups,
  cwd,
  onClose,
}: Props) {
  const [query, setQuery] = useState(initialTarget?.query ?? initialQuery ?? '')
  const [preview, setPreview] = useState<MessagePreviewTarget | null>(initialTarget ?? null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const setListOs = useOverlayScrollbar({ autoHide: 'leave' })
  const listRefMerged = useMergedRef(listRef, setListOs)
  const search = useSessionSearch(sessionId, query, { enabled: !initialTarget || !preview })

  const trimmed = query.trim()
  // While the input is ahead of the debounced result, the previous hits are
  // not actionable: hide them instead of letting Enter open a message with a
  // query that does not match it.
  const stale = !preview && trimmed !== search.query
  const hits = useMemo(() => (stale ? [] : search.hits), [stale, search.hits])
  const { activeIndex, hover, reset, handleKeyDown } = useListSelection({
    count: hits.length,
    getRow: (i) => listRef.current?.querySelectorAll<HTMLElement>('[data-search-hit]')[i],
    wrap: true,
    onActivate: (i) => {
      const hit = hits[i]
      if (hit) setPreview({ kind: 'hit', hit, query: search.query })
    },
  })

  // Focus the input whenever the results view is showing (initial mount and
  // returning from a preview).
  useEffect(() => {
    if (preview) return
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
      // Returning from a preview remounts the results list; restore the active
      // row's visibility instead of leaving it selected offscreen.
      const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-search-hit]')
      rows?.[activeIndex]?.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
    // Only re-run on a view switch. activeIndex is intentionally read at that
    // moment: re-focusing on every hover would violate useListSelection's
    // no-scroll-on-hover contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview])

  const groups = useMemo(() => {
    const out: Array<{ turnNo: number; turnPrompt: string; rows: Array<{ hit: SessionSearchHit; index: number }> }> = []
    hits.forEach((hit, index) => {
      let group = out[out.length - 1]
      if (!group || group.turnNo !== hit.turnNo) {
        group = { turnNo: hit.turnNo, turnPrompt: hit.turnPrompt, rows: [] }
        out.push(group)
      }
      group.rows.push({ hit, index })
    })
    return out
  }, [hits])

  const showLoading = !!trimmed && (search.loading || stale)
  const showError = !!trimmed && !stale && !search.loading && search.error
  const showDegraded = !!trimmed && !stale && !search.loading && !search.error && search.indexStatus === 'degraded'
  const showEmpty = !!trimmed && !stale && !search.loading && !search.error && !showDegraded && hits.length === 0

  return (
    <aside
      className={`search-panel${preview ? ' has-preview' : ''}`}
      role="region"
      aria-label="Search session history"
      onKeyDown={preview ? undefined : handleKeyDown}
    >
      <header className="search-panel-header">
        <span className="search-panel-title">Search</span>
        <span className="search-panel-meta">
          {preview ? (
            <span>Preview</span>
          ) : showLoading ? (
            <span className="search-panel-spinner" aria-hidden="true" />
          ) : (
            <span>
              <b>{search.totalHits}</b> results
              {search.truncated ? ' · Showing the first 100' : ''}
            </span>
          )}
        </span>
        <span className="search-panel-spacer" />
        <button type="button" className="search-panel-icon-btn" onClick={onClose} aria-label="Close">
          <IconX size={14} />
        </button>
      </header>

      {preview ? (
        <SessionSearchPreview
          sessionId={sessionId}
          target={preview}
          toolGroupCards={toolGroupCards}
          showMessageHeaders={showMessageHeaders}
          autoExpandRunningGroups={autoExpandRunningGroups}
          cwd={cwd}
          onBack={() => setPreview(null)}
        />
      ) : (
        <>
          <SearchField
            value={query}
            onChange={(value) => {
              setQuery(value)
              reset()
            }}
            placeholder="Search this session's history…"
            ariaLabel="Search session history"
            wrapperClassName="search-panel-input-row"
            inputClassName="search-panel-input"
            inputRef={inputRef}
            iconSize={15}
            showClear={false}
            ariaControls="session-search-list"
            ariaActiveDescendant={hits.length > 0 ? `session-search-hit-${activeIndex}` : undefined}
          />

          <div className="search-panel-list" ref={listRefMerged} id="session-search-list" role="listbox" aria-label="Search results">
            {!trimmed ? (
              <div className="search-panel-empty">
                <b>Search full history</b>
                Enter a query to search loaded and unloaded messages.
              </div>
            ) : showLoading ? (
              <div className="search-panel-empty">
                <span className="search-panel-loading">
                  <span className="search-panel-spinner" aria-hidden="true" />
                  Searching…
                </span>
              </div>
            ) : showError ? (
              <div className="search-panel-empty">
                <b>Search failed</b>
                <button type="button" className="search-panel-retry" onClick={search.retry}>Retry</button>
              </div>
            ) : showDegraded ? (
              <div className="search-panel-empty">This session's history is temporarily unavailable</div>
            ) : showEmpty ? (
              <div className="search-panel-empty">No matches</div>
            ) : (
              groups.map((group) => (
                <div className="search-panel-group" key={group.turnNo}>
                  <div className="search-panel-group-head">
                    <span className="search-panel-turn-no">Turn {group.turnNo}</span>
                    <span className="search-panel-turn-prompt">{group.turnPrompt}</span>
                  </div>
                  {group.rows.map(({ hit, index }) => (
                    <button
                      type="button"
                      key={`${hit.messageSeq}-${hit.turnNo}-${index}`}
                      id={`session-search-hit-${index}`}
                      role="option"
                      aria-selected={index === activeIndex}
                      data-search-hit
                      className={`search-panel-hit${index === activeIndex ? ' active' : ''}`}
                      onMouseEnter={() => hover(index)}
                      onClick={() => setPreview({ kind: 'hit', hit, query: search.query })}
                    >
                      <span className={`search-panel-role ${hit.role}`}>{roleLabel(hit.role)}</span>
                      <span className="search-panel-snippet">{renderMatchMarks(hit.snippet, search.query)}</span>
                      <span className="search-panel-time">{formatTime(hit.timestamp)}</span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>

          <footer className="search-panel-footer">
            <span className="search-panel-key">↑</span>
            <span className="search-panel-key">↓</span> select · <span className="search-panel-key">↵</span> preview · <span className="search-panel-key">Esc</span> close
          </footer>
        </>
      )}
    </aside>
  )
}