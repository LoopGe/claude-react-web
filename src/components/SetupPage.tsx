import { useCallback, useEffect, useState } from 'react'
import { api } from '../hooks/useApi'

interface Props {
  onConfigured: () => void
}

export function SetupPage({ onConfigured }: Props) {
  const [authToken, setAuthToken] = useState('')
  const [baseUrl, setBaseUrl] = useState('')

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
        })
        onConfigured()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save config')
      } finally {
        setLoading(false)
      }
    },
    [authToken, baseUrl, onConfigured],
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
}
