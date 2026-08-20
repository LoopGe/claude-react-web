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

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, apiRequest } from '../hooks/useApi'
import { usePluginRegistry } from '../app-plugins/PluginRegistryProvider'
import { AppPluginMarketplaceSection } from './AppPluginMarketplaceSection'
import { DirectoryPicker } from './DirectoryPicker'
import { IconFolder } from './icons/ToolIcons'
import type { AppPluginClientInfo } from '../../shared/app-plugins/runtime-state.js'
import type { NormalisedPermission, AppPluginPermission, PermissionSpec } from '../../shared/app-plugins/permissions.js'
import { ALL_PERMISSIONS } from '../../shared/app-plugins/permissions.js'
import type { PluginConfigurationProperty } from '../../shared/app-plugins/contributions.js'

export function AppPluginsTab() {
  const { plugins, refresh } = usePluginRegistry()
  const [installPath, setInstallPath] = useState('')
  const [showDirPicker, setShowDirPicker] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [modelList, setModelList] = useState<string[]>([])

  // Fetch the server's model list once for the config editor (model field
  // uses a <datalist> so users can pick or type freely).
  useEffect(() => {
    let alive = true
    void api.get<{ models?: string[] }>('/config').then((res) => {
      if (alive && Array.isArray(res.models)) setModelList(res.models)
    }).catch(() => {})
    return () => { alive = false }
  }, [])

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

  const installFromPath = useCallback(async (path: string) => {
    setBusy(true); setError(null)
    try {
      await api.post('/app-plugins/install', { source: { type: 'local', path } })
      await refresh()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }, [refresh])

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

      <AppPluginMarketplaceSection />

      <h4 className="app-plugins-installed-heading">Installed</h4>
      <div className="app-plugins-install">
        <input
          className="input"
          type="text"
          placeholder="Local plugin directory path…"
          value={installPath}
          onChange={(e) => setInstallPath(e.target.value)}
          aria-label="Plugin directory path"
        />
        <button className="btn" onClick={() => setShowDirPicker(true)} disabled={busy} title="Browse">
          <IconFolder size={14} /> Browse
        </button>
        <button className="btn btn-primary" disabled={busy || !installPath.trim()} onClick={install}>
          {busy ? 'Installing…' : 'Install'}
        </button>
      </div>

      {error && <div className="modal-error">{error}</div>}

      {showDirPicker && createPortal(
        <DirectoryPicker
          title="Pick a plugin folder"
          selectLabel="Install this folder"
          footerHint="Select a folder that contains crw-plugin.json"
          onPick={(path) => {
            setInstallPath(path)
            setShowDirPicker(false)
            void installFromPath(path)
          }}
          onClose={() => setShowDirPicker(false)}
        />,
        document.body,
      )}

      <ul className="app-plugins-list">
        {plugins.length === 0 && <li className="app-plugins-empty">No app plugins installed.</li>}
        {plugins.map((p) => (
          <PluginRow
            key={p.id}
            plugin={p}
            expanded={expanded === p.id}
            modelList={modelList}
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
  modelList: string[]
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
      {expanded && <PluginDetails plugin={p} modelList={props.modelList} />}
    </li>
  )
}

function PluginDetails({ plugin, modelList }: { plugin: AppPluginClientInfo; modelList: string[] }) {
  return (
    <div className="app-plugins-details">
      {/* key remounts PermissionsSection when the granted set changes, so its
          useState initialiser re-runs with fresh grants (no effect needed). */}
      <PermissionsSection
        key={`${plugin.id}:${plugin.grantedPermissions.map((g) => g.permission).join(',')}`}
        plugin={plugin}
      />
      {plugin.contributions.configuration.properties.length > 0 && (
        <ConfigurationEditor key={`cfg:${plugin.id}`} plugin={plugin} modelList={modelList} />
      )}
      <ContributionsSection plugin={plugin} />
    </div>
  )
}

function ConfigurationEditor({ plugin, modelList }: { plugin: AppPluginClientInfo; modelList: string[] }) {
  const props = plugin.contributions.configuration.properties
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load current config (with defaults applied server-side) on mount.
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await api.get<{ configuration: Record<string, unknown> }>(`/app-plugins/${encodeURIComponent(plugin.id)}/configuration`)
        if (alive) setValues(res.configuration ?? {})
      } catch (e) {
        if (alive) setError((e as Error).message)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [plugin.id])

  const set = (key: string, v: unknown) => setValues((prev) => ({ ...prev, [key]: v }))

  const save = async () => {
    setSaving(true); setError(null)
    try {
      await api.put(`/app-plugins/${encodeURIComponent(plugin.id)}/configuration`, { values })
    } catch (e) {
      setError((e as Error).message)
    } finally { setSaving(false) }
  }

  if (loading) return <div className="app-plugins-config"><h4>Settings</h4><p>Loading…</p></div>
  return (
    <div className="app-plugins-config">
      <h4>Settings</h4>
      {error && <div className="modal-error">{error}</div>}
      <ul>
        {props.map((prop) => (
          <li key={prop.key}>
            <label>
              <span className="app-plugins-config-label">{prop.title}</span>
              <ConfigInput prop={prop} value={values[prop.key]} onChange={(v) => set(prop.key, v)} modelList={modelList} />
            </label>
            {prop.description && <span className="app-plugins-config-desc">{prop.description}</span>}
          </li>
        ))}
      </ul>
      <button className="btn" disabled={saving} onClick={save}>Save settings</button>
    </div>
  )
}

function ConfigInput({ prop, value, onChange, modelList }: {
  prop: PluginConfigurationProperty
  value: unknown
  onChange: (v: unknown) => void
  modelList: string[]
}) {
  switch (prop.type) {
    case 'boolean':
      return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
    case 'number':
      // Empty → null (not undefined, which JSON.stringify drops) so the server
      // sees the key and clears the stored value → next read applies the default.
      return <input className="input" type="number" value={typeof value === 'number' ? value : ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />
    case 'enum':
      return (
        <select className="input" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {(prop.enum ?? []).map((opt) => <option key={String(opt)} value={String(opt)}>{String(opt)}</option>)}
        </select>
      )
    case 'array':
      return <input className="input" type="text" value={Array.isArray(value) ? (value as string[]).join(', ') : ''} onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
    case 'string':
    default: {
      // Model fields: render a datalist (dropdown + free text).
      const isModelField = prop.key.toLowerCase().includes('model')
      const listId = isModelField ? `dl-${prop.key}` : undefined
      return (
        <>
          <input
            className="input"
            type="text"
            list={listId}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
          />
          {isModelField && (
            <datalist id={listId}>
              {modelList.map((m) => <option key={m} value={m} />)}
            </datalist>
          )}
        </>
      )
    }
  }
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
      {c.commands.length === 0 && c.contextMenus.length === 0 && c.actions.length === 0 ? (
        <p>None.</p>
      ) : (
        <ul>
          {c.commands.map((cmd) => <li key={cmd.id}>command: <code>{cmd.id}</code> — {cmd.title}</li>)}
          {c.contextMenus.map((m) => <li key={m.id}>menu: <code>{m.id}</code> @ {m.location}</li>)}
          {c.actions.map((a) => <li key={a.id}>action: <code>{a.id}</code> @ {a.location}</li>)}
        </ul>
      )}
      {c.diagnostics.length > 0 && (
        <div className="app-plugins-diag">
          {c.diagnostics.map((d, i) => <div key={i}><span aria-hidden="true">⚠ </span>{d}</div>)}
        </div>
      )}
      <p className="app-plugins-hosts-ref">Permission catalog: {ALL_PERMISSIONS.length} capabilities.</p>
    </div>
  )
}
