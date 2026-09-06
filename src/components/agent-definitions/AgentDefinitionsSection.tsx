import { useState } from 'react'
import type { StoredAgentDefinition } from '../../types'
import { AgentDefinitionForm } from './AgentDefinitionForm'

export interface AgentDefinitionsSectionProps {
  agents: StoredAgentDefinition[]
  error?: string | null
  disabled?: boolean
  toggleEnabled: (name: string, enabled: boolean) => void
  remove: (name: string) => void
  /** Re-reads the definition list after a create/edit save. */
  refresh: () => void | Promise<void>
}

export function AgentDefinitionsSection({
  agents,
  error,
  disabled,
  toggleEnabled,
  remove,
  refresh,
}: AgentDefinitionsSectionProps) {
  // Which definition the form is editing: `undefined` open for "new",
  // a def for an in-place edit, `null` for the list with no form open.
  const [editDef, setEditDef] = useState<StoredAgentDefinition | undefined | null>(null)

  if (editDef !== null) {
    return (
      <AgentDefinitionForm
        initial={editDef}
        onSaved={() => {
          setEditDef(null)
          void refresh()
        }}
        onCancel={() => setEditDef(null)}
      />
    )
  }

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h4>Agents</h4>
        <button className="btn btn-sm" disabled={disabled} onClick={() => setEditDef(undefined)}>
          New
        </button>
      </div>

      {error && <div className="settings-card-error">Failed to load agents: {error}</div>}

      {agents.length === 0 && !error && (
        <div className="settings-note">No agents defined</div>
      )}

      {agents.map((def) => (
        <div key={def.name} className="settings-card">
          <div className="settings-card-head">
            <span className="settings-card-dot" />
            <div className="settings-card-toggle">
              <span className="settings-card-name">{def.name}</span>
              <span className="settings-card-meta">{def.description}</span>
            </div>
            <label>
              <input
                type="checkbox"
                checked={def.enabled}
                disabled={disabled}
                onChange={() => toggleEnabled(def.name, !def.enabled)}
                aria-label={`Enable ${def.name}`}
              />
            </label>
            <button className="btn btn-sm" disabled={disabled} onClick={() => setEditDef(def)}>
              Edit
            </button>
            <button
              className="btn btn-sm btn-danger"
              disabled={disabled}
              onClick={() => remove(def.name)}
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
