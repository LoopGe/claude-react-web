import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../hooks/useApi'
import { useWsHub } from '../hooks/useWsHub'
import type { SessionInfo } from '../types'
import {
  SUPPORTED_HOOK_EVENTS,
  type HookEvent,
  type HookMatcherConfig,
  type HookRunRecord,
  type HookRuntimeEvent,
  type SessionHooksConfig,
} from '../../shared/hooks'
import { AnimatedDetails } from './AnimatedCollapse'

// ── Event categories ──────────────────────────────────────────────────
interface EventCategory {
  label: string
  events: HookEvent[]
}

const EVENT_CATEGORIES: EventCategory[] = [
  { label: 'Tool', events: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'] },
  { label: 'Session', events: ['SessionStart', 'SessionEnd', 'Stop', 'StopFailure', 'Setup'] },
  { label: 'Agent', events: ['SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'TeammateIdle'] },
  { label: 'Permission & Input', events: ['PermissionRequest', 'PermissionDenied', 'UserPromptSubmit', 'Notification', 'Elicitation', 'ElicitationResult'] },
  { label: 'Lifecycle & Config', events: ['TaskCreated', 'TaskCompleted', 'ConfigChange', 'WorktreeCreate', 'WorktreeRemove', 'InstructionsLoaded', 'CwdChanged', 'FileChanged'] },
]

// Status → dot color and CSS class mapping
const STATUS_META: Record<string, { color: string; cls: string }> = {
  started:   { color: 'var(--accent)', cls: 'running' },
  progress:  { color: 'var(--accent)', cls: 'running' },
  success:   { color: 'var(--ok)',     cls: 'success' },
  error:     { color: 'var(--danger)', cls: 'error' },
  cancelled: { color: 'var(--fg-muted)', cls: 'cancelled' },
}

// ── Helpers ───────────────────────────────────────────────────────────
function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function formatHooks(config: SessionHooksConfig): string {
  return JSON.stringify(config, null, 2)
}

function upsertRun(runs: HookRunRecord[], event: HookRuntimeEvent): HookRunRecord[] {
  const next = runs.slice()
  const idx = next.findIndex((run) => run.id === event.run.id)
  if (idx >= 0) next[idx] = event.run
  else next.unshift(event.run)
  return next.slice(0, 100)
}

function totalHookCount(matchers: HookMatcherConfig[] | undefined): number {
  if (!matchers) return 0
  return matchers.reduce((sum, m) => sum + (m.hooks?.length ?? 0), 0)
}

function allConfiguredHookCount(config: SessionHooksConfig): number {
  let total = 0
  for (const event of SUPPORTED_HOOK_EVENTS) {
    total += totalHookCount(config[event])
  }
  return total
}

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ''
  }
}

// ── Component ─────────────────────────────────────────────────────────
interface Props {
  session: SessionInfo
  disabled?: boolean
  onSessionUpdate: (session: SessionInfo) => void
}

interface HooksResponse {
  hooks: SessionHooksConfig
  runs: HookRunRecord[]
}

export function HooksPanel({ session, disabled, onSessionUpdate }: Props) {
  const [text, setText] = useState('{}')
  const [runs, setRuns] = useState<HookRunRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const hub = useWsHub()

  // Parse config from JSON text for structured display
  const parsedConfig = useMemo((): SessionHooksConfig | null => {
    try {
      return JSON.parse(text) as SessionHooksConfig
    } catch {
      return null
    }
  }, [text])

  // Count hooks per category
  const categoryCounts = useMemo(() => {
    const config = parsedConfig ?? {}
    return EVENT_CATEGORIES.map((cat) => ({
      label: cat.label,
      total: cat.events.reduce((sum, ev) => sum + totalHookCount(config[ev]), 0),
    }))
  }, [parsedConfig])

  // Gather all configured hook entries for the card list
  const configuredEntries = useMemo(() => {
    if (!parsedConfig) return []
    const entries: { event: HookEvent; matcherIdx: number; matcher: HookMatcherConfig }[] = []
    for (const event of SUPPORTED_HOOK_EVENTS) {
      const matchers = parsedConfig[event]
      if (!matchers) continue
      matchers.forEach((matcher, idx) => {
        if (matcher.hooks.length > 0) {
          entries.push({ event, matcherIdx: idx, matcher })
        }
      })
    }
    return entries
  }, [parsedConfig])

  const totalConfigured = useMemo(() => allConfiguredHookCount(parsedConfig ?? {}), [parsedConfig])

  // ── Fetch + WS ──────────────────────────────────────────────────
  useEffect(() => {
    const ac = new AbortController()
    api.get<HooksResponse>(`/sessions/${session.id}/hooks`, { signal: ac.signal })
      .then((data) => {
        setText(formatHooks(data.hooks ?? {}))
        setRuns((data.runs ?? []).slice().reverse())
        setDirty(false)
      })
      .catch((err) => {
        if (!ac.signal.aborted) setError(formatError(err))
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false)
      })
    return () => { ac.abort() }
  }, [session.id])

  useEffect(() => {
    const unsubscribe = hub.subscribe(session.id)
    const removeListener = hub.addSessionListener(session.id, (frame) => {
      if (frame.kind !== 'hook-run') return
      setRuns((prev) => upsertRun(prev, frame.event))
    })
    return () => {
      removeListener()
      unsubscribe()
    }
  }, [hub, session.id])

  // ── Actions ─────────────────────────────────────────────────────
  const applyConfig = useCallback(async (configText: string) => {
    let hooks: unknown
    try {
      hooks = JSON.parse(configText)
    } catch (err) {
      setError(`Invalid JSON: ${formatError(err)}`)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const result = await api.put<{ session: SessionInfo; hooks: SessionHooksConfig }>(
        `/sessions/${session.id}/hooks`,
        { hooks },
      )
      setText(formatHooks(result.hooks ?? {}))
      setDirty(false)
      onSessionUpdate(result.session)
    } catch (err) {
      setError(formatError(err))
    } finally {
      setSaving(false)
    }
  }, [onSessionUpdate, session.id])

  const handleTextChange = useCallback((value: string) => {
    setText(value)
    setDirty(true)
  }, [])

  const toggleEvent = useCallback((event: HookEvent) => {
    try {
      const parsed = JSON.parse(text) as SessionHooksConfig
      if (parsed[event] && parsed[event]!.length > 0) {
        delete parsed[event]
      } else {
        parsed[event] = [{ hooks: [] }]
      }
      setText(formatHooks(parsed))
      setDirty(true)
      setError(null)
    } catch (err) {
      setError(`Invalid JSON: ${formatError(err)}`)
    }
  }, [text])

  const removeMatcher = useCallback((event: HookEvent, matcherIdx: number) => {
    try {
      const parsed = JSON.parse(text) as SessionHooksConfig
      const matchers = parsed[event]
      if (!matchers) return
      matchers.splice(matcherIdx, 1)
      if (matchers.length === 0) delete parsed[event]
      setText(formatHooks(parsed))
      setDirty(true)
      setError(null)
    } catch (err) {
      setError(`Invalid JSON: ${formatError(err)}`)
    }
  }, [text])

  const insertTemplate = useCallback(() => {
    setText(formatHooks({
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'echo "PreToolUse: $CLAUDE_TOOL_NAME"', timeout: 10 }],
        },
      ],
    }))
    setDirty(true)
    setError(null)
  }, [])

  if (loading) {
    return (
      <div className="settings-section">
        <div className="settings-note">Loading hooks…</div>
      </div>
    )
  }

  return (
    <>
      {/* ── Configured Hooks ──────────────────────────────────────── */}
      <div className="settings-section">
        <div className="settings-section-head">
          <h4>Configured Hooks</h4>
        </div>

        {configuredEntries.length > 0 ? (
          <div className="hooks-config-list">
            {configuredEntries.map(({ event, matcherIdx, matcher }) => (
              <div key={`${event}-${matcherIdx}`} className="hooks-config-card">
                <div className="hooks-config-head">
                  <span className="hooks-event-tag">{event}</span>
                  {matcher.matcher && (
                    <span className="hooks-matcher" title={matcher.matcher}>
                      {matcher.matcher}
                    </span>
                  )}
                  <span style={{ display: 'flex', gap: 3, flex: 1 }}>
                    {matcher.hooks.map((hook, hi) => (
                      <span key={hi} className="hooks-type-badge">{hook.type}</span>
                    ))}
                  </span>
                  <div className="hooks-config-actions">
                    <button
                      className="btn btn-xs"
                      onClick={() => removeMatcher(event, matcherIdx)}
                      disabled={disabled || saving}
                      title="Remove this matcher"
                    >
                      Remove
                    </button>
                  </div>
                </div>
                <div className="hooks-config-detail">
                  {matcher.hooks.map((hook, hi) => (
                    <div key={hi}>
                      {'command' in hook && hook.command && (
                        <div className="hooks-detail-row">
                          <span className="hooks-detail-label">command</span>
                          <span className="hooks-detail-value">{hook.command}</span>
                        </div>
                      )}
                      {'url' in hook && hook.url && (
                        <div className="hooks-detail-row">
                          <span className="hooks-detail-label">url</span>
                          <span className="hooks-detail-value">{hook.url}</span>
                        </div>
                      )}
                      {'prompt' in hook && hook.prompt && (
                        <div className="hooks-detail-row">
                          <span className="hooks-detail-label">prompt</span>
                          <span className="hooks-detail-value">{hook.prompt}</span>
                        </div>
                      )}
                      {hook.timeout != null && (
                        <div className="hooks-detail-row">
                          <span className="hooks-detail-label">timeout</span>
                          <span className="hooks-detail-value">{hook.timeout}s</span>
                        </div>
                      )}
                      {'shell' in hook && hook.shell && (
                        <div className="hooks-detail-row">
                          <span className="hooks-detail-label">shell</span>
                          <span className="hooks-detail-value">{hook.shell}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="settings-empty-note">No hooks configured</div>
        )}

        {dirty && (
          <button
            className="btn btn-sm btn-primary settings-apply-btn"
            onClick={() => applyConfig(text)}
            disabled={disabled || saving}
          >
            {saving ? 'Applying…' : 'Apply changes'}
          </button>
        )}
      </div>

      {/* ── Available Events ──────────────────────────────────────── */}
      <div className="settings-section">
        <div className="settings-section-head">
          <h4>Available Events</h4>
        </div>
        <div className="settings-note">
          Click an event to toggle it. {totalConfigured > 0 && `${totalConfigured} hook${totalConfigured === 1 ? '' : 's'} configured.`}
        </div>
        <div className="hooks-categories">
          {EVENT_CATEGORIES.map((cat, ci) => {
            const count = categoryCounts[ci].total
            return (
              <AnimatedDetails
                key={cat.label}
                className="hooks-category"
                summary={
                  <>
                    {cat.label}
                    <span className={`hooks-category-count${count > 0 ? ' has-hooks' : ''}`}>
                      {count > 0 ? `${count}` : '0'}
                    </span>
                  </>
                }
              >
                <div className="hooks-event-grid">
                  {cat.events.map((event) => {
                    const config = parsedConfig ?? {}
                    const hasHooks = totalHookCount(config[event]) > 0
                    return (
                      <button
                        key={event}
                        type="button"
                        className={`hooks-event-badge${hasHooks ? ' active' : ''}`}
                        onClick={() => toggleEvent(event)}
                        disabled={disabled || saving}
                        aria-pressed={hasHooks}
                        title={hasHooks ? `Click to remove ${event}` : `Click to add ${event}`}
                      >
                        {event}
                      </button>
                    )
                  })}
                </div>
              </AnimatedDetails>
            )
          })}
        </div>
      </div>

      {/* ── Raw JSON Editor ───────────────────────────────────────── */}
      <div className="settings-section">
        <div className="settings-section-head">
          <h4>Advanced</h4>
          <div className="settings-section-head-actions">
            <button className="btn btn-sm" onClick={insertTemplate} disabled={disabled || saving}>
              Template
            </button>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => applyConfig(text)}
              disabled={disabled || saving || loading}
            >
              {saving ? 'Applying…' : 'Apply hooks'}
            </button>
          </div>
        </div>
        {dirty && <span className="hint" style={{ fontSize: 'var(--fs-xs)' }}>Unsaved changes</span>}
        <AnimatedDetails className="hooks-json-toggle" summary="Raw JSON editor">
          <textarea
            className="textarea"
            value={text}
            onChange={(e) => handleTextChange(e.target.value)}
            rows={14}
            spellCheck={false}
            disabled={disabled || saving || loading}
            style={{ marginTop: 6 }}
          />
        </AnimatedDetails>
        {error && <div className="settings-card-error" style={{ marginTop: 6 }}>{error}</div>}
      </div>

      {/* ── Hook Activity ─────────────────────────────────────────── */}
      <div className="settings-section">
        <div className="settings-section-head">
          <h4>Hook Activity</h4>
        </div>
        {runs.length === 0 && <div className="settings-empty-note">No hook runs yet</div>}
        {runs.map((run) => {
          const meta = STATUS_META[run.status] ?? STATUS_META.cancelled
          return (
            <div key={run.id} className="hooks-activity-card">
              <div className="hooks-activity-head">
                <span className="hooks-activity-dot" style={{ '--dot': meta.color } as React.CSSProperties} />
                <span className="hooks-activity-name">{run.hookName}</span>
                <span className="hooks-event-tag">{run.event}</span>
                <span className={`hooks-activity-status ${meta.cls}`}>{run.status}</span>
                {run.exitCode != null && run.exitCode !== 0 && (
                  <span className="hooks-activity-status error">exit {run.exitCode}</span>
                )}
                <span className="hooks-activity-time">{formatTime(run.updatedAt || run.startedAt)}</span>
              </div>
              {(run.output || run.stdout || run.stderr) && (
                <pre className="hooks-activity-output">
                  {run.output || run.stdout || run.stderr}
                </pre>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
