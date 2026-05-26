// Marketplace tab inside GlobalSettingsModal.
//
// Lists registered marketplaces, lets the user add new ones via https git
// URL, refresh, remove, and toggle individual plugins on/off. Mirrors the
// design language of McpTab (the closest existing pattern): row-per-entry
// with inline action buttons, two-click confirm for destructive operations,
// and lazy-loaded detail (plugin list per marketplace).

import { useCallback, useEffect, useState } from 'react'
import { api } from '../hooks/useApi'
import type { MpListItem, MpPluginInfo, MpParseWarning } from '../types'

type AddState =
  | { phase: 'idle' }
  | { phase: 'busy' }

interface AddResponse {
  ok: true
  entry: MpListItem
  warnings: MpParseWarning[]
}

interface RefreshResponse {
  ok: true
  entry: MpListItem
  updated: boolean
  warnings: MpParseWarning[]
}

export function MarketplaceTab() {
  const [items, setItems] = useState<MpListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [warningsById, setWarningsById] = useState<Record<string, MpParseWarning[]>>({})
  // Lazily-loaded plugin lists, keyed by marketplace id. `undefined` means
  // not fetched yet; `[]` means fetched and empty.
  const [plugins, setPlugins] = useState<Record<string, MpPluginInfo[]>>({})
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)

  // Add form
  const [newUrl, setNewUrl] = useState('')
  const [newRef, setNewRef] = useState('')
  const [addState, setAddState] = useState<AddState>({ phase: 'idle' })

  // Fetch helper that doesn't touch React state directly. Used both by
  // the initial-load effect (where setState within the effect body is
  // forbidden by react-hooks/set-state-in-effect) and by the post-mutation
  // refetch path. Returns null on abort so callers can ignore that case
  // without a try/catch dance.
  const fetchList = useCallback(async (signal?: AbortSignal): Promise<MpListItem[] | null> => {
    try {
      const r = await api.get<{ marketplaces: MpListItem[] }>('/mp/marketplaces', { signal })
      return r.marketplaces
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null
      throw e
    }
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    // Wrap in an async IIFE so setState calls happen in the resolved
    // promise's callback — outside the synchronous effect body — which
    // satisfies react-hooks/set-state-in-effect.
    ;(async () => {
      try {
        const items = await fetchList(ac.signal)
        if (items) setItems(items)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    })()
    return () => ac.abort()
  }, [fetchList])

  const fetchPlugins = useCallback(async (id: string) => {
    try {
      const r = await api.get<{ plugins: MpPluginInfo[] }>(`/mp/marketplaces/${encodeURIComponent(id)}/plugins`)
      setPlugins((prev) => ({ ...prev, [id]: r.plugins }))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  const handleAdd = async () => {
    const url = newUrl.trim()
    if (!url) return
    if (!/^https:\/\//.test(url)) {
      setError('only https:// URLs are supported')
      return
    }
    setAddState({ phase: 'busy' })
    setError(null)
    try {
      const body: { url: string; ref?: string } = { url }
      if (newRef.trim()) body.ref = newRef.trim()
      const r = await api.post<AddResponse>('/mp/marketplaces', body)
      setItems((prev) => [...prev.filter((x) => x.id !== r.entry.id), r.entry])
      if (r.warnings.length > 0) {
        setWarningsById((w) => ({ ...w, [r.entry.id]: r.warnings }))
      }
      setNewUrl('')
      setNewRef('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setAddState({ phase: 'idle' })
    }
  }

  const handleRefresh = async (id: string) => {
    setBusyId(id)
    setError(null)
    try {
      const r = await api.post<RefreshResponse>(`/mp/marketplaces/${encodeURIComponent(id)}/refresh`)
      setItems((prev) => prev.map((x) => (x.id === id ? r.entry : x)))
      setWarningsById((w) => ({ ...w, [id]: r.warnings }))
      // Invalidate cached plugin list so a re-expand re-fetches.
      setPlugins((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      if (expandedId === id) {
        await fetchPlugins(id)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  const handleRemove = async (id: string) => {
    setBusyId(id)
    setError(null)
    try {
      await api.delete(`/mp/marketplaces/${encodeURIComponent(id)}?confirm=true`)
      setItems((prev) => prev.filter((x) => x.id !== id))
      setPlugins((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      setWarningsById((w) => {
        const next = { ...w }
        delete next[id]
        return next
      })
      if (expandedId === id) setExpandedId(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusyId(null)
      setConfirmRemoveId(null)
    }
  }

  const handleToggleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null)
      return
    }
    setExpandedId(id)
    if (!plugins[id]) await fetchPlugins(id)
  }

  const handleTogglePlugin = async (mpId: string, plugin: string, enabled: boolean) => {
    // Optimistic update — if the request fails we revert.
    setPlugins((prev) => ({
      ...prev,
      [mpId]: (prev[mpId] ?? []).map((p) => (p.name === plugin ? { ...p, enabled } : p)),
    }))
    try {
      await api.post(`/mp/marketplaces/${encodeURIComponent(mpId)}/plugins/${encodeURIComponent(plugin)}/toggle`, {
        enabled,
      })
    } catch (e) {
      setError((e as Error).message)
      // Revert
      setPlugins((prev) => ({
        ...prev,
        [mpId]: (prev[mpId] ?? []).map((p) => (p.name === plugin ? { ...p, enabled: !enabled } : p)),
      }))
    }
  }

  return (
    <div>
      {/* Add form ---------------------------------------------------- */}
      <div style={{
        border: '1px solid var(--border)', borderRadius: 6, padding: 12, marginBottom: 16,
        background: 'var(--bg-elev)',
      }}>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 6 }}>
          Add a marketplace from a public https git repository.
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <input
            className="input"
            style={{ flex: 1, fontSize: 12 }}
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            placeholder="https://github.com/owner/repo"
            disabled={addState.phase === 'busy'}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd() }}
          />
          <input
            className="input"
            style={{ width: 130, fontSize: 12 }}
            value={newRef}
            onChange={(e) => setNewRef(e.target.value)}
            placeholder="ref (optional)"
            disabled={addState.phase === 'busy'}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd() }}
          />
          <button
            className="btn btn-primary"
            style={{ fontSize: 12, padding: '4px 14px' }}
            onClick={() => void handleAdd()}
            disabled={addState.phase === 'busy' || !newUrl.trim()}
          >
            {addState.phase === 'busy' ? 'Cloning…' : 'Add'}
          </button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          Only https:// URLs are accepted. Cloning runs as a depth-1 fetch and is
          stored under the server's state directory.
        </div>
      </div>

      {error && (
        <div className="modal-error" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* Marketplace list ------------------------------------------- */}
      {loading && (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-muted)' }}>Loading…</div>
      )}
      {!loading && items.length === 0 && (
        <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--fg-muted)', fontSize: 13 }}>
          No marketplaces added yet. Paste an https git URL above to add one.
        </div>
      )}
      {!loading && items.map((item) => (
        <MarketplaceCard
          key={item.id}
          item={item}
          warnings={warningsById[item.id] ?? []}
          plugins={plugins[item.id]}
          expanded={expandedId === item.id}
          busy={busyId === item.id}
          confirmRemove={confirmRemoveId === item.id}
          onToggleExpand={() => void handleToggleExpand(item.id)}
          onRefresh={() => void handleRefresh(item.id)}
          onRequestRemove={() => setConfirmRemoveId(item.id)}
          onCancelRemove={() => setConfirmRemoveId(null)}
          onConfirmRemove={() => void handleRemove(item.id)}
          onTogglePlugin={(name, enabled) => void handleTogglePlugin(item.id, name, enabled)}
        />
      ))}
    </div>
  )
}

// ── Single marketplace card with collapsible plugin list ───────────

interface CardProps {
  item: MpListItem
  warnings: MpParseWarning[]
  plugins: MpPluginInfo[] | undefined
  expanded: boolean
  busy: boolean
  confirmRemove: boolean
  onToggleExpand: () => void
  onRefresh: () => void
  onRequestRemove: () => void
  onCancelRemove: () => void
  onConfirmRemove: () => void
  onTogglePlugin: (name: string, enabled: boolean) => void
}

function MarketplaceCard({
  item, warnings, plugins, expanded, busy, confirmRemove,
  onToggleExpand, onRefresh, onRequestRemove, onCancelRemove, onConfirmRemove, onTogglePlugin,
}: CardProps) {
  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 6, marginBottom: 6, overflow: 'hidden',
      opacity: busy ? 0.7 : 1,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--bg)',
      }}>
        <button
          className="btn"
          style={{ padding: '0 6px', fontSize: 11, lineHeight: '20px', minWidth: 22 }}
          onClick={onToggleExpand}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div style={{ fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.displayName}
          </div>
          <div style={{
            fontSize: 11, color: 'var(--fg-muted)', fontFamily: 'var(--mono)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {item.source.url}{item.source.ref ? ` @ ${item.source.ref}` : ''}
          </div>
        </div>
        <span style={{
          fontSize: 11, color: 'var(--fg-muted)', background: 'var(--bg-elev-2)',
          padding: '1px 6px', borderRadius: 3, flexShrink: 0,
        }}>
          {item.pluginCount} plugin{item.pluginCount === 1 ? '' : 's'}
        </span>
        <button className="btn btn-sm" onClick={onRefresh} disabled={busy} title="Pull from upstream">
          Refresh
        </button>
        {!confirmRemove ? (
          <button
            className="btn btn-sm"
            style={{ color: 'var(--danger)' }}
            onClick={onRequestRemove}
            disabled={busy}
          >
            Del
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 2 }}>
            <button
              className="btn"
              style={{ padding: '2px 6px', fontSize: 11, color: 'var(--danger)' }}
              onClick={onConfirmRemove}
              disabled={busy}
            >
              Confirm
            </button>
            <button
              className="btn"
              style={{ padding: '2px 6px', fontSize: 11 }}
              onClick={onCancelRemove}
              disabled={busy}
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* Warnings strip --------------------------------------------- */}
      {warnings.length > 0 && (
        <div style={{
          padding: '4px 10px', fontSize: 11, color: 'var(--fg-muted)',
          borderTop: '1px solid var(--border)', background: 'var(--bg-elev)',
        }}>
          <span style={{ color: 'var(--warn, var(--fg-muted))' }}>⚠ {warnings.length} warning{warnings.length === 1 ? '' : 's'}:</span>{' '}
          {warnings.slice(0, 3).map((w) => w.detail).join('; ')}
          {warnings.length > 3 ? '…' : ''}
        </div>
      )}

      {/* Expanded plugin list --------------------------------------- */}
      {expanded && (
        <div style={{
          padding: '6px 10px 8px', borderTop: '1px solid var(--border)', background: 'var(--bg-elev)',
        }}>
          {!plugins && (
            <div style={{ padding: '8px 0', fontSize: 12, color: 'var(--fg-muted)' }}>Loading plugins…</div>
          )}
          {plugins && plugins.length === 0 && (
            <div style={{ padding: '8px 0', fontSize: 12, color: 'var(--fg-muted)' }}>
              No plugins in this marketplace.
            </div>
          )}
          {plugins?.map((p) => (
            <div key={p.name} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0',
            }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                background: p.enabled ? 'var(--plugin-active)' : 'var(--plugin-inactive)',
              }} />
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <div style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.name}
                  {p.version ? <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--fg-muted)' }}>v{p.version}</span> : null}
                </div>
                {p.description && (
                  <div style={{
                    fontSize: 11, color: 'var(--fg-muted)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {p.description}
                  </div>
                )}
              </div>
              <button
                className="btn btn-sm"
                onClick={() => onTogglePlugin(p.name, !p.enabled)}
                title={p.enabled ? 'Disable for new and live sessions' : 'Enable for new and live sessions'}
              >
                {p.enabled ? 'ON' : 'OFF'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
