// Structured editor for SDK flag settings. Replaces the raw JSON textarea
// with tabbed sub-editors for the two most common top-level keys (permissions
// and env), plus a "Raw JSON" tab for power users.
//
// The parent holds the canonical JSON string; this component parses it on
// tab switch and serialises structured changes back on every edit.

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { PERMISSION_MODES } from '../types'
import { IconX } from './icons/ToolIcons'

interface Props {
  value: string
  onChange: (json: string) => void
  disabled?: boolean
}

type Tab = 'permissions' | 'env' | 'raw'

let kvIdCounter = 0
function nextId() {
  return `fse-${++kvIdCounter}`
}

interface KvRow {
  id: string
  key: string
  value: string
}

function parseSettings(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function getPermissions(obj: Record<string, unknown>): { allow: string[]; deny: string[]; defaultMode: string } {
  const raw = obj.permissions
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { allow: [], deny: [], defaultMode: 'default' }
  }
  const p = raw as Record<string, unknown>
  const allow = Array.isArray(p.allow) ? p.allow.filter((x): x is string => typeof x === 'string') : []
  const deny = Array.isArray(p.deny) ? p.deny.filter((x): x is string => typeof x === 'string') : []
  const defaultMode = typeof p.defaultMode === 'string' ? p.defaultMode : 'default'
  return { allow, deny, defaultMode }
}

function getEnv(obj: Record<string, unknown>): KvRow[] {
  const raw = obj.env
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [{ id: nextId(), key: '', value: '' }]
  }
  const entries = Object.entries(raw as Record<string, string>)
  if (entries.length === 0) return [{ id: nextId(), key: '', value: '' }]
  return entries.map(([k, v]) => ({ id: nextId(), key: k, value: String(v ?? '') }))
}

/** Sync structured fields from a parsed settings object into local state
 *  setters. Called on tab switch and on initial mount. */
function syncFromObj(
  obj: Record<string, unknown>,
  tab: Tab,
  setAllowText: (s: string) => void,
  setDenyText: (s: string) => void,
  setDefaultMode: (s: string) => void,
  setEnvRows: (r: KvRow[]) => void,
) {
  if (tab === 'permissions') {
    const p = getPermissions(obj)
    setAllowText(p.allow.join('\n'))
    setDenyText(p.deny.join('\n'))
    setDefaultMode(p.defaultMode)
  } else if (tab === 'env') {
    setEnvRows(getEnv(obj))
  }
}

