import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../hooks/useApi'
import { useNotifications } from '../hooks/useNotifications'
import { notificationTooltip } from '../utils/notifications'

interface Props {
  onConfigured: () => void
}

/** Same defaults as server/config.ts so the setup page doesn't need an
 *  extra round-trip just to show the scaffold values. */
const DEFAULT_MODELS = [
  'anthropic/claude-sonnet-4-20250514',
  'claude-opus-4-20250514',
  'claude-haiku-3-5-20241022',
]

export function SetupPage({ onConfigured }: Props) {
  const [authToken, setAuthToken] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  // Track whether the visible value came from ~/.claude/settings.json so
  // we can show a "Pre-filled from ..." hint until the user edits it.
  const [tokenPrefilled, setTokenPrefilled] = useState(false)
  const [baseUrlPrefilled, setBaseUrlPrefilled] = useState(false)

  // ── Model configuration ──
  const [showModels, setShowModels] = useState(false)
  const [modelList, setModelList] = useState<string[]>(DEFAULT_MODELS.slice())
  const [newModel, setNewModel] = useState('')
  const [recapModel, setRecapModel] = useState('')
  const [commitMessageModel, setCommitMessageModel] = useState('')
  const [duplicateMsg, setDuplicateMsg] = useState<string | null>(null)

  // Pre-fill from ~/.claude/settings.json if available.
  useEffect(() => {
    void api
      .get<{ authToken?: string; baseUrl?: string }>('/config/claude-defaults')
      .then((r) => {
        if (r.authToken) {
          setAuthToken(r.authToken)
          setTokenPrefilled(true)
        }
        if (r.baseUrl) {
          setBaseUrl(r.baseUrl)
          setBaseUrlPrefilled(true)
        }
      })
      .catch(() => {})
  }, [])
  const [showToken, setShowToken] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tokenInputRef = useRef<HTMLInputElement>(null)

  // Desktop notifications — opt-in, decoupled from form submit. Persistence
  // lives in localStorage (handled by the hook), so we don't need to thread
  // anything through /config/setup.
  const notifications = useNotifications()

  const addModel = () => {
    const m = newModel.trim()
    if (!m) return
    if (modelList.includes(m)) {
      setDuplicateMsg(`Already added: ${m}`)
      window.setTimeout(() => setDuplicateMsg(null), 2500)
      return
    }
    setModelList([...modelList, m])
    setNewModel('')
    setDuplicateMsg(null)
  }

  const removeModel = (model: string) => {
    setModelList(modelList.filter((m) => m !== model))
    if (recapModel === model) setRecapModel('')
    if (commitMessageModel === model) setCommitMessageModel('')
  }

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!authToken.trim()) {
        setError('Auth token is required')
        tokenInputRef.current?.focus()
        return
      }
      setLoading(true)
      setError(null)
      try {
        await api.post('/config/setup', {
          authToken: authToken.trim(),
          baseUrl: baseUrl.trim() || undefined,
          modelList: modelList.length > 0 ? modelList : undefined,
          recapModel: recapModel.trim() || undefined,
          commitMessageModel: commitMessageModel.trim() || undefined,
        })
        onConfigured()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save config')
        // Most failure modes (invalid token, network rejected by relay) point
        // back at the token field, so return focus there for keyboard users.
        tokenInputRef.current?.focus()
      } finally {
        setLoading(false)
      }
    },
    [authToken, baseUrl, modelList, recapModel, commitMessageModel, onConfigured],
  )

  return (
    <div style={styles.container}>
      {/* Inline keyframe so we don't have to touch styles.css for one
       *  spinner. Honors prefers-reduced-motion (rule: reduced-motion). */}
      <style>{`
        @keyframes setup-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
          .setup-spinner { animation: none !important; }
        }
      `}</style>
      <div style={styles.card}>
        <h1 style={styles.title}>Welcome to Claude Web</h1>
        <p style={styles.subtitle}>
          Configure your Anthropic API credentials to get started.
        </p>

        <form onSubmit={handleSubmit} style={styles.form}>
          <div style={styles.field}>
            <label style={styles.label} htmlFor="auth-token">
              Auth Token <span style={styles.required} aria-hidden="true">*</span>
            </label>
            <p id="auth-token-hint" style={styles.hint}>
              Your Anthropic API key. You can find it at{' '}
              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noopener noreferrer"
                style={styles.link}
              >
                console.anthropic.com
              </a>
            </p>
            <div style={styles.tokenRow}>
              <input
                ref={tokenInputRef}
                id="auth-token"
                type={showToken ? 'text' : 'password'}
                value={authToken}
                onChange={(e) => {
                  setAuthToken(e.target.value)
                  setTokenPrefilled(false)
                }}
                placeholder="sk-ant-..."
                style={styles.input}
                autoFocus
                aria-required="true"
                aria-invalid={error ? true : undefined}
                aria-describedby={
                  error ? 'auth-token-hint auth-token-error' : 'auth-token-hint'
                }
                // API keys aren't passwords — don't offer to save / autofill.
                autoComplete="off"
                // Mobile keyboards default to capitalising the first letter
                // and applying autocorrect, which mangles `sk-ant-...`.
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                style={styles.toggleBtn}
                title={showToken ? 'Hide token' : 'Show token'}
                aria-pressed={showToken}
              >
                {showToken ? 'Hide' : 'Show'}
              </button>
            </div>
            {tokenPrefilled && (
              <p style={styles.prefilledHint}>
                Pre-filled from{' '}
                <code style={styles.code}>~/.claude/settings.json</code>. Edit
                to override.
              </p>
            )}
            {error && (
              <p id="auth-token-error" role="alert" style={styles.fieldError}>
                {error}
              </p>
            )}
          </div>

          <div style={styles.field}>
            <label style={styles.label} htmlFor="base-url">
              Base URL <span style={styles.optional}>(optional)</span>
            </label>
            <p id="base-url-hint" style={styles.hint}>
              Override the API endpoint if using a proxy or relay. Defaults to{' '}
              <code style={styles.code}>https://api.anthropic.com</code>.
            </p>
            <input
              id="base-url"
              type="url"
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value)
                setBaseUrlPrefilled(false)
              }}
              placeholder="https://api.anthropic.com"
              style={styles.input}
              aria-describedby="base-url-hint"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            {baseUrlPrefilled && (
              <p style={styles.prefilledHint}>
                Pre-filled from{' '}
                <code style={styles.code}>~/.claude/settings.json</code>. Edit
                to override.
              </p>
            )}
          </div>

          {/* ── Model configuration (collapsible) ── */}
          <div style={styles.field}>
            <button
              type="button"
              onClick={() => setShowModels(!showModels)}
              style={styles.sectionToggle}
            >
              <span>{showModels ? '▾' : '▸'} Model Configuration</span>
              <span style={styles.optional}>
                {showModels ? 'collapse' : 'expand'}
              </span>
            </button>

            {showModels && (
              <div style={styles.sectionBody}>
                <div style={styles.field}>
                  <label style={styles.label}>Available Models</label>
                  <p style={styles.hint}>
                    First model is the default. Add model IDs one at a time.
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {modelList.map((m, i) => (
                      <div key={m} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span style={{
                          fontSize: 11, color: 'var(--fg-muted)', width: 18, textAlign: 'right', flexShrink: 0,
                        }}>
                          {i === 0 ? '★' : ''}
                        </span>
                        <code style={{
                          flex: 1, fontSize: 12, padding: '4px 8px',
                          background: 'var(--bg-elev-2)', border: '1px solid var(--border)', borderRadius: 4,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {m}
                        </code>
                        <button
                          type="button"
                          className="btn"
                          style={styles.smallIconBtn}
                          onClick={() => removeModel(m)}
                          title="Remove"
                          aria-label={`Remove ${m}`}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      <input
                        className="input"
                        style={{ flex: 1, fontSize: 16, minHeight: 32 }}
                        value={newModel}
                        onChange={(e) => setNewModel(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addModel() } }}
                        placeholder="model-id (e.g. claude-sonnet-4-20250514)"
                      />
                      <button
                        type="button"
                        className="btn"
                        style={styles.smallAddBtn}
                        onClick={addModel}
                      >
                        Add
                      </button>
                    </div>
                    {duplicateMsg && (
                      <p role="status" style={styles.duplicateMsg}>
                        {duplicateMsg}
                      </p>
                    )}
                  </div>
                </div>

                <div style={styles.field}>
                  <label style={styles.label}>
                    Recap Model <span style={styles.optional}>(optional)</span>
                  </label>
                  <p style={styles.hint}>
                    Model used for AI session summaries. Leave empty to use the default (first model).
                  </p>
                  <select
                    className="input"
                    value={recapModel}
                    onChange={(e) => setRecapModel(e.target.value)}
                  >
                    <option value="">(default)</option>
                    {modelList.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>

                <div style={styles.field}>
                  <label style={styles.label}>
                    Commit Message Model <span style={styles.optional}>(optional)</span>
                  </label>
                  <p style={styles.hint}>
                    Model used for AI-generated commit messages in the Git panel. Leave empty to use the default.
                  </p>
                  <select
                    className="input"
                    value={commitMessageModel}
                    onChange={(e) => setCommitMessageModel(e.target.value)}
                  >
                    <option value="">(default)</option>
                    {modelList.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>

          {/* ── Desktop notifications (last step, opt-in) ── */}
          <div style={styles.field}>
            <label style={styles.label}>
              Desktop Notifications <span style={styles.optional}>(optional)</span>
            </label>
            <p style={styles.hint}>
              Get notified when Claude finishes a turn while this tab is in
              the background. You can toggle this later from the bell icon in
              the header.
            </p>
            {notifications.permission === 'denied' ? (
              <p style={styles.hint}>
                Notifications are blocked. Enable them in your browser's site
                settings, then reload.
              </p>
            ) : (
              <button
                type="button"
                className={`btn btn-icon ${notifications.enabled ? 'active' : ''}`}
                onClick={() => void notifications.toggle()}
                title={notificationTooltip(notifications.permission, notifications.enabled)}
                disabled={notifications.permission === 'unsupported'}
                aria-label="Toggle desktop notifications"
                style={{ alignSelf: 'flex-start' }}
              >
                {notifications.enabled ? '🔔' : '🔕'}
              </button>
            )}
          </div>

          {/* ── First-session guidance (last step, info only) ── */}
          <div style={styles.field}>
            <label style={styles.label}>First Session</label>
            <p style={styles.hint}>
              After saving, click{' '}
              <code style={styles.code}>+ New session</code> in the left
              sidebar (or press{' '}
              <kbd style={styles.kbd}>Alt</kbd>+<kbd style={styles.kbd}>N</kbd>)
              {' '}to start chatting with Claude. You can drop a folder onto
              the button to pre-fill the working directory.
            </p>
          </div>

          <button
            type="submit"
            disabled={loading || !authToken.trim()}
            aria-busy={loading || undefined}
            style={{
              ...styles.submitBtn,
              ...(loading || !authToken.trim() ? styles.submitBtnDisabled : {}),
            }}
          >
            {loading && (
              <span
                className="setup-spinner"
                style={styles.spinner}
                aria-hidden="true"
              />
            )}
            {loading ? 'Saving…' : 'Save & Continue'}
          </button>
        </form>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg)',
    fontFamily: 'inherit',
    zIndex: 9999,
    // Allow vertical scroll when content is taller than viewport (e.g.
    // Model Configuration expanded on a short laptop screen).
    overflowY: 'auto',
    // Gutter so the card never bumps into viewport edges on small screens.
    padding: 16,
    boxSizing: 'border-box',
  },
  card: {
    width: '100%',
    maxWidth: 480,
    padding: '40px 36px',
    background: 'var(--bg-elev)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    // Without this, width:100% + padding:36px overflows the container on
    // narrow screens (CSS default is content-box).
    boxSizing: 'border-box',
  },
  title: {
    margin: '0 0 8px',
    fontSize: 22,
    fontWeight: 600,
    color: 'var(--fg)',
  },
  subtitle: {
    margin: '0 0 28px',
    fontSize: 14,
    color: 'var(--fg-muted)',
    lineHeight: 1.5,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--fg)',
  },
  required: {
    color: 'var(--danger)',
  },
  optional: {
    fontWeight: 400,
    color: 'var(--fg-muted)',
    fontSize: 12,
  },
  hint: {
    margin: 0,
    fontSize: 12,
    color: 'var(--fg-muted)',
    lineHeight: 1.4,
  },
  link: {
    color: 'var(--accent)',
    textDecoration: 'none',
  },
  code: {
    fontFamily: 'var(--mono)',
    fontSize: 11,
    padding: '1px 5px',
    background: 'var(--bg-elev-2)',
    borderRadius: 4,
  },
  tokenRow: {
    display: 'flex',
    gap: 8,
  },
  input: {
    flex: 1,
    padding: '10px 12px',
    // 16px prevents iOS Safari from auto-zooming on focus. Anything < 16
    // triggers the zoom-to-readable behaviour.
    fontSize: 16,
    fontFamily: 'var(--mono)',
    background: 'var(--bg-elev-2)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    color: 'var(--fg)',
    // ≥44px tall to satisfy touch-friendly-input on mobile (Apple HIG
    // 44pt / Material 48dp).
    minHeight: 44,
    boxSizing: 'border-box',
    // No `outline: none` — let the global :focus-visible rule paint a
    // 2px accent ring on keyboard focus (styles.css). Mouse focus is
    // suppressed by `:focus:not(:focus-visible)` already.
  },
  toggleBtn: {
    padding: '0 14px',
    fontSize: 12,
    fontFamily: 'inherit',
    background: 'var(--bg-elev-2)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    color: 'var(--fg-muted)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    // Match input height — 44px touch target.
    minHeight: 44,
    boxSizing: 'border-box',
  },
  error: {
    padding: '8px 12px',
    fontSize: 13,
    color: 'var(--msg-error-fg)',
    background: 'var(--msg-error-bg)',
    border: '1px solid var(--msg-error-border)',
    borderRadius: 6,
  },
  submitBtn: {
    // ≥44px tall — primary CTA must satisfy touch target standards.
    minHeight: 44,
    padding: '0 16px',
    fontSize: 14,
    fontWeight: 600,
    fontFamily: 'inherit',
    background: 'var(--accent)',
    border: 'none',
    borderRadius: 6,
    color: 'var(--on-accent)',
    cursor: 'pointer',
    transition: 'opacity 0.15s',
    // Center the spinner + label.
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  submitBtnDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  sectionToggle: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    // ≥44px tall — the chevron+label is a tap target.
    minHeight: 44,
    padding: '0 4px',
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--fg)',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
  },
  sectionBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    paddingTop: 4,
  },
  prefilledHint: {
    margin: '4px 0 0',
    fontSize: 11,
    color: 'var(--fg-muted)',
    lineHeight: 1.4,
  },
  fieldError: {
    margin: '4px 0 0',
    fontSize: 12,
    color: 'var(--msg-error-fg)',
    lineHeight: 1.4,
  },
  duplicateMsg: {
    margin: '6px 0 0',
    fontSize: 11,
    color: 'var(--fg-muted)',
    lineHeight: 1.4,
  },
  // Big enough to hit on touch (~32px) without dwarfing the row. Smaller
  // than 44pt because it lives inside a tight model-list row, but
  // surrounding row padding keeps mis-tap risk low.
  smallIconBtn: {
    width: 32,
    height: 32,
    minWidth: 32,
    fontSize: 12,
    padding: 0,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  smallAddBtn: {
    minHeight: 32,
    padding: '0 12px',
    fontSize: 12,
    flexShrink: 0,
    cursor: 'pointer',
  },
  kbd: {
    fontFamily: 'var(--mono)',
    fontSize: 11,
    padding: '1px 5px',
    background: 'var(--bg-elev-2)',
    border: '1px solid var(--border)',
    borderBottomWidth: 2,
    borderRadius: 4,
    color: 'var(--fg)',
  },
  spinner: {
    width: 14,
    height: 14,
    borderRadius: '50%',
    // Translucent track + opaque arc gives the classic ring spinner look
    // without an extra SVG.
    border: '2px solid rgba(255, 255, 255, 0.35)',
    borderTopColor: 'var(--on-accent)',
    animation: 'setup-spin 0.7s linear infinite',
    flexShrink: 0,
  },
}
