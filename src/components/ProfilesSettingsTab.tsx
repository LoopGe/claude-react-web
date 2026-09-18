// Provider-profiles editor tab for the global Settings modal. Each provider
// profile carries its own credentials + model set + model groups; this tab
// renders one card per profile and wires mutations through `useProfiles`.
//
// The authToken field uses the dirty-token pattern: an empty password-style
// input means "keep the existing token on save". The client only ever holds
// `authTokenMasked` for display — the raw token is sent to the server over
// HTTPS on save and never logged or stored in component state beyond the
// transient form field.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import { api } from '../hooks/useApi'
import { dropPositionOf, isInAppDrag, readDragPayload, reorderById, sameOrder, setDragPayload } from '../hooks/useDragPayload'
import { prepareFlip } from '../utils/flip'
import { useIsMobile } from '../hooks/useIsMobile'
import { useProfiles } from '../hooks/useProfiles'
import type { ModelGroupConfig, ProviderProfile } from '../types/config'
import { randomId } from '../utils/uuid'
import { IconArrowUp, IconArrowDown, IconChevronDown, IconChevronRight, IconCheck, IconX } from './icons/ToolIcons'
import { AnimatedCollapse } from './AnimatedCollapse'
import { StatusBadge } from './StatusBadge'

/** Inline result of POST /profiles/:id/test. `ok` true means the token and
 *  baseUrl are valid; otherwise `error` describes the failure. */
interface ProfileTestResult {
  ok: boolean
  status?: number
  error?: string
  baseUrl?: string
}

export function ProfilesSettingsTab({ saveAllRef }: { saveAllRef?: MutableRefObject<(() => Promise<void>) | null> } = {}) {
  const { profiles, activeProfileId, create, update, remove, activate } = useProfiles()

  // Registry of dirty-card save callbacks, keyed by profile id. The parent
  // modal calls saveAllRef.current() on its unified Save to flush these.
  const dirtySavesRef = useRef(new Map<string, () => Promise<void>>())

  const registerDirtySave = useCallback((id: string, save: (() => Promise<void>) | null) => {
    if (save) dirtySavesRef.current.set(id, save)
    else dirtySavesRef.current.delete(id)
  }, [])

  useEffect(() => {
    if (!saveAllRef) return
    saveAllRef.current = async () => {
      const saves = [...dirtySavesRef.current.values()]
      await Promise.all(saves.map((s) => s()))
    }
    return () => { saveAllRef.current = null }
  }, [saveAllRef])

  // Accordion: one profile expanded at a time. `undefined` means the user
  // hasn't toggled anything yet — default to the active profile (or the
  // first); `null` collapses everything; a string pins a specific profile.
  const [expandedId, setExpandedId] = useState<string | null | undefined>(undefined)
  const activeId = profiles.some((p) => p.id === activeProfileId) ? activeProfileId : undefined
  const effectiveExpanded = expandedId === undefined ? (activeId ?? profiles[0]?.id ?? null) : expandedId
  const toggleExpand = (id: string) => {
    setExpandedId(effectiveExpanded === id ? null : id)
  }

  return (
    <div className="settings-profiles-tab">
      <div className="settings-section-head">
        <span className="settings-note">
          {profiles.length} profile{profiles.length !== 1 ? 's' : ''}. The active profile supplies
          credentials + model set for new sessions.
        </span>
        <button className="btn" onClick={() => void create({ name: `New profile ${profiles.length + 1}` })}>
          + Add profile
        </button>
      </div>
      {profiles.length === 0 && (
        <div className="settings-profile-empty">
          No profiles yet. Add one to get started.
        </div>
      )}
      {profiles.map((p) => (
        <ProfileCard
          key={p.id}
          profile={p}
          canDelete={profiles.length > 1}
          expanded={effectiveExpanded === p.id}
          onToggleExpand={() => toggleExpand(p.id)}
          onSave={(updates) => update(p.id, updates)}
          onDelete={() => remove(p.id)}
          onActivate={() => activate(p.id)}
          onRegisterDirtySave={(save) => registerDirtySave(p.id, save)}
        />
      ))}
    </div>
  )
}

