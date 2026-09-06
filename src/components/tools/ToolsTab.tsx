import { useEffect, useState } from 'react'
import type { SessionToolProfile } from '../../../shared/tool-profile'
import { api } from '../../hooks/useApi'
import { useToast } from '../../hooks/useToast'

/** First-party built-in tools a session can enable / allow / disallow. The
 *  list is illustrative — unknown names are forwarded to the SDK verbatim. */
const BUILTIN_TOOLS = [
  'Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'Grep', 'Glob',
  'WebFetch', 'WebSearch', 'AskUserQuestion', 'ExitPlanMode',
  'TodoWrite', 'Agent', 'Task', 'Skill',
]

function toList(s: string): string[] {
  return s.split(',').map((x) => x.trim()).filter(Boolean)
}
function fromList(xs?: string[]): string {
  return xs?.length ? xs.join(', ') : ''
}

interface Props {
  sessionId: string
}

/** Per-session built-in tool surface.
 *
 *  The tool surface (tools / allowedTools / disallowedTools / toolAliases /
 *  toolConfig) is spawn-time-only: the SDK has no Settings key for it, so a
 *  change takes effect the NEXT time this session is cleared or a fork is
 *  taken (both carry the profile), not mid-turn. Note: the profile is RAM-only
 *  (mirroring the skill-override precedent) — it is dropped if the session is
 *  unloaded and re-adopted from disk. Permission RULES (allow/deny/ask) are
 *  intentionally not surfaced here: the SDK's flag layer replaces the whole
 *  `permissions` object and there is no reliable read-back, so a partial
 *  editor would silently drop rules it didn't know about. */
export default function ToolsTab({ sessionId }: Props) {
  const toast = useToast()
  const [tools, setTools] = useState('')
  const [allowed, setAllowed] = useState('')
  const [disallowed, setDisallowed] = useState('')
  const [aliases, setAliases] = useState('')
  const [config, setConfig] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .get<{ toolProfile?: SessionToolProfile }>(`/sessions/${sessionId}/tool-profile`)
      .then((r) => {
        if (cancelled) return
        const p = r.toolProfile
        setTools(fromList(p?.tools))
        setAllowed(fromList(p?.allowedTools))
        setDisallowed(fromList(p?.disallowedTools))
        setAliases(p?.toolAliases ? JSON.stringify(p.toolAliases, null, 2) : '')
        setConfig(p?.toolConfig ? JSON.stringify(p.toolConfig, null, 2) : '')
      })
      .catch(() => { /* non-fatal — leave fields empty */ })
    return () => { cancelled = true }
  }, [sessionId])

  const saveProfile = async () => {
    // Omit blank fields rather than send `[]` — an empty `tools` list means
    // "disable ALL built-in tools" to the SDK, the opposite of "inherit
    // defaults". A fully-blank form therefore sends an empty object, which the
    // server treats as "no profile" (i.e. reset to defaults).
    const profile: SessionToolProfile = {}
    if (tools.trim()) profile.tools = toList(tools)
    if (allowed.trim()) profile.allowedTools = toList(allowed)
    if (disallowed.trim()) profile.disallowedTools = toList(disallowed)
    if (aliases.trim()) {
      try {
        const parsed = JSON.parse(aliases) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be a JSON object')
        profile.toolAliases = parsed as Record<string, string>
      } catch (e) {
        toast.error(`toolAliases must be a JSON object: ${(e as Error).message}`)
        return
      }
    }
    if (config.trim()) {
      try {
        const parsed = JSON.parse(config) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be a JSON object')
        profile.toolConfig = parsed as Record<string, unknown>
      } catch (e) {
        toast.error(`toolConfig must be a JSON object: ${(e as Error).message}`)
        return
      }
    }
    setSaving(true)
    try {
      await api.put<{ session: unknown }>(`/sessions/${sessionId}/tool-profile`, { toolProfile: profile })
      toast.success('Tool surface saved. It applies the next time this session is cleared or forked.')
    } catch (e) {
      toast.error(`Couldn't save tool surface: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="tools-tab settings-section">
      <h4>Built-in tool surface</h4>
      <p className="settings-hint">
        Restrict which built-in tools this session sees. Applies the next time this session is
        cleared or forked (spawn-time — the SDK has no runtime setting for it), and resets if the
        session is unloaded and re-adopted from disk.
      </p>
      <label className="field-label">tools (comma-separated, empty = default)</label>
      <input value={tools} onChange={(e) => setTools(e.target.value)} placeholder={BUILTIN_TOOLS.join(', ')} />
      <label className="field-label">allowedTools (auto-allow without prompting)</label>
      <input value={allowed} onChange={(e) => setAllowed(e.target.value)} placeholder="Edit, Read" />
      <label className="field-label">disallowedTools (removed from context)</label>
      <input value={disallowed} onChange={(e) => setDisallowed(e.target.value)} placeholder="WebFetch" />
      <label className="field-label">toolAliases (JSON object, e.g. {"{ \"Bash\": \"mcp__ws__bash\" }"})</label>
      <textarea value={aliases} onChange={(e) => setAliases(e.target.value)} rows={3} />
      <label className="field-label">toolConfig (JSON object, e.g. {"{ \"askUserQuestion\": { \"previewFormat\": \"html\" } }"})</label>
      <textarea value={config} onChange={(e) => setConfig(e.target.value)} rows={3} />
      <button className="btn btn-sm" onClick={() => void saveProfile()} disabled={saving}>
        {saving ? 'Saving…' : 'Save tool surface'}
      </button>
    </div>
  )
}