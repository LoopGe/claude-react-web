import { useState } from 'react'
import { api } from '../../hooks/useApi'
import type { StoredAgentDefinition } from '../../types'

const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'disabled'] as const
const MEMORY_OPTIONS = ['user', 'project', 'local'] as const

const OPTIONAL_STRINGS = ['model', 'initialPrompt', 'observer', 'observerMessage', 'criticalSystemReminder_EXPERIMENTAL'] as const
const OPTIONAL_STRING_ARRAYS = ['tools', 'disallowedTools', 'mcpServers', 'skills'] as const

/** Client-side mirror of the server's coerceStoredAgentDefinition rules.
 *  Returns an error message string for a malformed definition, or null when
 *  the (partial) definition is structurally valid. */
export function validateAgentDefinition(partial: Record<string, unknown>): string | null {
  if (partial.name === undefined || typeof partial.name !== 'string' || !partial.name.trim()) return 'name is required'
  if (partial.description === undefined || typeof partial.description !== 'string' || !partial.description.trim()) return 'description is required'
  if (partial.prompt === undefined || typeof partial.prompt !== 'string' || !partial.prompt.trim()) return 'prompt is required'
  for (const s of OPTIONAL_STRINGS) {
    const v = partial[s]
    if (v !== undefined && (typeof v !== 'string' || !v.trim())) return `${s} must be a non-empty string`
  }
  for (const a of OPTIONAL_STRING_ARRAYS) {
    const v = partial[a]
    if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim()))) {
      return `${a} must be a list of non-empty strings`
    }
  }
  const memory = partial.memory
  if (memory !== undefined && !MEMORY_OPTIONS.includes(memory as (typeof MEMORY_OPTIONS)[number])) {
    return 'memory must be one of user, project, local'
  }
  const effort = partial.effort
  if (effort !== undefined && typeof effort !== 'number' && !EFFORT_OPTIONS.includes(effort as (typeof EFFORT_OPTIONS)[number])) {
    return 'effort must be low, medium, high, xhigh or max'
  }
  if (effort !== undefined && typeof effort === 'number' && !Number.isFinite(effort)) return 'effort must be a finite number'
  const pm = partial.permissionMode
  if (pm !== undefined && !PERMISSION_MODES.includes(pm as (typeof PERMISSION_MODES)[number])) return 'permissionMode is invalid'
  if (partial.maxTurns !== undefined && (typeof partial.maxTurns !== 'number' || !Number.isFinite(partial.maxTurns))) {
    return 'maxTurns must be a finite number'
  }
  if (partial.background !== undefined && typeof partial.background !== 'boolean') return 'background must be a boolean'
  return null
}

interface FormState {
  name: string
  description: string
  prompt: string
  tools: string[]
  disallowedTools: string[]
  mcpServers: string[]
  skills: string[]
  model: string
  /** Effort presets ('low'…'max') or a numeric token budget. The number type
   *  is preserved through edit so numeric-effort definitions round-trip
   *  unchanged (stringifying collapses it into a non-enum value → 400). */
  effort: string | number
  permissionMode: string
  maxTurns: string
  background: boolean
  memory: string
  initialPrompt: string
  observer: string
  observerMessage: string
  criticalSystemReminder_EXPERIMENTAL: string
}

function emptyForm(): FormState {
  return {
    name: '',
    description: '',
    prompt: '',
    tools: [],
    disallowedTools: [],
    mcpServers: [],
    skills: [],
    model: '',
    effort: '',
    permissionMode: '',
    maxTurns: '',
    background: false,
    memory: '',
    initialPrompt: '',
    observer: '',
    observerMessage: '',
    criticalSystemReminder_EXPERIMENTAL: '',
  }
}

function fromDef(def: StoredAgentDefinition): FormState {
  return {
    name: def.name,
    description: def.description,
    prompt: def.prompt,
    tools: def.tools ?? [],
    disallowedTools: def.disallowedTools ?? [],
    mcpServers: def.mcpServers ?? [],
    skills: def.skills ?? [],
    model: def.model ?? '',
    effort: def.effort ?? '',
    permissionMode: def.permissionMode ?? '',
    maxTurns: def.maxTurns === undefined ? '' : String(def.maxTurns),
    background: def.background ?? false,
    memory: def.memory ?? '',
    initialPrompt: def.initialPrompt ?? '',
    observer: def.observer ?? '',
    observerMessage: def.observerMessage ?? '',
    criticalSystemReminder_EXPERIMENTAL: def.criticalSystemReminder_EXPERIMENTAL ?? '',
  }
}

/** Build the POST/PUT `data` payload, dropping null/empty optional fields
 *  the server would reject (empty strings, empty arrays, unset selects).
 *  `name` is always included: the edit PUT strips it server-side and dropping
 *  it would make shared validation fail with "name is required". */
function buildData(f: FormState): Record<string, unknown> {
  const data: Record<string, unknown> = { name: f.name, description: f.description, prompt: f.prompt }
  for (const s of OPTIONAL_STRINGS) {
    if (f[s].trim()) data[s] = f[s].trim()
  }
  for (const a of OPTIONAL_STRING_ARRAYS) {
    if (f[a].length) data[a] = f[a]
  }
  if (f.effort !== '') {
    // A numeric effort (or a numeric-looking string) round-trips as a
    // NUMBER; anything else is an enum preset string the server accepts.
    data.effort =
      typeof f.effort === 'number'
        ? f.effort
        : !Number.isNaN(Number(f.effort))
          ? Number(f.effort)
          : f.effort
  }
  if (f.permissionMode) data.permissionMode = f.permissionMode
  if (f.memory) data.memory = f.memory
  if (f.maxTurns !== '') data.maxTurns = Number(f.maxTurns)
  data.background = f.background
  return data
}

