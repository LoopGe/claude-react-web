import { useCallback, useEffect, useState } from 'react'
import { api } from '../hooks/useApi'

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

  // ── Model configuration ──
  const [showModels, setShowModels] = useState(false)
  const [modelList, setModelList] = useState<string[]>(DEFAULT_MODELS.slice())
  const [newModel, setNewModel] = useState('')
  const [recapModel, setRecapModel] = useState('')
  const [commitMessageModel, setCommitMessageModel] = useState('')

  // Pre-fill from ~/.claude/settings.json if available.
  useEffect(() => {
    void api
      .get<{ authToken?: string; baseUrl?: string }>('/config/claude-defaults')
      .then((r) => {
        if (r.authToken) setAuthToken(r.authToken)
        if (r.baseUrl) setBaseUrl(r.baseUrl)
      })
      .catch(() => {})
  }, [])
  const [showToken, setShowToken] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const addModel = () => {
    const m = newModel.trim()
    if (!m || modelList.includes(m)) return
    setModelList([...modelList, m])
    setNewModel('')
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
      } finally {
        setLoading(false)
      }
    },
    [authToken, baseUrl, modelList, recapModel, commitMessageModel, onConfigured],
  )

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Welcome to Claude Web</h1>
        <p style={styles.subtitle}>
          Configure your Anthropic API credentials to get started.
        </p>

        <form onSubmit={handleSubmit} style={styles.form}>
          <div style={styles.field}>
            <label style={styles.label} htmlFor="auth-token">
              Auth Token <span style={styles.required}>*</span>
            </label>
            <p style={styles.hint}>
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
                id="auth-token"
                type={showToken ? 'text' : 'password'}
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                placeholder="sk-ant-..."
                style={styles.input}
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                style={styles.toggleBtn}
                title={showToken ? 'Hide token' : 'Show token'}
              >
                {showToken ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          <div style={styles.field}>
            <label style={styles.label} htmlFor="base-url">
              Base URL <span style={styles.optional}>(optional)</span>
            </label>
            <p style={styles.hint}>
              Override the API endpoint if using a proxy or relay. Defaults to{' '}
              <code style={styles.code}>https://api.anthropic.com</code>.
            </p>
            <input
              id="base-url"
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.anthropic.com"
              style={styles.input}
            />
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
                          style={{ padding: '2px 6px', fontSize: 11, flexShrink: 0 }}
                          onClick={() => removeModel(m)}
                          title="Remove"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      <input
                        className="input"
                        style={{ flex: 1, fontSize: 12 }}
                        value={newModel}
                        onChange={(e) => setNewModel(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addModel() } }}
                        placeholder="model-id (e.g. claude-sonnet-4-20250514)"
                      />
                      <button type="button" className="btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={addModel}>
                        Add
                      </button>
                    </div>
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

          {error && <div style={styles.error}>{error}</div>}

          <button type="submit" disabled={loading || !authToken.trim()} style={{
            ...styles.submitBtn,
            ...(loading || !authToken.trim() ? styles.submitBtnDisabled : {}),
          }}>
            {loading ? 'Saving...' : 'Save & Continue'}
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
  },
  card: {
    width: '100%',
    maxWidth: 480,
    padding: '40px 36px',
    background: 'var(--bg-elev)',
    border: '1px solid var(--border)',
    borderRadius: 12,
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
    padding: '8px 12px',
    fontSize: 14,
    fontFamily: 'var(--mono)',
    background: 'var(--bg-elev-2)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    color: 'var(--fg)',
    outline: 'none',
  },
  toggleBtn: {
    padding: '8px 14px',
    fontSize: 12,
    fontFamily: 'inherit',
    background: 'var(--bg-elev-2)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    color: 'var(--fg-muted)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
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
    padding: '10px 0',
    fontSize: 14,
    fontWeight: 600,
    fontFamily: 'inherit',
    background: 'var(--accent)',
    border: 'none',
    borderRadius: 6,
    color: '#fff',
    cursor: 'pointer',
    transition: 'opacity 0.15s',
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
    padding: '8px 0',
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--fg)',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  sectionBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    paddingTop: 4,
  },
}
