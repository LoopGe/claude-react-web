import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Overlay } from './Overlay'
import { useListSelection } from '../hooks/useListSelection'
import { useSessionSearch } from '../hooks/useSessionSearch'
import type { SessionSearchHit, SessionSearchRole } from '../../shared/session-search'

interface Props {
  open: boolean
  sessionId: string
  initialQuery?: string
  onClose: () => void
  onSelect: (hit: SessionSearchHit) => void
}

function roleLabel(role: SessionSearchRole): string {
  return role === 'user' ? '你' : role === 'tool_result' ? '工具' : 'Claude'
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

function GroupHeader({ turnNo, turnPrompt }: { turnNo: number; turnPrompt: string }) {
  return (
    <div className="session-search-group-head">
      <span className="session-search-turn-no">第 {turnNo} 轮</span>
      <span className="session-search-turn-prompt">{turnPrompt}</span>
    </div>
  )
}

/**
 * Full-history session search dialog (variant A). The dialog only finds:
 * selecting a hit calls `onSelect`, and the parent closes it and anchors the
 * transcript. Grouping is by the server's turn fields, so it works for
 * messages that are not loaded in the client store.
 */
export function SessionSearchDialog({ open, sessionId, initialQuery, onClose, onSelect }: Props) {
  const [query, setQuery] = useState(initialQuery ?? '')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const search = useSessionSearch(sessionId, query, { enabled: open })

  // Seed from the caller each time the dialog opens (a palette jump or a
  // context-menu selection can carry a different query).
  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- opening the dialog seeds its query from the caller
    setQuery(initialQuery ?? '')
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [open, initialQuery])

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

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
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
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  return (
    <Overlay
      open={open}
      onClose={onClose}
      variant="search"
      ariaLabel="搜索会话历史"
      trapFocus
      restoreFocus
      onKeyDown={handleKeyDown}
    >
      <div className="session-search-head">
        <div className="session-search-row-top">
          <span className="session-search-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </span>
          <input
            ref={inputRef}
            className="session-search-input"
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              reset()
            }}
            placeholder="搜索这个会话的历史…"
            aria-label="搜索会话历史"
            aria-controls="session-search-list"
            aria-activedescendant={search.hits.length > 0 ? `session-search-hit-${activeIndex}` : undefined}
          />
          <span className="session-search-scope">当前会话 · 完整历史</span>
        </div>
        <div className="session-search-meta">
          {showLoading ? (
            <span className="session-search-spinner" aria-hidden="true" />
          ) : (
            <span>
              <b>{search.totalHits}</b> 条结果
              {search.truncated ? ' · 仅显示前 100 条' : ''}
            </span>
          )}
          <span className="session-search-meta-spacer" />
          <span className="session-search-keys">
            <span className="session-search-key">↑</span>
            <span className="session-search-key">↓</span> 选择 · <span className="session-search-key">↵</span> 跳转 · <span className="session-search-key">Esc</span> 关闭
          </span>
        </div>
      </div>

      <div className="session-search-list" ref={listRef} id="session-search-list" role="listbox" aria-label="搜索结果">
        {!trimmed ? (
          <div className="session-search-empty">
            <b>搜索完整历史</b>
            输入关键词，查找已加载和未加载的消息。
          </div>
        ) : showLoading ? (
          <div className="session-search-empty">
            <span className="session-search-loading">
              <span className="session-search-spinner" aria-hidden="true" />
              搜索中…
            </span>
          </div>
        ) : showError ? (
          <div className="session-search-empty">
            <b>搜索失败</b>
            <button type="button" className="session-search-retry" onClick={search.retry}>重试</button>
          </div>
        ) : showDegraded ? (
          <div className="session-search-empty">这段会话的历史暂时无法读取</div>
        ) : showEmpty ? (
          <div className="session-search-empty">没有找到匹配</div>
        ) : (
          groups.map((group) => (
            <div className="session-search-group" key={group.turnNo}>
              <GroupHeader turnNo={group.turnNo} turnPrompt={group.turnPrompt} />
              {group.rows.map(({ hit, index }) => (
                <button
                  type="button"
                  key={`${hit.messageSeq}-${hit.turnNo}-${index}`}
                  id={`session-search-hit-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  data-search-hit
                  className={`session-search-hit${index === activeIndex ? ' active' : ''}`}
                  onMouseEnter={() => hover(index)}
                  onClick={() => onSelect(hit)}
                >
                  <span className={`session-search-role ${hit.role}`}>{roleLabel(hit.role)}</span>
                  <span className="session-search-snippet">{highlight(hit.snippet, query)}</span>
                  <span className="session-search-time">{formatTime(hit.timestamp)}</span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>

      <div className="session-search-foot">
        搜索范围：当前会话 · 完整历史
      </div>
    </Overlay>
  )
}