export function FlagSettingsEditor({ value, onChange, disabled }: Props) {
  const [tab, setTab] = useState<Tab>('permissions')
  // Per-instance prefix for label↔control id linkage. FlagSettingsEditor
  // renders inside each SettingsPanel (one per Chat panel, up to 3), so ids
  // must stay document-unique across instances.
  const uid = useId()

  // Local structured state — initialised from the parent's JSON.
  const [allowText, setAllowText] = useState('')
  const [denyText, setDenyText] = useState('')
  const [defaultMode, setDefaultMode] = useState<string>('default')
  const [envRows, setEnvRows] = useState<KvRow[]>([{ id: nextId(), key: '', value: '' }])

  // Ref to track whether the last onChange was from our structured editor
  // (and therefore should NOT re-sync back to local state).
  const internalChangeRef = useRef(false)

  // Sync from parent JSON → local state. Skips sync when the parent value
  // was just changed by our own pushUp() call (so we don't clobber cursor
  // position in the textarea).
  useEffect(() => {
    if (internalChangeRef.current) {
      internalChangeRef.current = false
      return
    }
    const obj = parseSettings(value)
    syncFromObj(obj, tab, setAllowText, setDenyText, setDefaultMode, setEnvRows)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  // Serialize structured state back to the parent JSON string.
  const pushUp = useCallback(
    (overrides: Record<string, unknown>) => {
      // Merge with whatever the raw JSON already contains (so power-user
      // keys like `hooks`, `model`, etc. survive structured edits).
      const base = parseSettings(value)
      const next = { ...base, ...overrides }
      // Remove empty permissions/env keys so they don't appear as `{}`.
      if (next.permissions && typeof next.permissions === 'object') {
        const p = next.permissions as Record<string, unknown>
        if ((!p.allow || (Array.isArray(p.allow) && p.allow.length === 0)) &&
            (!p.deny || (Array.isArray(p.deny) && p.deny.length === 0)) &&
            (!p.defaultMode || p.defaultMode === 'default')) {
          delete next.permissions
        }
      }
      if (next.env && typeof next.env === 'object' && Object.keys(next.env as Record<string, unknown>).length === 0) {
        delete next.env
      }
      internalChangeRef.current = true
      onChange(JSON.stringify(next, null, 2))
    },
    [value, onChange],
  )

  // Switch tabs and immediately sync the new tab's fields from the current
  // JSON value (avoids a useEffect-triggered cascade).
  const switchTab = useCallback(
    (next: Tab) => {
      setTab(next)
      const obj = parseSettings(value)
      syncFromObj(obj, next, setAllowText, setDenyText, setDefaultMode, setEnvRows)
    },
    [value],
  )

  const handleAllowChange = (text: string) => {
    setAllowText(text)
    const allow = text.split('\n').map((l) => l.trim()).filter(Boolean)
    const deny = denyText.split('\n').map((l) => l.trim()).filter(Boolean)
    const perm: Record<string, unknown> = {}
    if (allow.length > 0) perm.allow = allow
    if (deny.length > 0) perm.deny = deny
    if (defaultMode !== 'default') perm.defaultMode = defaultMode
    pushUp({ permissions: perm })
  }

  const handleDenyChange = (text: string) => {
    setDenyText(text)
    const allow = allowText.split('\n').map((l) => l.trim()).filter(Boolean)
    const deny = text.split('\n').map((l) => l.trim()).filter(Boolean)
    const perm: Record<string, unknown> = {}
    if (allow.length > 0) perm.allow = allow
    if (deny.length > 0) perm.deny = deny
    if (defaultMode !== 'default') perm.defaultMode = defaultMode
    pushUp({ permissions: perm })
  }

  const handleDefaultModeChange = (mode: string) => {
    setDefaultMode(mode)
    const allow = allowText.split('\n').map((l) => l.trim()).filter(Boolean)
    const deny = denyText.split('\n').map((l) => l.trim()).filter(Boolean)
    const perm: Record<string, unknown> = {}
    if (allow.length > 0) perm.allow = allow
    if (deny.length > 0) perm.deny = deny
    if (mode !== 'default') perm.defaultMode = mode
    pushUp({ permissions: perm })
  }

  const updateEnvRow = (id: string, field: 'key' | 'value', val: string) => {
    const next = envRows.map((r) => (r.id === id ? { ...r, [field]: val } : r))
    setEnvRows(next)
    const entries = next.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value])
    const env = entries.length > 0 ? Object.fromEntries(entries) : {}
    pushUp({ env })
  }

  const addEnvRow = () => {
    setEnvRows((prev) => [...prev, { id: nextId(), key: '', value: '' }])
  }

  const removeEnvRow = (id: string) => {
    const next = envRows.filter((r) => r.id !== id)
    if (next.length === 0) next.push({ id: nextId(), key: '', value: '' })
    setEnvRows(next)
    const entries = next.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value])
    const env = entries.length > 0 ? Object.fromEntries(entries) : {}
    pushUp({ env })
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'permissions', label: 'Permissions' },
    { id: 'env', label: 'Env' },
    { id: 'raw', label: 'Raw JSON' },
  ]

  return (
    <div className="settings-field">
      <label>Flag settings</label>
      <div className="fse-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`fse-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => switchTab(t.id)}
            disabled={disabled}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="fse-body">
        {tab === 'permissions' && (
          <div className="fse-permissions">
            <div className="settings-field" style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 12 }} htmlFor={uid + '-default-mode'}>Default mode</label>
              <select
                className="select"
                id={uid + '-default-mode'}
                value={defaultMode}
                onChange={(e) => handleDefaultModeChange(e.target.value)}
                disabled={disabled}
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }} htmlFor={uid + '-allow'}>
                  Allow rules
                  <span className="hint" style={{ marginLeft: 6 }}>one per line</span>
                </label>
                <textarea
                  className="textarea"
                  id={uid + '-allow'}
                  rows={5}
                  value={allowText}
                  onChange={(e) => handleAllowChange(e.target.value)}
                  disabled={disabled}
                  placeholder={'Bash(npm test)\nRead(~/**)'}
                  style={{ fontSize: 12 }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }} htmlFor={uid + '-deny'}>
                  Deny rules
                  <span className="hint" style={{ marginLeft: 6 }}>one per line</span>
                </label>
                <textarea
                  className="textarea"
                  id={uid + '-deny'}
                  rows={5}
                  value={denyText}
                  onChange={(e) => handleDenyChange(e.target.value)}
                  disabled={disabled}
                  placeholder={'Bash(rm -rf *)'}
                  style={{ fontSize: 12 }}
                />
              </div>
            </div>
            <span className="hint" style={{ marginTop: 4 }}>
              Rules use <code>Tool(pattern)</code> syntax. Leave empty to use the session&apos;s default permissions.
            </span>
          </div>
        )}
        {tab === 'env' && (
          <div className="fse-env">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {envRows.map((row) => (
                <div key={row.id} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <input
                    className="input"
                    style={{ flex: 1, fontSize: 12 }}
                    aria-label="Environment variable key"
                    placeholder="key"
                    value={row.key}
                    onChange={(e) => updateEnvRow(row.id, 'key', e.target.value)}
                    disabled={disabled}
                  />
                  <input
                    className="input"
                    style={{ flex: 1, fontSize: 12 }}
                    aria-label="Environment variable value"
                    placeholder="value"
                    value={row.value}
                    onChange={(e) => updateEnvRow(row.id, 'value', e.target.value)}
                    disabled={disabled}
                  />
                  <button
                    type="button"
                    className="btn btn-icon"
                    style={{ fontSize: 11, padding: '2px 6px' }}
                    onClick={() => removeEnvRow(row.id)}
                    disabled={disabled}
                    title="Remove row"
                    aria-label="Remove row"
                  >
                    <IconX size={12} />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="btn"
              style={{ marginTop: 6, fontSize: 12, padding: '2px 8px' }}
              onClick={addEnvRow}
              disabled={disabled}
            >
              + Add variable
            </button>
            <span className="hint" style={{ marginTop: 4 }}>
              Environment variables passed to the SDK subprocess.
            </span>
          </div>
        )}
        {tab === 'raw' && (
          <div className="fse-raw">
            <textarea
              className="textarea"
              rows={8}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              disabled={disabled}
              aria-label="Flag settings JSON"
              placeholder={'{"permissions": {...}, "env": {...}}'}
              style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
            />
            <span className="hint">
              Calls <code>Query.applyFlagSettings()</code>. Top-level keys are shallow-merged across calls.
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
