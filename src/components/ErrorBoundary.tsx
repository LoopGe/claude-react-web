// React error boundary — catches render-time exceptions in the subtree
// and shows a recoverable "something went wrong" screen instead of
// blanking the entire app. Resets automatically when `children` identity
// changes (e.g. session switch).

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Optional fallback rendered on error. When omitted, a default
   *  "Something went wrong" screen is shown. */
  fallback?: ReactNode
  /** Called after a render error is caught — useful for logging. */
  onError?: (error: Error, info: ErrorInfo) => void
  /** Explicit reset signal: when provided, error state clears only when
   *  this value changes (e.g. session id, active tab). Use it at mount
   *  points whose parent re-renders frequently — without it, this
   *  component falls back to the legacy "children identity changed"
   *  heuristic, which would retry a crashed subtree on EVERY parent
   *  render (a 12.5 Hz chat panel would crash-loop instead of showing
   *  the recoverable screen). */
  resetKey?: unknown
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info)
  }

  componentDidUpdate(prevProps: Props) {
    // resetKey mode: deterministic reset (session switch, tab switch).
    if (this.props.resetKey !== undefined) {
      if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
        this.setState({ error: null })
      }
      return
    }
    // Legacy reset on children identity change — same key-change-on-error
    // heuristic React uses for <Suspense>.
    if (prevProps.children !== this.props.children && this.state.error) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          padding: 32,
          textAlign: 'center',
          gap: 12,
          color: 'var(--fg)',
          background: 'var(--bg)',
        }}>
          <h2 style={{ margin: 0 }}>Something went wrong</h2>
          <p style={{ color: 'var(--fg-muted)', maxWidth: 480 }}>
            A rendering error occurred. This is likely a bug. Try switching
            sessions or reloading the page.
          </p>
          <pre className="os-hidden" style={{
            textAlign: 'left',
            background: 'var(--bg-elev-2)',
            padding: 12,
            borderRadius: 'var(--radius-sm)',
            color: 'var(--danger-text)',
            fontSize: 'var(--fs-sm)',
            maxWidth: '100%',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
          }}>
            {this.state.error.message}
          </pre>
          <button
            className="btn btn-primary"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
