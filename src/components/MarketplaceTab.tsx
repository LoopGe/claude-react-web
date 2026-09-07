// Marketplace tab inside GlobalSettingsModal.
//
// Lists registered marketplaces, lets the user add new ones via https git
// URL, refresh, remove, and toggle individual plugins on/off. Mirrors the
// design language of McpTab (the closest existing pattern): row-per-entry
// with inline action buttons, two-click confirm for destructive operations,
// and lazy-loaded detail (plugin list per marketplace).

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../hooks/useApi'
import type { MpListItem, MpPluginInfo, MpParseWarning, MpUpdateStatus } from '../types'
import { IconX, IconChevronDown, IconChevronRight, IconAlertTriangle } from './icons/ToolIcons'
import { AnimatedCollapse } from './AnimatedCollapse'

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

interface CheckUpdatesResponse {
  ok: true
  updates: MpUpdateStatus[]
}

interface MarketplaceTabProps {
  /** Called after a plugin is successfully toggled, so a host (e.g. the
   *  session settings panel) can refresh its own plugin/command/agent list. */
  onPluginToggled?: () => void
}

export function MarketplaceTab({ onPluginToggled }: MarketplaceTabProps = {}) {
  const [items, setItems] = useState<MpListItem[]>([])
  // Live mirror of `items` for async callbacks (fetchUpdates) that must read
  // the current list without being re-created when it changes.
  const itemsRef = useRef<MpListItem[]>(items)
  useEffect(() => { itemsRef.current = items }, [items])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [warningsById, setWarningsById] = useState<Record<string, MpParseWarning[]>>({})
  // Lazily-loaded plugin lists, keyed by marketplace id. `undefined` means
  // not fetched yet; `[]` means fetched and empty.
  const [plugins, setPlugins] = useState<Record<string, MpPluginInfo[]>>({})
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  // Per-plugin in-flight toggles, keyed `<mpId>:<plugin>`. Enabling a
  // git-subdir plugin triggers a full external-repo clone server-side, which
  // can take seconds — disable the toggle button meanwhile to block double
  // clicks.
  const [togglingKeys, setTogglingKeys] = useState<Set<string>>(new Set())
  // Per-marketplace update status from POST /mp/marketplaces/check-updates.
  // `undefined` = not checked yet (no badge); an entry with hasUpdate=true
  // shows the "Update available" pill. Checked once on tab open.
  const [updateById, setUpdateById] = useState<Record<string, MpUpdateStatus>>({})
  // True while a check-updates request is in flight (the initial mount
  // check, a Retry after a whole-request failure, or the post-bulk
  // re-probe). The status line shows a neutral "Checking for updates…"
  // while this is set, instead of prematurely claiming everything is
  // current while updateById is still empty.
  const [checking, setChecking] = useState(false)
  // Set when the WHOLE check-updates request fails (network / timeout), as
  // opposed to a per-marketplace error which arrives inside a successful
  // response and is surfaced on the individual card. Lets the status line
  // distinguish "check failed" from "checked, all current".
  const [updateCheckError, setUpdateCheckError] = useState<string | null>(null)
  // Bulk "Update all" — one click refreshes every marketplace currently
  // badged as having an update. `bulkProgress` drives the button label;
  // `bulkResult` is the completion summary shown beside it.
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null)
  const [bulkResult, setBulkResult] = useState<string | null>(null)

  // Add form
  const [newUrl, setNewUrl] = useState('')
  const [newRef, setNewRef] = useState('')
  const [addState, setAddState] = useState<AddState>({ phase: 'idle' })

  // A check-updates response is a server-side snapshot taken when the request
  // was handled. If the user pulls (Refresh) or adds a marketplace while a
  // check is still in flight, the late response's entry for that marketplace is
  // stale (pre-pull) and must not overwrite the newer local "not behind" state.
  // `localPullEpoch` is a monotonic counter bumped on every successful local
  // pull; `lastLocalPullByMp` records the epoch at which each marketplace was
  // last pulled. fetchUpdates snapshots the epoch when the request starts and
  // skips any response entry whose marketplace was pulled after that snapshot.
  const localPullEpoch = useRef(0)
  const lastLocalPullByMp = useRef<Record<string, number>>({})
  // Record a successful local pull (Refresh / Add / bulk Update all) and
  // re-evaluate the whole-request check error. The whole-request error is only
  // resolved once EVERY listed marketplace has a known, non-error status — a
  // single pull must not let the status line over-claim "All marketplaces up to
  // date" for siblings that were never re-checked after the failed batch check.
  const noteLocalPull = useCallback((id: string) => {
    localPullEpoch.current += 1
    lastLocalPullByMp.current[id] = localPullEpoch.current
    const allKnown = items.every(
      (mp) => mp.id === id || (updateById[mp.id] != null && !updateById[mp.id]?.error),
    )
    if (allKnown) setUpdateCheckError(null)
  }, [items, updateById])

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

  // Fire one batch update check. Runs in the background after the list
  // loads. Per-marketplace errors are isolated into the response by the
  // server; a whole-request failure (network / timeout) is surfaced via
  // updateCheckError with a Retry affordance rather than left silent.
  const fetchUpdates = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setChecking(true)
    // Snapshot the pull epoch so a response that lands after a concurrent
    // Refresh/Add can't resurrect the badge that pull just cleared.
    const startEpoch = localPullEpoch.current
    try {
      // The server awaits Promise.allSettled of N concurrent `git ls-remote`
      // calls, each capped at 60s — so its worst-case response is ~60s (the
      // slowest one, since they run in parallel). The default 30s request
      // timeout is shorter than that, which would let one slow upstream
      // abort the whole batch and blank every badge. Give it headroom past
      // the server's per-call ceiling.
      const r = await api.post<CheckUpdatesResponse>('/mp/marketplaces/check-updates', {}, { signal, timeoutMs: 90_000 })
      // Merge, not replace: skip entries for marketplaces pulled after this
      // check began (the local pull is newer), and overwrite every other
      // entry (clearing old errors/badges). A wholesale replace would drop
      // the just-refreshed "not behind" state in favour of the stale snapshot.
      setUpdateById((prev) => {
        const next = { ...prev }
        for (const u of r.updates) {
          if ((lastLocalPullByMp.current[u.id] ?? 0) > startEpoch) continue
          next[u.id] = u
        }
        return next
      })
      setUpdateCheckError(null)
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      // Whole-request failure (network / timeout). Surface it rather than
      // pretending everything is current; per-marketplace errors already
      // arrive inside a 200 body and are shown on the individual card.
      //
      // Skip the error when every listed marketplace was individually pulled
      // AFTER this check began — those pulls supersede the failed batch, so a
      // stale pre-pull failure must not flash a banner beside marketplaces the
      // user just verified (a pull that succeeded after this request started
      // proves the server/upstream path is reachable again).
      const known = itemsRef.current
      const allPulledAfterStart =
        known.length > 0 && known.every((mp) => (lastLocalPullByMp.current[mp.id] ?? -1) > startEpoch)
      if (!allPulledAfterStart) setUpdateCheckError((e as Error).message)
    } finally {
      setChecking(false)
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
        if (items) {
          setItems(items)
          // Kick off the update check only after we have a list — it
          // doesn't block rendering; badges populate as it resolves.
          void fetchUpdates(ac.signal)
        }
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    })()
    return () => ac.abort()
  }, [fetchList, fetchUpdates])

  const fetchPlugins = useCallback(async (id: string) => {
    try {
      const r = await api.get<{ plugins: MpPluginInfo[] }>(`/mp/marketplaces/${encodeURIComponent(id)}/plugins`)
      setPlugins((prev) => ({ ...prev, [id]: r.plugins }))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  // Refresh a single marketplace and fold the result into local state. Shared
  // by the per-card Refresh button (handleRefresh) and the bulk "Update all"
  // loop. Throws on failure so callers decide how to surface it.
  const refreshMarketplace = useCallback(async (id: string): Promise<void> => {
    const r = await api.post<RefreshResponse>(`/mp/marketplaces/${encodeURIComponent(id)}/refresh`)
    setItems((prev) => prev.map((x) => (x.id === id ? r.entry : x)))
    setWarningsById((w) => ({ ...w, [id]: r.warnings }))
    // A refresh pulled local up to upstream HEAD — clear the update badge.
    setUpdateById((prev) => ({ ...prev, [id]: { id, hasUpdate: false } }))
    // Record the pull (supersedes any in-flight check snapshot for this
    // marketplace) and resolve the whole-request error only once every listed
    // marketplace has a known status — never on a lone pull with unverified
    // siblings, which would over-claim "All marketplaces up to date".
    noteLocalPull(id)
    // Invalidate cached plugin list so a re-expand re-fetches.
    setPlugins((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    if (expandedId === id) {
      await fetchPlugins(id)
    }
  }, [expandedId, fetchPlugins, noteLocalPull])

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
      // A freshly-added marketplace was just cloned at upstream HEAD, so it
      // can't be behind yet — seed an explicit "not behind" so no badge shows.
      setUpdateById((prev) => ({ ...prev, [r.entry.id]: { id: r.entry.id, hasUpdate: false } }))
      // Record the clone (supersedes any in-flight check snapshot of this
      // marketplace) and resolve the whole-request error only once every
      // marketplace has a known status.
      noteLocalPull(r.entry.id)
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
      await refreshMarketplace(id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  // Re-run the update check after a whole-request failure. The "Update all"
  // button is hidden while nothing is badged, so this is the only in-mount
  // way back to a successful check once the banner is showing.
  const handleRetryCheck = useCallback(() => { void fetchUpdates() }, [fetchUpdates])

  const handleUpdateAll = async () => {
    const targets = items.filter((it) => updateById[it.id]?.hasUpdate)
    if (targets.length === 0) return
    setBulkBusy(true)
    setBulkResult(null)
    setError(null)
    const failed: string[] = []
    try {
      for (let i = 0; i < targets.length; i++) {
        setBulkProgress({ done: i, total: targets.length })
        try {
          await refreshMarketplace(targets[i].id)
        } catch (e) {
          failed.push(`${targets[i].displayName}: ${(e as Error).message}`)
        }
      }
      // The loop is done — land the progress label on a terminal frame
      // (successes of targets) so the button doesn't sit at a stale
      // "Updating N-1/N…" during the re-probe, nor overstate when some
      // refreshes failed.
      setBulkProgress({ done: targets.length - failed.length, total: targets.length })
      // Re-probe so badges reflect the freshly-pulled state.
      await fetchUpdates()
    } finally {
      setBulkBusy(false)
      setBulkProgress(null)
    }
    const ok = targets.length - failed.length
    setBulkResult(
      failed.length === 0
        ? `Updated ${ok} marketplace${ok === 1 ? '' : 's'}.`
        : `Updated ${ok}/${targets.length}. Failed: ${failed.join('; ')}`,
    )
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
      // Drop its update status too — fetchUpdates now merges (not replaces),
      // so a removed marketplace's stale entry would otherwise linger.
      setUpdateById((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      // Tombstone the pull epoch (rather than deleting it) so an in-flight
      // check that started before this removal can't merge a stale entry for a
      // marketplace that no longer exists.
      lastLocalPullByMp.current[id] = localPullEpoch.current
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

  // Adjust a marketplace's enabledCount by delta (clamped ≥ 0) so the
  // "<enabled>/<total>" badge stays live without a refetch.
  const bumpEnabledCount = useCallback((mpId: string, delta: number) => {
    setItems((prev) => prev.map((it) => (
      it.id === mpId ? { ...it, enabledCount: Math.max(0, it.enabledCount + delta) } : it
    )))
  }, [])

  const handleTogglePlugin = async (mpId: string, plugin: string, enabled: boolean) => {
    const key = `${mpId}:${plugin}`
    // Optimistic update — if the request fails we revert.
    setPlugins((prev) => ({
      ...prev,
      [mpId]: (prev[mpId] ?? []).map((p) => (p.name === plugin ? { ...p, enabled } : p)),
    }))
    bumpEnabledCount(mpId, enabled ? 1 : -1)
    setTogglingKeys((prev) => new Set(prev).add(key))
    try {
      await api.post(`/mp/marketplaces/${encodeURIComponent(mpId)}/plugins/${encodeURIComponent(plugin)}/toggle`, {
        enabled,
      })
      onPluginToggled?.()
    } catch (e) {
      setError((e as Error).message)
      // Revert both the plugin row and the count.
      setPlugins((prev) => ({
        ...prev,
        [mpId]: (prev[mpId] ?? []).map((p) => (p.name === plugin ? { ...p, enabled: !enabled } : p)),
      }))
      bumpEnabledCount(mpId, enabled ? -1 : 1)
    } finally {
      setTogglingKeys((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const updateableCount = items.filter((it) => updateById[it.id]?.hasUpdate).length
  const anyCheckError = items.some((it) => !!updateById[it.id]?.error)

  return (
    <div>
      {/* Add form ---------------------------------------------------- */}
      <div style={{
        border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 12, marginBottom: 16,
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
            aria-label="Repository URL"
            placeholder="https://github.com/owner/repo"
            disabled={addState.phase === 'busy'}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd() }}
          />
          <input
            className="input"
            style={{ width: 130, fontSize: 12 }}
            value={newRef}
            onChange={(e) => setNewRef(e.target.value)}
            aria-label="Git ref (optional)"
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

      {!loading && items.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          {/* The button stays mounted mid-bulk-update even while badges clear,
              so it can show its progress label instead of flashing the
              "up to date" note between the last refresh and the re-probe.
              Badges also outrank the whole-check error note below: when any
              marketplace still reports an update, the Update-all button is
              the actionable recovery even if a re-probe just failed. */}
          {bulkBusy || updateableCount > 0 ? (
            <button
              className="btn btn-primary"
              onClick={() => void handleUpdateAll()}
              disabled={bulkBusy}
              title="Refresh every marketplace that has an update available"
            >
              {bulkBusy
                ? (bulkProgress ? `Updating ${bulkProgress.done}/${bulkProgress.total}…` : 'Updating…')
                : `Update all (${updateableCount})`}
            </button>
          ) : checking ? (
            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Checking for updates…</span>
          ) : updateCheckError || anyCheckError ? (
            <>
              {/* Whole-request failure (network/timeout) and per-marketplace
                  check errors (server reachable, upstreams down) both land
                  here with a Retry. Per-marketplace errors otherwise render a
                  blank status line with no in-mount way back to a re-check. */}
              <span
                title={updateCheckError
                  ? `Couldn't check for updates: ${updateCheckError}`
                  : 'Some marketplaces could not be checked against their upstream'}
                aria-label={updateCheckError
                  ? `Couldn't check for updates: ${updateCheckError}`
                  : 'Some marketplaces could not be checked against their upstream'}
                style={{
                  fontSize: 12, color: 'var(--warn, var(--fg-muted))',
                  display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'help',
                }}
              >
                <IconAlertTriangle size={12} />
                {updateCheckError ? "Couldn't check for updates" : "Some marketplaces couldn't be checked"}
              </span>
              <button
                className="btn"
                style={{ padding: '1px 8px', fontSize: 11 }}
                onClick={() => void handleRetryCheck()}
                title="Retry the update check"
              >
                Retry
              </button>
            </>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--ok)' }}>All marketplaces up to date</span>
          )}
          {bulkResult && (
            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{bulkResult}</span>
          )}
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
        <div key={item.id} className="marketplace-card-shell">
          <MarketplaceCard
            item={item}
            warnings={warningsById[item.id] ?? []}
            plugins={plugins[item.id]}
            expanded={expandedId === item.id}
            busy={busyId === item.id}
            confirmRemove={confirmRemoveId === item.id}
            updateStatus={updateById[item.id]}
            onToggleExpand={() => void handleToggleExpand(item.id)}
            onRefresh={() => void handleRefresh(item.id)}
            onRequestRemove={() => setConfirmRemoveId(item.id)}
            onCancelRemove={() => setConfirmRemoveId(null)}
            onConfirmRemove={() => void handleRemove(item.id)}
            onTogglePlugin={(name, enabled) => void handleTogglePlugin(item.id, name, enabled)}
            togglingPlugins={togglingKeys}
            bulkBusy={bulkBusy}
          />
        </div>
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
  /** Update-check result for this marketplace; `undefined` = not checked. */
  updateStatus?: MpUpdateStatus
  onToggleExpand: () => void
  onRefresh: () => void
  onRequestRemove: () => void
  onCancelRemove: () => void
  onConfirmRemove: () => void
  onTogglePlugin: (name: string, enabled: boolean) => void
  /** Set of `<mpId>:<plugin>` keys with an in-flight toggle request. */
  togglingPlugins: Set<string>
  /** True while the bulk "Update all" loop runs — disables card actions. */
  bulkBusy: boolean
}

function MarketplaceCard({
  item, warnings, plugins, expanded, busy, confirmRemove, updateStatus, bulkBusy,
  onToggleExpand, onRefresh, onRequestRemove, onCancelRemove, onConfirmRemove, onTogglePlugin,
  togglingPlugins,
}: CardProps) {
  const [pluginFilter, setPluginFilter] = useState<'all' | 'enabled' | 'disabled'>('all')
  const visiblePlugins = (plugins ?? []).filter((p) =>
    pluginFilter === 'all' ? true : pluginFilter === 'enabled' ? p.enabled : !p.enabled,
  )
  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', marginBottom: 6, overflow: 'hidden',
      opacity: busy || bulkBusy ? 0.7 : 1,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--bg)',
      }}>
        <button
          className="btn"
          style={{ padding: '0 6px', fontSize: 11, lineHeight: '20px', minWidth: 22 }}
          onClick={onToggleExpand}
          title={expanded ? 'Collapse' : 'Expand'}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          aria-expanded={expanded}
        >
          {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </button>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div style={{ fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.displayName}
          </div>
          <div style={{
            fontSize: 11, color: 'var(--fg-muted)', fontFamily: 'var(--mono)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {item.source.url}
            {item.source.branch || item.source.ref ? ` @ ${item.source.branch || item.source.ref}` : ''}
          </div>
        </div>
        <span
          style={{
            fontSize: 11, color: 'var(--fg-muted)', background: 'var(--bg-elev-2)',
            padding: '1px 6px', borderRadius: 'var(--radius-3xs)', flexShrink: 0,
          }}
          title={`${item.enabledCount} enabled of ${item.pluginCount} plugin${item.pluginCount === 1 ? '' : 's'}`}
        >
          {item.enabledCount > 0 && (
            <span style={{ color: 'var(--plugin-active)' }}>{item.enabledCount}</span>
          )}
          {item.enabledCount > 0 ? ' / ' : ''}
          {item.pluginCount} plugin{item.pluginCount === 1 ? '' : 's'}
        </span>
        {updateStatus?.hasUpdate && (
          <span
            title="Upstream has new commits — click Refresh to pull"
            style={{
              fontSize: 11, color: 'var(--warn, var(--fg-muted))', flexShrink: 0,
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 7, height: 7, borderRadius: 'var(--radius-circle)',
                background: 'var(--warn, var(--fg-muted))', flexShrink: 0,
              }}
            />
            Update
          </span>
        )}
        {updateStatus?.error && (
          <span
            title={`Couldn't check for updates: ${updateStatus.error}`}
            style={{
              fontSize: 11, color: 'var(--warn, var(--fg-muted))', flexShrink: 0,
              display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'help',
            }}
            aria-label={`Couldn't check for updates: ${updateStatus.error}`}
          >
            <IconAlertTriangle size={12} />
          </span>
        )}
        <button className="btn" onClick={onRefresh} disabled={busy || bulkBusy} title="Pull from upstream">
          Refresh
        </button>
        {!confirmRemove ? (
          <button
            className="btn"
            style={{ color: 'var(--danger)' }}
            onClick={onRequestRemove}
            disabled={busy || bulkBusy}
          >
            Del
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 2 }}>
            <button
              className="btn"
              style={{ padding: '2px 6px', fontSize: 11, color: 'var(--danger)' }}
              onClick={onConfirmRemove}
              disabled={busy || bulkBusy}
            >
              Confirm
            </button>
            <button
              className="btn"
              style={{ padding: '2px 6px', fontSize: 11 }}
              onClick={onCancelRemove}
              disabled={busy || bulkBusy}
              aria-label="Cancel"
            >
              <IconX size={12} />
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
          <span style={{ color: 'var(--warn, var(--fg-muted))', display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconAlertTriangle size={12} /> {warnings.length} warning{warnings.length === 1 ? '' : 's'}:</span>{' '}
          {warnings.slice(0, 3).map((w) => w.detail).join('; ')}
          {warnings.length > 3 ? '…' : ''}
        </div>
      )}

      {/* Expanded plugin list --------------------------------------- */}
      <AnimatedCollapse open={expanded}>
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
          {/* Filter bar: only worth showing when there's more than one plugin. */}
          {plugins && plugins.length > 1 && (
            <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
              {(['all', 'enabled', 'disabled'] as const).map((f) => {
                const count = f === 'all'
                  ? plugins.length
                  : plugins.filter((p) => (f === 'enabled' ? p.enabled : !p.enabled)).length
                return (
                  <button
                    key={f}
                    className="btn"
                    onClick={() => setPluginFilter(f)}
                    aria-pressed={pluginFilter === f}
                    style={{
                      fontSize: 11,
                      textTransform: 'capitalize',
                      background: pluginFilter === f ? 'var(--bg-elev-2)' : undefined,
                      fontWeight: pluginFilter === f ? 600 : undefined,
                    }}
                  >
                    {f} ({count})
                  </button>
                )
              })}
            </div>
          )}
          {plugins && plugins.length > 0 && visiblePlugins.length === 0 && (
            <div style={{ padding: '8px 0', fontSize: 12, color: 'var(--fg-muted)' }}>
              No {pluginFilter} plugins.
            </div>
          )}
          {visiblePlugins.map((p) => (
            <div key={p.name} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0',
            }}>
              <span style={{
                width: 8, height: 8, borderRadius: 'var(--radius-circle)', flexShrink: 0,
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
              {(() => {
                const toggling = togglingPlugins.has(`${item.id}:${p.name}`)
                return (
                  <button
                    className="btn"
                    onClick={() => onTogglePlugin(p.name, !p.enabled)}
                    disabled={toggling}
                    title={p.enabled ? 'Disable for new and live sessions' : 'Enable for new and live sessions'}
                  >
                    {toggling ? '…' : p.enabled ? 'ON' : 'OFF'}
                  </button>
                )
              })()}
            </div>
          ))}
        </div>
      </AnimatedCollapse>
    </div>
  )
}
