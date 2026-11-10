import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { IconSearch, IconX } from './icons/ToolIcons'
import { useListSelection } from '../hooks/useListSelection'
import { useSessionSearch } from '../hooks/useSessionSearch'
import type { SessionSearchHit, SessionSearchRole } from '../../shared/session-search'

interface Props {
  sessionId: string
  initialQuery?: string
  onClose: () => void
  onSelect: (hit: SessionSearchHit) => void
}

function roleLabel(role: SessionSearchRole): string {
  return role === 'user' ? 'You' : role === 'tool_result' ? 'Tool' : 'Claude'
}

function formatTime(timestamp?: number): string {
  if (timestamp == null) return ''
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Wrap every case-insensitive occurrence of `query` in a themed <mark>. */
function highlight(text: string, query: string): ReactNode {
  const q = query.trim()
  if (!q) return text
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  const out: ReactNode[] = []
  let i = 0
  let key = 0
  for (;;) {
    const j = lower.indexOf(needle, i)
    if (j < 0) {
      out.push(text.slice(i))
      break
    }
    out.push(text.slice(i, j))
    out.push(<mark key={key++} className="search-hl">{text.slice(j, j + q.length)}</mark>)
    i = j + q.length
  }
  return out
}

/**
 * Session-level full-history search panel. Rendered inside <Chat> through the
 * same body-only Overlay used by GitPanel/TasksPanel. The panel only finds:
 * selecting a hit calls `onSelect`, and the session closes the overlay and
 * anchors the transcript at the hit.
 */
export function SessionSearchPanel({ sessionId, initialQuery, onClose, onSelect }: Props) {
  const [query, setQuery] = useState(initialQuery ?? '')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const search = useSessionSearch(sessionId, query)

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  const { activeIndex, hover, move, reset } = useListSelection({
    count: search.hits.length,
    getRow: (i) => listRef.current?.querySelectorAll<HTMLElement>('[data-search-hit]')[i],
    wrap: true,
  })

  const groups = useMemo(() => {
    const out: Array<{ turnNo: number; turnPrompt: string; rows: Array<{ hit: SessionSearchHit; index: number }> }> = []
    search.hits.forEach((hit, index) => {
      let group = out[out.length - 1]
      if (!group || group.turnNo !== hit.turnNo) {
        group = { turnNo: hit.turnNo, turnPrompt: hit.turnPrompt, rows: [] }
        out.push(group)
      }
      group.rows.push({ hit, index })
    })
    return out
  }, [search.hits])

  const trimmed = query.trim()
  const showLoading = !!trimmed && search.loading
  const showError = !!trimmed && !search.loading && search.error
  const showDegraded = !!trimmed && !search.loading && !search.error && search.indexStatus === 'degraded'
  const showEmpty = !!trimmed && !search.loading && !search.error && !showDegraded && search.hits.length === 0

  const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = search.hits[activeIndex]
      if (hit) onSelect(hit)
    }
  }

  return (
    <aside className="search-panel" role="region" aria-label="Search session history" onKeyDown={handleKeyDown}>
      <header className="search-panel-header">
        <span className="search-panel-title">Search</span>
        <span className="search-panel-meta">
          {showLoading ? (
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

      <div className="search-panel-input-row">
        <span className="search-panel-icon" aria-hidden="true">
          <IconSearch size={15} />
        </span>
        <input
          ref={inputRef}
          className="search-panel-input"
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            reset()
          }}
          placeholder="Search this session's history…"
          aria-label="Search session history"
          aria-controls="session-search-list"
          aria-activedescendant={search.hits.length > 0 ? `session-search-hit-${activeIndex}` : undefined}
        />
        <span className="search-panel-scope">This session · Full history</span>
      </div>

      <div className="search-panel-list" ref={listRef} id="session-search-list" role="listbox" aria-label="Search results">
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
                  onClick={() => onSelect(hit)}
                >
                  <span className={`search-panel-role ${hit.role}`}>{roleLabel(hit.role)}</span>
                  <span className="search-panel-snippet">{highlight(hit.snippet, query)}</span>
                  <span className="search-panel-time">{formatTime(hit.timestamp)}</span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>

      <footer className="search-panel-footer">
        <span className="search-panel-key">↑</span>
        <span className="search-panel-key">↓</span> select · <span className="search-panel-key">↵</span> jump · <span className="search-panel-key">Esc</span> close
      </footer>
    </aside>
  )
}