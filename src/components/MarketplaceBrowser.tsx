// Marketplace browser — lists available plugins from registered marketplaces
// and allows installing them via the claude CLI.

import { useEffect, useState } from 'react'
import { api } from '../hooks/useApi'
import type { MarketplaceInfo, MarketplacePlugin } from '../types'

interface Props {
  onClose: () => void
  onInstalled?: () => void
}

export function MarketplaceBrowser({ onClose, onInstalled }: Props) {
  const [marketplaces, setMarketplaces] = useState<MarketplaceInfo[]>([])
  const [selected, setSelected] = useState<string>('')
  const [plugins, setPlugins] = useState<MarketplacePlugin[]>([])
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [err, setErr] = useState<string | null>(null)

  // Load marketplaces on mount
  useEffect(() => {
    let cancelled = false
    api.get<{ marketplaces: MarketplaceInfo[] }>('/marketplaces')
      .then((res) => {
        if (cancelled) return
        setMarketplaces(res.marketplaces ?? [])
        if (res.marketplaces?.length) setSelected(res.marketplaces[0].name)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Load plugins when marketplace selection changes
  useEffect(() => {
    if (!selected) {
      // Defer to avoid synchronous setState in effect body
      const id = setTimeout(() => { setPlugins([]); setLoading(false) }, 0)
      return () => clearTimeout(id)
    }
    let cancelled = false
    // Defer to avoid synchronous setState in effect body
    const loadId = setTimeout(() => { if (!cancelled) setLoading(true) }, 0)
    api.get<{ plugins: MarketplacePlugin[] }>(`/marketplaces/${encodeURIComponent(selected)}/plugins`)
      .then((res) => { if (!cancelled) setPlugins(res.plugins ?? []) })
      .catch(() => { if (!cancelled) setPlugins([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; clearTimeout(loadId) }
  }, [selected])

  const install = async (plugin: MarketplacePlugin) => {
    setInstalling(plugin.name)
    setErr(null)
    try {
      await api.post(`/marketplaces/${encodeURIComponent(plugin.marketplace)}/plugins/${encodeURIComponent(plugin.name)}/install`)
      // Mark as installed locally
      setPlugins((prev) => prev.map((p) => p.name === plugin.name ? { ...p, installed: true } : p))
      onInstalled?.()
    } catch (e) {
      setErr((e as Error).message)
    }
    setInstalling(null)
  }

  const filtered = plugins.filter((p) =>
    !filter || p.name.toLowerCase().includes(filter.toLowerCase()) || p.description.toLowerCase().includes(filter.toLowerCase())
  )

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, width: 520, maxHeight: '70vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 15, flex: 1 }}>Plugin Marketplace</h3>
          <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={onClose}>Close</button>
        </div>

        {err && <div style={{ padding: '6px 16px', fontSize: 12, color: 'var(--danger)', background: 'var(--bg)' }}>{err}</div>}

        <div style={{ padding: '8px 16px', display: 'flex', gap: 8, borderBottom: '1px solid var(--border)' }}>
          <select className="select" value={selected} onChange={(e) => setSelected(e.target.value)} style={{ flex: 1 }}>
            {marketplaces.map((m) => (
              <option key={m.name} value={m.name}>{m.name}</option>
            ))}
          </select>
          <input
            className="input"
            placeholder="Filter plugins..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ flex: 1 }}
          />
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '8px 16px' }}>
          {loading && <div style={{ color: 'var(--fg-muted)', fontSize: 13, textAlign: 'center', padding: 16 }}>Loading...</div>}
          {!loading && filtered.length === 0 && (
            <div style={{ color: 'var(--fg-muted)', fontSize: 13, textAlign: 'center', padding: 16 }}>No plugins found</div>
          )}
          {filtered.map((p) => (
            <div key={p.name} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 500, fontSize: 13, flex: 1 }}>{p.name}</span>
                <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>v{p.version}</span>
                {p.installed ? (
                  <span style={{ fontSize: 11, color: 'var(--ok)', padding: '1px 6px', border: '1px solid var(--ok)', borderRadius: 3 }}>Installed</span>
                ) : (
                  <button
                    className="btn btn-primary"
                    style={{ padding: '2px 8px', fontSize: 11 }}
                    onClick={() => install(p)}
                    disabled={installing === p.name}
                  >
                    {installing === p.name ? 'Installing...' : 'Install'}
                  </button>
                )}
              </div>
              {p.description && (
                <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>{p.description}</div>
              )}
              {p.author && (
                <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2 }}>by {p.author}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
