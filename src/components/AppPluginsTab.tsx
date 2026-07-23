// App Plugins management tab — mounted as a lazy tab in GlobalSettingsModal.
//
// Lists installed plugins with runtime state, lets the user install from a
// local development directory, enable/disable/uninstall, and view/adjust
// permissions + configuration. This is the "Mod" surface, deliberately
// separate from the Claude Plugin Marketplace (which extends the agent, not
// the app shell).
//
// All mutations go through REST; the WS snapshot in PluginRegistryProvider
// keeps the list in sync across tabs without a manual refetch.

import { useCallback, useState } from 'react'
import { api, apiRequest } from '../hooks/useApi'
import { usePluginRegistry } from '../app-plugins/PluginRegistryProvider'
import type { AppPluginClientInfo } from '../../shared/app-plugins/runtime-state.js'
import type { NormalisedPermission, AppPluginPermission, PermissionSpec } from '../../shared/app-plugins/permissions.js'
import { ALL_PERMISSIONS } from '../../shared/app-plugins/permissions.js'

export function AppPluginsTab() {
  const { plugins, refresh } = usePluginRegistry()
  const [installPath, setInstallPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const install = useCallback(async () => {
    const path = installPath.trim()
    if (!path) return
    setBusy(true); setError(null)
    try {
      await api.post('/app-plugins/install', { source: { type: 'local', path } })
      setInstallPath('')
      await refresh()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }, [installPath, refresh])

  const enable = useCallback(async (id: string) => {
    setBusy(true); setError(null)
    try { await api.post(`/app-plugins/${encodeURIComponent(id)}/enable`); await refresh() }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }, [refresh])

  const disable = useCallback(async (id: string) => {
    setBusy(true); setError(null)
    try { await api.post(`/app-plugins/${encodeURIComponent(id)}/disable`); await refresh() }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }, [refresh])

  const uninstall = useCallback(async (id: string, deleteData: boolean) => {
    setBusy(true); setError(null)
    try {
      await apiRequest(`/app-plugins/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm: true, deleteData }),
      })
      await refresh()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }, [refresh])

  return (
    <div className="app-plugins-tab">
      <p className="app-plugins-intro">
        App Plugins (Mods) add menus, commands, and panels to the app. Claude Plugins
        (Marketplace) add tools and servers to the agent — the two are separate.
      </p>

      <div className="app-plugins-install">
        <input
          className="input"
          type="text"
          placeholder="Local plugin directory path (dev mode)…"
          value={installPath}
          onChange={(e) => setInstallPath(e.target.value)}
          aria-label="Plugin directory path"
        />
        <button className="btn btn-primary" disabled={busy || !installPath.trim()} onClick={install}>
          Install
        </button>
      </div>

      {error && <div className="modal-error">{error}</div>}

      <ul className="app-plugins-list">
        {plugins.length === 0 && <li className="app-plugins-empty">No app plugins installed.</li>}
        {plugins.map((p) => (
          <PluginRow
            key={p.id}
            plugin={p}
            expanded={expanded === p.id}
            onToggleExpand={() => setExpanded(expanded === p.id ? null : p.id)}
            onEnable={() => enable(p.id)}
            onDisable={() => disable(p.id)}
            onUninstall={(del) => uninstall(p.id, del)}
            busy={busy}
          />
        ))}
      </ul>
    </div>
  )
}

function PluginRow(props: {
  plugin: AppPluginClientInfo
  expanded: boolean
  onToggleExpand: () => void
  onEnable: () => void
  onDisable: () => void
  onUninstall: (deleteData: boolean) => void
  busy: boolean
}) {
  const { plugin: p, expanded } = props
  const stateColor = p.runtimeState === 'active' ? 'ok'
    : p.runtimeState === 'quarantined' || p.runtimeState === 'crashed' ? 'err'
    : p.runtimeState === 'permission-required' || p.runtimeState === 'incompatible' || p.runtimeState === 'corrupted' ? 'warn'
    : 'muted'
  return (
    <li className="app-plugins-row">
      <div className="app-plugins-row-head">
        <button className="app-plugins-row-toggle" onClick={props.onToggleExpand} aria-expanded={expanded}>
          <span className="app-plugins-name">{p.name}</span>
          <span className={`app-plugins-state state-${stateColor}`}>{p.runtimeState}</span>
        </button>
        <div className="app-plugins-row-actions">
          {p.enabled ? (
            <button className="btn" disabled={props.busy} onClick={props.onDisable}>Disable</button>
          ) : (
            <button className="btn btn-primary" disabled={props.busy || !p.compatible} onClick={props.onEnable}>Enable</button>
          )}
          <button className="btn" disabled={props.busy} onClick={() => props.onUninstall(false)}>Uninstall</button>
        </div>
      </div>
      <div className="app-plugins-meta">
        <span>{p.id}</span>
        <span>v{p.version}</span>
        {p.lastError && <span className="app-plugins-err">{p.lastError}</span>}
      </div>
      {expanded && <PluginDetails plugin={p} />}
    </li>
  )
}

function PluginDetails({ plugin }: { plugin: AppPluginClientInfo }) {
  return (
    <div className="app-plugins-details">
      {/* key remounts PermissionsSection when the granted set changes, so its
          useState initialiser re-runs with fresh grants (no effect needed). */}
      <PermissionsSection
        key={`${plugin.id}:${plugin.grantedPermissions.map((g) => g.permission).join(',')}`}
        plugin={plugin}
      />
      <ContributionsSection plugin={plugin} />
    </div>
  )
}

function PermissionsSection({ plugin }: { plugin: AppPluginClientInfo }) {
  const [granted, setGranted] = useState<NormalisedPermission[]>(plugin.grantedPermissions)
  const [saving, setSaving] = useState(false)

  const declared = plugin.declaredPermissions
  const grantedSet = new Set(granted.map((g) => g.permission))

  const toggle = (perm: AppPluginPermission) => {
    if (grantedSet.has(perm)) setGranted(granted.filter((g) => g.permission !== perm))
    else {
      // Preserve the declared params (notably network.fetch's host allowlist)
      // — toggling ON with empty params would grant a useless permission the
      // broker always denies (host allowlist empty). v1 consents to the whole
      // declared scope; host editing is deferred.
      const declared = plugin.declaredPermissions.find((d) => d.permission === perm)
      setGranted([...granted, { permission: perm, params: declared?.params ?? {} }])
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      const specs: PermissionSpec[] = granted.map((g) =>
        g.permission === 'network.fetch' && g.params.hosts?.length
          ? { permission: g.permission, params: { hosts: g.params.hosts } }
          : g.permission,
      )
      await api.put(`/app-plugins/${encodeURIComponent(plugin.id)}/permissions`, { granted: specs })
    } finally { setSaving(false) }
  }

  return (
    <div className="app-plugins-perms">
      <h4>Permissions</h4>
      <ul>
        {declared.map((p) => (
          <li key={p.permission}>
            <label>
              <input type="checkbox" checked={grantedSet.has(p.permission)} onChange={() => toggle(p.permission)} />
              <code>{p.permission}</code>
              {p.permission === 'network.fetch' && p.params.hosts?.length ? (
                <span className="app-plugins-hosts"> — {p.params.hosts.join(', ')}</span>
              ) : null}
            </label>
          </li>
        ))}
        {declared.length === 0 && <li>No permissions declared.</li>}
      </ul>
      <button className="btn" disabled={saving} onClick={save}>Save permissions</button>
      <p className="app-plugins-trust">
        Background plugins run as trusted local programs. Permissions are consent + feature
        flags, not a sandbox — a plugin can still use Node built-ins directly.
      </p>
    </div>
  )
}

function ContributionsSection({ plugin }: { plugin: AppPluginClientInfo }) {
  const c = plugin.contributions
  return (
    <div className="app-plugins-contribs">
      <h4>Contributions</h4>
      {c.commands.length === 0 && c.contextMenus.length === 0 && c.actions.length === 0 && c.configuration.properties.length === 0 ? (
        <p>None.</p>
      ) : (
        <ul>
          {c.commands.map((cmd) => <li key={cmd.id}>command: <code>{cmd.id}</code> — {cmd.title}</li>)}
          {c.contextMenus.map((m) => <li key={m.id}>menu: <code>{m.id}</code> @ {m.location}</li>)}
          {c.actions.map((a) => <li key={a.id}>action: <code>{a.id}</code> @ {a.location}</li>)}
          {c.configuration.properties.map((prop) => <li key={prop.key}>setting: <code>{prop.key}</code> ({prop.type})</li>)}
        </ul>
      )}
      {c.diagnostics.length > 0 && (
        <div className="app-plugins-diag">
          {c.diagnostics.map((d, i) => <div key={i}>⚠ {d}</div>)}
        </div>
      )}
      <p className="app-plugins-hosts-ref">Permission catalog: {ALL_PERMISSIONS.length} capabilities.</p>
    </div>
  )
}
