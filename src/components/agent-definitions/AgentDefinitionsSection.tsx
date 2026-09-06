import type { StoredAgentDefinition } from '../../types'

export interface AgentDefinitionsSectionProps {
  agents: StoredAgentDefinition[]
  error?: string | null
  disabled?: boolean
  toggleEnabled: (name: string, enabled: boolean) => void
  remove: (name: string) => void
  /** Task 6 stub: opens the create/edit form. When defined, edits this
   *  definition; when undefined, creates a new one. */
  onEdit: (def?: StoredAgentDefinition) => void
}

export function AgentDefinitionsSection({
  agents,
  error,
  disabled,
  toggleEnabled,
  remove,
  onEdit,
}: AgentDefinitionsSectionProps) {
  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h4>Agents</h4>
        <button
          className="btn btn-sm"
          disabled={disabled}
          onClick={() => onEdit(undefined)}
        >
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
            <button
              className="btn btn-sm"
              disabled={disabled}
              onClick={() => onEdit(def)}
            >
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