function ProfileCard({
  profile,
  canDelete,
  expanded,
  onToggleExpand,
  onSave,
  onDelete,
  onActivate,
  onRegisterDirtySave,
}: {
  profile: ProviderProfile
  canDelete: boolean
  expanded: boolean
  onToggleExpand: () => void
  onSave: (updates: Record<string, unknown>) => Promise<void>
  onDelete: () => Promise<void>
  onActivate: () => unknown
  onRegisterDirtySave: (save: (() => Promise<void>) | null) => void
}) {
  // — Editor state (local; initialized from the profile prop once) ?
  const [name, setName] = useState(profile.name)
  const [baseUrl, setBaseUrl] = useState(profile.baseUrl ?? '')
  const [authToken, setAuthToken] = useState('')
  const [authTokenDirty, setAuthTokenDirty] = useState(false)
  const [modelList, setModelList] = useState<string[]>(profile.modelList ?? [])
  const [modelGroups, setModelGroups] = useState<ModelGroupConfig[]>(profile.modelGroups ?? [])
  const [recapModel, setRecapModel] = useState(profile.recapModel ?? '')
  const [commitMessageModel, setCommitMessageModel] = useState(profile.commitMessageModel ?? '')
  const [newModel, setNewModel] = useState('')

  // — Card-local UI state ?
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ProfileTestResult | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [dirty, setDirty] = useState(false)

  const uid = useId()

  // Stable ref to the latest handleSave so the effect below doesn't re-run
  // on every render (handleSave closes over state that changes on each keystroke).
  const handleSaveRef = useRef<(() => Promise<void>) | null>(null)

  // Register / unregister the save callback with the parent based on dirty
  // state. The parent's unified Save button calls all registered callbacks.
  useEffect(() => {
    if (dirty && handleSaveRef.current) {
      onRegisterDirtySave(() => handleSaveRef.current!())
      return () => onRegisterDirtySave(null)
    }
    onRegisterDirtySave(null)
  }, [dirty, onRegisterDirtySave])

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const updates: Record<string, unknown> = {
        name: name.trim(),
        baseUrl: baseUrl.trim() || null,
        modelList: modelList.length > 0 ? modelList : null,
        modelGroups: modelGroups.length > 0 ? modelGroups : null,
        recapModel: recapModel.trim() || null,
        commitMessageModel: commitMessageModel.trim() || null,
      }
      // Dirty-token pattern: only send authToken when the user typed a new one.
      if (authTokenDirty && authToken.trim()) {
        updates.authToken = authToken.trim()
      }
      await onSave(updates)
      setAuthTokenDirty(false)
      setAuthToken('')
      setDirty(false)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }
  // Written in a layout effect, not during render: a render that never commits
  // would otherwise leave the ref pointing at a dead closure. Layout effects
  // run before passive effects in the same commit, so the dirty-save
  // registration effect above still reads the latest handleSave.
  useLayoutEffect(() => {
    handleSaveRef.current = handleSave
  })

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const body: Record<string, string> = {}
      if (authTokenDirty && authToken.trim()) body.authToken = authToken.trim()
      if (baseUrl.trim()) body.baseUrl = baseUrl.trim()
      const r = await api.post<ProfileTestResult>(
        `/profiles/${encodeURIComponent(profile.id)}/test`,
        body,
        { timeoutMs: 20_000 },
      )
      setTestResult(r)
    } catch (e) {
      const err = e as { message?: string; status?: number }
      setTestResult({ ok: false, status: err.status, error: err.message ?? 'Failed' })
    } finally {
      setTesting(false)
    }
  }

  // — Model-list handlers (adapted from the old ModelsTab) ?
  const addModel = () => {
    const m = newModel.trim()
    if (!m || modelList.includes(m)) return
    setModelList([...modelList, m])
    setNewModel('')
    setDirty(true)
  }
  const removeModel = (model: string) => {
    setModelList(modelList.filter((m) => m !== model))
    if (recapModel === model) setRecapModel('')
    if (commitMessageModel === model) setCommitMessageModel('')
    setDirty(true)
  }
  // FLIP selectors scoped to this profile card so two cards briefly
  // co-mounted during an accordion collapse/expand don't share keys.
  const modelFlip = () =>
    prepareFlip(`[data-profile-card="${CSS.escape(profile.id)}"] [data-profile-model-id]`, 'data-profile-model-id')
  const groupFlip = () =>
    prepareFlip(`[data-profile-card="${CSS.escape(profile.id)}"] [data-profile-group-id]`, 'data-profile-group-id')

  const moveModel = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= modelList.length) return
    const next = [...modelList]
    ;[next[index], next[target]] = [next[target], next[index]]
    const animateMove = modelFlip()
    setModelList(next)
    setDirty(true)
    animateMove()
  }
  const sortModels = () => {
    const animateMove = modelFlip()
    setModelList([...modelList].sort((a, b) => a.localeCompare(b)))
    setDirty(true)
    animateMove()
  }

  // — Model-group handlers (adapted from the old ModelGroupsTab) ?
  const addModelGroup = () => {
    const id = randomId()
    setModelGroups([...modelGroups, { id, name: `Group ${modelGroups.length + 1}`, main: 'opus' }])
    setDirty(true)
  }
  const removeModelGroup = (id: string) => {
    setModelGroups(modelGroups.filter((g) => g.id !== id))
    setDirty(true)
  }
  const moveModelGroup = (index: number, direction: -1 | 1) => {
    const next = [...modelGroups]
    const j = index + direction
    if (j < 0 || j >= next.length) return
    ;[next[index], next[j]] = [next[j], next[index]]
    const animateMove = groupFlip()
    setModelGroups(next)
    setDirty(true)
    animateMove()
  }
  const updateModelGroup = (id: string, patch: Partial<ModelGroupConfig>) => {
    setModelGroups(modelGroups.map((g) => (g.id === id ? { ...g, ...patch } : g)))
    setDirty(true)
  }

  // — Drag-reorder for the two ordered lists above.
  // Mirrors the sidebar's HTML5 DnD language (useDragPayload + before/after
  // insertion line). Visual feedback is drop-hint state; the arrays only
  // reshuffle on drop, same as SessionList.
  const isMobile = useIsMobile()
  const [draggingModel, setDraggingModel] = useState<string | null>(null)
  const [modelDropHint, setModelDropHint] = useState<{ id: string; position: 'before' | 'after' } | null>(null)
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null)
  const [groupDropHint, setGroupDropHint] = useState<{ id: string; position: 'before' | 'after' } | null>(null)

  /** applyReorder — shared by both lists. Skips the state write when the
   *  drop is a no-op so Save doesn't appear for an unchanged order. FLIP-
   *  animates the settle so the drop matches the sidebar's motion language. */
  const applyReorder = <T,>(
    list: T[],
    setList: (next: T[]) => void,
    getId: (item: T) => string,
    draggedId: string,
    targetId: string,
    position: 'before' | 'after',
    flip: () => () => void,
  ) => {
    const next = reorderById(list, getId, draggedId, targetId, position)
    if (next === list || sameOrder(next, list)) return
    const animateMove = flip()
    setList(next)
    setDirty(true)
    animateMove()
  }

  /** Block the browser's native text drop of our payload ids (setDragPayload
   *  also writes a text/plain fallback) into ANY field on this card —
   *  Connection inputs sit outside the two list boxes. */
  const blockInAppNativeDrop = {
    onDragOver: (e: React.DragEvent) => { if (isInAppDrag(e)) e.preventDefault() },
    onDrop: (e: React.DragEvent) => { if (isInAppDrag(e)) e.preventDefault() },
  }

  const canDragModels = !isMobile && modelList.length > 1
  const canDragGroups = !isMobile && modelGroups.length > 1

  const canTest = (authTokenDirty && !!authToken.trim()) || !!profile.authTokenMasked
  const deleteDisabled = profile.isActive || !canDelete

  return (
    <div className="settings-card settings-profile-card" data-profile-card={profile.id}>
      <div className="settings-card-head settings-mcp-card-head">
        <button className="settings-card-toggle" onClick={onToggleExpand} aria-expanded={expanded}>
          <span className="settings-card-chevron" aria-hidden>
            {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          </span>
          <span className="settings-card-name">{profile.name}</span>
          {profile.isActive && <StatusBadge tone="accent">Active</StatusBadge>}
        </button>
        <div className="settings-mcp-actions">
          <button className="btn" onClick={() => void handleTest()} disabled={testing || saving || !canTest}
            title={!canTest ? 'Enter a token first' : 'Send a minimal request to verify the token and URL'}>
            {testing ? 'Testing...' : 'Test connection'}
          </button>
          <button
            className="btn"
            onClick={() => void onActivate()}
            disabled={profile.isActive || saving}
            title={profile.isActive ? 'Already active' : 'Make this the active profile'}
          >
            Set active
          </button>
          <button className="btn btn-primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
          {!confirmDelete ? (
            <button
              className="btn btn-danger"
              onClick={() => setConfirmDelete(true)}
              disabled={deleteDisabled}
              title={deleteDisabled ? (profile.isActive ? 'Cannot delete the active profile' : 'Cannot delete the last profile') : 'Delete this profile'}
            >
              Delete
            </button>
          ) : (
            <div className="settings-mcp-confirm">
              <button
                className="btn btn-danger"
                onClick={() => { void onDelete(); setConfirmDelete(false) }}
              >
                Confirm
              </button>
              <button className="btn" onClick={() => setConfirmDelete(false)} aria-label="Cancel">
                <IconX size={12} />
              </button>
            </div>
          )}
        </div>
      </div>

      {saveError && (
        <div className="settings-card-error">{saveError}</div>
      )}

      {testResult && (
        <div className={`settings-mcp-result ${testResult.ok ? 'status-connected' : 'status-failed'}`}>
          {testResult.ok ? (
            <span><IconCheck size={12} /> Token &amp; URL valid</span>
          ) : (
            <span>
              {testResult.status ? `${testResult.status}: ` : ''}{testResult.error ?? 'Failed'}
            </span>
          )}
        </div>
      )}

      <AnimatedCollapse open={expanded}>
        <div className="settings-card-body settings-profile-body" {...blockInAppNativeDrop}>
          <section className="settings-profile-section">
            <h4 className="settings-profile-section-label">Connection</h4>
            <div className="settings-field">
              <label htmlFor={`${uid}-name`}>Name</label>
              <input
                className="input"
                id={`${uid}-name`}
                value={name}
                onChange={(e) => { setName(e.target.value); setDirty(true) }}
              />
            </div>

            <div className="settings-field">
              <label htmlFor={`${uid}-authtoken`}>Auth Token</label>
              <input
                className="input"
                id={`${uid}-authtoken`}
                type="password"
                value={authToken}
                onChange={(e) => { setAuthToken(e.target.value); setAuthTokenDirty(true); setTestResult(null); setDirty(true) }}
                placeholder={profile.authTokenMasked ? `Current: ${profile.authTokenMasked} — enter new to replace` : 'sk-ant-...'}
              />
              <span className="hint">
                {profile.authTokenMasked
                  ? 'Leave empty to keep the existing token. Enter a new value to replace it.'
                  : 'Required for this profile to authenticate.'}
              </span>
            </div>

            <div className="settings-field">
              <label htmlFor={`${uid}-baseurl`}>Base URL</label>
              <input
                className="input"
                id={`${uid}-baseurl`}
                value={baseUrl}
                onChange={(e) => { setBaseUrl(e.target.value); setTestResult(null); setDirty(true) }}
                placeholder="https://api.anthropic.com"
              />
              <span className="hint">API endpoint (default: https://api.anthropic.com)</span>
            </div>
          </section>

          <section className="settings-profile-section">
            <h4 className="settings-profile-section-label">Models</h4>

            {/* Available Models — ordered list editor (adapted from ModelsTab) */}
            <div className="settings-field">
              <label>Available Models</label>
              <span className="hint">First model is the default. Drag the rank badge, or use the arrows, to reorder.</span>
              <div className="settings-model-list">
                {modelList.length > 1 && (
                  <div className="settings-model-list-toolbar">
                    <button
                      className="btn btn-xs settings-model-sort-btn"
                      onClick={sortModels}
                      title="Sort alphabetically (A→Z)"
                    >
                      A→Z
                    </button>
                  </div>
                )}
                {modelList.map((m, i) => (
                  <div
                    key={m}
                    data-profile-model-id={m}
                    className={[
                      'settings-model-row',
                      i === 0 ? 'default' : '',
                      draggingModel === m ? 'dragging' : '',
                      modelDropHint?.id === m ? `drop-${modelDropHint.position}` : '',
                    ].filter(Boolean).join(' ')}
                    onDragOver={(e) => {
                      // Branch on our own drag state, not the payload kind —
                      // browsers only populate getData on drop (see useDragPayload).
                      if (draggingModel == null) return
                      if (!isInAppDrag(e)) return
                      // Always preventDefault, even on the source row: the
                      // text/plain fallback would otherwise natively paste
                      // into any input the pointer crosses.
                      e.preventDefault()
                      if (draggingModel === m) return
                      const position = dropPositionOf(e, e.currentTarget)
                      setModelDropHint((prev) =>
                        prev && prev.id === m && prev.position === position ? prev : { id: m, position },
                      )
                    }}
                    onDragLeave={(e) => {
                      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                      setModelDropHint((prev) => (prev?.id === m ? null : prev))
                    }}
                    onDrop={(e) => {
                      const payload = readDragPayload(e)
                      setModelDropHint(null)
                      setDraggingModel(null)
                      if (!payload || payload.kind !== 'profile-model') return
                      // Only accept a drop that started from THIS card's list —
                      // payload.kind alone would let another profile's drag
                      // reorder this list during a collapse/expand overlap.
                      if (draggingModel == null) return
                      e.preventDefault()
                      e.stopPropagation()
                      const position = dropPositionOf(e, e.currentTarget)
                      applyReorder(modelList, setModelList, (id) => id, payload.id, m, position, modelFlip)
                    }}
                  >
                    {/* Rank doubles as the drag grip — buttons inside the row
                        must stay clickable without a 1px drift starting a drag. */}
                    <span
                      className={`settings-model-rank${canDragModels ? ' settings-model-grip' : ''}`}
                      title={
                        canDragModels
                          ? (i === 0 ? 'Default model · Drag to reorder' : 'Drag to reorder')
                          : (i === 0 ? 'Default model' : undefined)
                      }
                      draggable={canDragModels}
                      onDragStart={(e) => {
                        if (!canDragModels) return
                        setDraggingModel(m)
                        setDragPayload(e, { kind: 'profile-model', id: m })
                      }}
                      onDragEnd={() => {
                        setDraggingModel(null)
                        setModelDropHint(null)
                      }}
                    >
                      {i === 0 ? 'Default' : i + 1}
                    </span>
                    <code className="settings-model-id" title={m}>{m}</code>
                    <div className="settings-model-move" role="group" aria-label="Move model priority">
                      <button
                        className="btn-icon-sm settings-model-action"
                        onClick={() => moveModel(i, -1)}
                        disabled={i === 0}
                        title="Move up"
                        aria-label="Move up"
                      >
                        <IconArrowUp size={12} />
                      </button>
                      <button
                        className="btn-icon-sm settings-model-action"
                        onClick={() => moveModel(i, 1)}
                        disabled={i === modelList.length - 1}
                        title="Move down"
                        aria-label="Move down"
                      >
                        <IconArrowDown size={12} />
                      </button>
                    </div>
                    <button
                      className="btn-icon-sm settings-model-action danger"
                      onClick={() => removeModel(m)}
                      title="Remove"
                      aria-label="Remove"
                    >
                      <IconX size={12} />
                    </button>
                  </div>
                ))}
                <div className="settings-model-add-row">
                  <input
                    className="input settings-model-input"
                    value={newModel}
                    onChange={(e) => setNewModel(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addModel() }}
                    aria-label="New model ID"
                    placeholder="model-id (e.g. claude-sonnet-4-20250514)"
                  />
                  <button className="btn btn-xs settings-model-add-btn" onClick={addModel}>Add</button>
                </div>
              </div>
            </div>

            {/* Recap Model dropdown (over this profile's own modelList) */}
            <div className="settings-field">
              <label htmlFor={`${uid}-recap-model`}>Recap Model</label>
              <span className="hint">Model used for AI session summaries (lighter model recommended)</span>
              <div className="settings-model-select-wrap">
                <select
                  className="input settings-model-select"
                  id={`${uid}-recap-model`}
                  value={recapModel}
                  onChange={(e) => { setRecapModel(e.target.value); setDirty(true) }}
                >
                  <option value="">(default)</option>
                  {modelList.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <IconChevronDown className="settings-model-select-icon" size={14} aria-hidden />
              </div>
            </div>

            {/* Commit Message Model dropdown (over this profile's own modelList) */}
            <div className="settings-field">
              <label htmlFor={`${uid}-commit-message-model`}>Commit Message Model</label>
              <span className="hint">Model used for AI-generated commit messages in Git panel</span>
              <div className="settings-model-select-wrap">
                <select
                  className="input settings-model-select"
                  id={`${uid}-commit-message-model`}
                  value={commitMessageModel}
                  onChange={(e) => { setCommitMessageModel(e.target.value); setDirty(true) }}
                >
                  <option value="">(default)</option>
                  {modelList.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <IconChevronDown className="settings-model-select-icon" size={14} aria-hidden />
              </div>
            </div>
          </section>

          <section className="settings-profile-section">
            <h4 className="settings-profile-section-label">Model Groups</h4>

            {/* Model Groups — adapted from ModelGroupsTab */}
            <div className="settings-field">
              <span className="hint">
                Groups map Opus/Sonnet/Haiku slots to concrete models. Drag the rank badge, or use the
                arrows, to reorder. Sessions can select a group or a single model; empty slots inherit
                the main slot.
              </span>
              <div className="settings-model-list">
                {modelGroups.length === 0 && (
                  <div className="settings-model-empty">No groups yet. Add one to bundle tier models.</div>
                )}
                {modelGroups.map((g, i) => {
                  const slots: { key: 'opus' | 'sonnet' | 'haiku'; label: string }[] = [
                    { key: 'opus', label: 'Opus' },
                    { key: 'sonnet', label: 'Sonnet' },
                    { key: 'haiku', label: 'Haiku' },
                  ]
                  return (
                    <div
                      key={g.id}
                      data-profile-group-id={g.id}
                      className={[
                        'settings-model-group',
                        draggingGroupId === g.id ? 'dragging' : '',
                        groupDropHint?.id === g.id ? `drop-${groupDropHint.position}` : '',
                      ].filter(Boolean).join(' ')}
                      onDragOver={(e) => {
                        if (draggingGroupId == null) return
                        if (!isInAppDrag(e)) return
                        e.preventDefault()
                        if (draggingGroupId === g.id) return
                        // Anchor the midpoint to the header row, not the whole
                        // card — the slots grid roughly doubles card height and
                        // would push the split into the middle of the fields.
                        const anchor = e.currentTarget.querySelector<HTMLElement>('.settings-model-row') ?? e.currentTarget
                        const position = dropPositionOf(e, anchor)
                        setGroupDropHint((prev) =>
                          prev && prev.id === g.id && prev.position === position ? prev : { id: g.id, position },
                        )
                      }}
                      onDragLeave={(e) => {
                        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                        setGroupDropHint((prev) => (prev?.id === g.id ? null : prev))
                      }}
                      onDrop={(e) => {
                        const payload = readDragPayload(e)
                        setGroupDropHint(null)
                        setDraggingGroupId(null)
                        if (!payload || payload.kind !== 'profile-model-group') return
                        if (draggingGroupId == null) return
                        e.preventDefault()
                        e.stopPropagation()
                        const anchor = e.currentTarget.querySelector<HTMLElement>('.settings-model-row') ?? e.currentTarget
                        const position = dropPositionOf(e, anchor)
                        applyReorder(modelGroups, setModelGroups, (item) => item.id, payload.id, g.id, position, groupFlip)
                      }}
                    >
                      <div className="settings-model-row">
                        {/* Rank doubles as the drag grip — the rest of the card
                            is form fields, so making the whole card draggable
                            would swallow text-selection inside the inputs. */}
                        <span
                          className={`settings-model-rank${canDragGroups ? ' settings-model-grip' : ''}`}
                          title={canDragGroups ? 'Drag to reorder' : 'Group'}
                          draggable={canDragGroups}
                          onDragStart={(e) => {
                            if (!canDragGroups) return
                            setDraggingGroupId(g.id)
                            setDragPayload(e, { kind: 'profile-model-group', id: g.id })
                          }}
                          onDragEnd={() => {
                            setDraggingGroupId(null)
                            setGroupDropHint(null)
                          }}
                        >
                          {i + 1}
                        </span>
                        <input
                          className="input settings-model-input"
                          value={g.name}
                          onChange={(e) => updateModelGroup(g.id, { name: e.target.value })}
                          aria-label="Group name"
                        />
                        <div className="settings-model-move" role="group" aria-label="Move group priority">
                          <button
                            className="btn-icon-sm settings-model-action"
                            onClick={() => moveModelGroup(i, -1)}
                            disabled={i === 0}
                            title="Move up"
                            aria-label="Move up"
                          >
                            <IconArrowUp size={12} />
                          </button>
                          <button
                            className="btn-icon-sm settings-model-action"
                            onClick={() => moveModelGroup(i, 1)}
                            disabled={i === modelGroups.length - 1}
                            title="Move down"
                            aria-label="Move down"
                          >
                            <IconArrowDown size={12} />
                          </button>
                        </div>
                        <button
                          className="btn-icon-sm settings-model-action danger"
                          onClick={() => removeModelGroup(g.id)}
                          title="Remove"
                          aria-label="Remove"
                        >
                          <IconX size={12} />
                        </button>
                      </div>
                      <div className="settings-model-group-slots">
                        {slots.map((slot) => (
                          <div key={slot.key} className="settings-model-group-slot">
                            <label className="settings-model-group-slot-label" htmlFor={`${uid}-${g.id}-${slot.key}`}>
                              {slot.label}
                            </label>
                            <input
                              className="input settings-model-input"
                              id={`${uid}-${g.id}-${slot.key}`}
                              list={`${uid}-model-list`}
                              value={g[slot.key] ?? ''}
                              placeholder="(inherit main)"
                              onChange={(e) => updateModelGroup(g.id, { [slot.key]: e.target.value || undefined } as Partial<ModelGroupConfig>)}
                            />
                          </div>
                        ))}
                        <div className="settings-model-group-main">
                          <label className="settings-model-group-slot-label" htmlFor={`${uid}-${g.id}-main`}>Main</label>
                          <select
                            className="input settings-model-select"
                            id={`${uid}-${g.id}-main`}
                            value={g.main ?? 'opus'}
                            onChange={(e) => updateModelGroup(g.id, { main: e.target.value as 'opus' | 'sonnet' | 'haiku' })}
                          >
                            <option value="opus">Opus</option>
                            <option value="sonnet">Sonnet</option>
                            <option value="haiku">Haiku</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  )
                })}
                <datalist id={`${uid}-model-list`}>
                  {modelList.map((m) => <option key={m} value={m} />)}
                </datalist>
                <div className="settings-model-add-row">
                  <button className="btn btn-xs settings-model-add-btn" onClick={addModelGroup}>Add Group</button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </AnimatedCollapse>
    </div>
  )
}
