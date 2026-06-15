import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../hooks/useApi'
import { useWsHub } from '../hooks/useWsHub'
import type { SessionInfo } from '../types'
import {
  SUPPORTED_HOOK_EVENTS,
  type HookEvent,
  type HookRunRecord,
  type HookRuntimeEvent,
  type SessionHooksConfig,
} from '../../shared/hooks'

interface Props {
  session: SessionInfo
  disabled?: boolean
  onSessionUpdate: (session: SessionInfo) => void
}

interface HooksResponse {
  hooks: SessionHooksConfig
  runs: HookRunRecord[]
}

const EMPTY_TEMPLATE: SessionHooksConfig = {
  PreToolUse: [
    {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'echo "PreToolUse: $CLAUDE_TOOL_NAME"', timeout: 10 }],
    },
  ],
}

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

function hookCount(matchers: unknown): number {
  if (!Array.isArray(matchers)) return 0
  return matchers.reduce((sum, matcher) => {
    if (!matcher || typeof matcher !== 'object') return sum
    const hooks = (matcher as { hooks?: unknown }).hooks
    return sum + (Array.isArray(hooks) ? hooks.length : 0)
  }, 0)
}

export function HooksPanel({ session, disabled, onSessionUpdate }: Props) {
  const [text, setText] = useState('{}')
  const [runs, setRuns] = useState<HookRunRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hub = useWsHub()

  const eventSummary = useMemo(() => {
    try {
      const parsed = JSON.parse(text) as SessionHooksConfig
      return SUPPORTED_HOOK_EVENTS.map((event) => {
        const count = hookCount(parsed[event])
        return { event, count }
      })
    } catch {
      return SUPPORTED_HOOK_EVENTS.map((event) => ({ event, count: 0 }))
    }
  }, [text])

  useEffect(() => {
    let cancelled = false
    api.get<HooksResponse>(`/sessions/${session.id}/hooks`)
      .then((data) => {
        if (cancelled) return
        setText(formatHooks(data.hooks ?? {}))
        setRuns((data.runs ?? []).slice().reverse())
      })
      .catch((err) => {
        if (!cancelled) setError(formatError(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
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

  const apply = useCallback(async () => {
    let hooks: unknown
    try {
      hooks = JSON.parse(text)
    } catch (err) {
      setError(`Invalid JSON: ${formatError(err)}`)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const result = await api.put<{ session: SessionInfo; hooks: SessionHooksConfig }>(`/sessions/${session.id}/hooks`, { hooks })
      setText(formatHooks(result.hooks ?? {}))
      onSessionUpdate(result.session)
    } catch (err) {
      setError(formatError(err))
    } finally {
      setSaving(false)
    }
  }, [onSessionUpdate, session.id, text])

  const insertTemplate = useCallback(() => {
    setText(formatHooks(EMPTY_TEMPLATE))
    setError(null)
  }, [])

  const addEvent = useCallback((event: HookEvent) => {
    try {
      const parsed = JSON.parse(text) as SessionHooksConfig
      if (!parsed[event]) parsed[event] = [{ hooks: [] }]
      setText(formatHooks(parsed))
      setError(null)
    } catch (err) {
      setError(`Invalid JSON: ${formatError(err)}`)
    }
  }, [text])

  return (
    <>
      <div className="settings-section">
        <div className="settings-section-head">
          <h4>Hooks</h4>
          <div className="settings-section-head-actions">
            <button className="btn btn-sm" onClick={insertTemplate} disabled={disabled || saving}>Template</button>
            <button className="btn btn-sm btn-primary" onClick={apply} disabled={disabled || saving || loading}>
              {saving ? 'Applying...' : 'Apply hooks'}
            </button>
          </div>
        </div>
        <div className="settings-note">
          Configure session-scoped Claude Code hooks. Supports command, http, prompt, and agent hooks.
        </div>
        <div className="settings-kv-list">
          {eventSummary.map(({ event, count }) => (
            <button key={event} type="button" className="settings-kv-row" onClick={() => addEvent(event)} disabled={disabled || saving}>
              <code>{event}</code>
              <span className="settings-kv-source">{count} hook{count === 1 ? '' : 's'}</span>
            </button>
          ))}
        </div>
        <textarea
          className="tool-input settings-raw-pre"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={16}
          spellCheck={false}
          disabled={disabled || saving || loading}
        />
        {error && <div className="settings-card-error">{error}</div>}
      </div>

      <div className="settings-section">
        <div className="settings-section-head">
          <h4>Hook activity</h4>
        </div>
        {runs.length === 0 && <div className="settings-empty-note">No hook runs yet</div>}
        {runs.map((run) => (
          <div key={run.id} className="settings-card">
            <div className="settings-card-head">
              <span className="settings-card-name">{run.hookName}</span>
              <span className="settings-card-badge">{run.event}</span>
              <span className="settings-card-meta">{run.status}</span>
            </div>
            {(run.output || run.stdout || run.stderr) && (
              <pre className="tool-input settings-raw-pre">{run.output || run.stdout || run.stderr}</pre>
            )}
          </div>
        ))}
      </div>
    </>
  )
}