function TagInput({
  label,
  value,
  onChange,
}: {
  label: string
  value: string[]
  onChange: (v: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const t = draft.trim()
    if (t && !value.includes(t)) onChange([...value, t])
    setDraft('')
  }
  return (
    <label className="settings-field settings-field-block">
      <span>{label}</span>
      <input
        type="text"
        value={draft}
        placeholder={`Type ${label.toLowerCase()} and press Enter`}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add()
          }
        }}
        onBlur={add}
      />
      {value.length > 0 && (
        <div className="agent-def-tags">
          {value.map((t) => (
            <span key={t} className="tag">
              {t}
              <button
                type="button"
                className="tag-remove"
                aria-label={`Remove ${t}`}
                onClick={() => onChange(value.filter((x) => x !== t))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </label>
  )
}

export interface AgentDefinitionFormProps {
  initial?: StoredAgentDefinition
  onSaved: () => void
  onCancel: () => void
}

export function AgentDefinitionForm({ initial, onSaved, onCancel }: AgentDefinitionFormProps) {
  const editing = initial !== undefined
  const [form, setForm] = useState<FormState>(() => (initial ? fromDef(initial) : emptyForm()))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const handleSubmit = async () => {
    // Validate the assembled payload (empty optionals omitted), not the raw
    // form state — otherwise unset optional strings (`''`) would be rejected
    // as invalid even though they're dropped from the payload.
    const data = buildData(form)
    const err = validateAgentDefinition(data)
    if (err) {
      setError(err)
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (editing) {
        await api.put(`/agent-definitions/${encodeURIComponent(initial.name)}`, { data })
      } else {
        await api.post('/agent-definitions', { data })
      }
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  return (
    <div className="agent-def-form">
      <div className="settings-section-head">
        <h4>{editing ? `Edit ${initial.name}` : 'New agent'}</h4>
        <div>
          <button className="btn btn-sm" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-sm btn-primary" onClick={handleSubmit} disabled={saving}>
            {editing ? 'Save' : 'Create'}
          </button>
        </div>
      </div>

      {error && <div className="settings-card-error">{error}</div>}

      <fieldset className="settings-section">
        <legend>Basic</legend>
        <label className="settings-field">
          <span>Name</span>
          <input
            type="text"
            value={form.name}
            disabled={editing}
            onChange={(e) => set('name', e.target.value)}
          />
        </label>
        <label className="settings-field">
          <span>Description</span>
          <input
            type="text"
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
          />
        </label>
        <label className="settings-field settings-field-block">
          <span>Prompt</span>
          <textarea
            rows={5}
            value={form.prompt}
            onChange={(e) => set('prompt', e.target.value)}
          />
        </label>
      </fieldset>

      <fieldset className="settings-section">
        <legend>Tools &amp; Capabilities</legend>
        <TagInput label="Tools" value={form.tools} onChange={(v) => set('tools', v)} />
        <TagInput label="Disallowed tools" value={form.disallowedTools} onChange={(v) => set('disallowedTools', v)} />
        <TagInput label="MCP servers" value={form.mcpServers} onChange={(v) => set('mcpServers', v)} />
        <TagInput label="Skills" value={form.skills} onChange={(v) => set('skills', v)} />
        <label className="settings-field">
          <span>Model</span>
          <input type="text" value={form.model} onChange={(e) => set('model', e.target.value)} />
        </label>
        {typeof form.effort === 'number' ? (
          <label className="settings-field">
            <span>Effort</span>
            <input
              type="number"
              step="any"
              value={form.effort}
              onChange={(e) => set('effort', e.target.value === '' ? '' : Number(e.target.value))}
            />
          </label>
        ) : (
          <label className="settings-field">
            <span>Effort</span>
            <select value={form.effort} onChange={(e) => set('effort', e.target.value)}>
              <option value="">Default</option>
              {EFFORT_OPTIONS.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          </label>
        )}
        <label className="settings-field">
          <span>Permission mode</span>
          <select value={form.permissionMode} onChange={(e) => set('permissionMode', e.target.value)}>
            <option value="">Default</option>
            {PERMISSION_MODES.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset className="settings-section">
        <legend>Runtime</legend>
        <label className="settings-field">
          <span>Max turns</span>
          <input
            type="number"
            min={1}
            value={form.maxTurns}
            onChange={(e) => set('maxTurns', e.target.value)}
          />
        </label>
        <label className="settings-field settings-field-inline">
          <span>Background</span>
          <input
            type="checkbox"
            checked={form.background}
            onChange={(e) => set('background', e.target.checked)}
          />
        </label>
        <label className="settings-field">
          <span>Memory</span>
          <select value={form.memory} onChange={(e) => set('memory', e.target.value)}>
            <option value="">Default</option>
            {MEMORY_OPTIONS.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </label>
        <label className="settings-field settings-field-block">
          <span>Initial message</span>
          <textarea rows={3} value={form.initialPrompt} onChange={(e) => set('initialPrompt', e.target.value)} />
        </label>
      </fieldset>

      <details className="settings-section">
        <summary>Advanced</summary>
        <label className="settings-field">
          <span>Observer</span>
          <input type="text" value={form.observer} onChange={(e) => set('observer', e.target.value)} />
        </label>
        <label className="settings-field">
          <span>Observer message</span>
          <input type="text" value={form.observerMessage} onChange={(e) => set('observerMessage', e.target.value)} />
        </label>
        <label className="settings-field settings-field-block">
          <span>Critical system reminder (experimental)</span>
          <textarea
            rows={3}
            value={form.criticalSystemReminder_EXPERIMENTAL}
            onChange={(e) => set('criticalSystemReminder_EXPERIMENTAL', e.target.value)}
          />
        </label>
      </details>
    </div>
  )
}