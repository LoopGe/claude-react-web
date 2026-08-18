/**
 * Root error boundary — converts a render crash (the white-screen mechanism)
 * into a visible, copyable diagnostic card and records the component stack
 * that names the culprit. Kept separate from error-capture.ts so this file
 * exports only the component (react-refresh/only-export-components).
 */

import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'
import { crashFrom, recordCrash, type CrashRecord } from './error-capture'

interface RootErrorBoundaryProps {
  children: ReactNode
}

interface RootErrorBoundaryState {
  crash: CrashRecord | null
}

export class RootErrorBoundary extends Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = { crash: null }

  static getDerivedStateFromError(error: unknown): RootErrorBoundaryState {
    return { crash: crashFrom('render', error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // componentDidCatch commits after the fallback renders; fold in the
    // component stack (which component's render threw) and record once here.
    const crash: CrashRecord = {
      ...(this.state.crash ?? crashFrom('render', error)),
      componentStack: info.componentStack ?? undefined,
    }
    this.setState({ crash })
    recordCrash(crash)
  }

  render(): ReactNode {
    if (this.state.crash) {
      return <CrashScreen crash={this.state.crash} onReload={() => location.reload()} />
    }
    return this.props.children
  }
}

// ── Fallback UI ─────────────────────────────────────────────────────

const btnStyle: CSSProperties = {
  padding: '6px 14px',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border)',
  background: 'var(--bg-elev-3)',
  color: 'var(--fg)',
  fontSize: 'var(--fs-sm)',
  fontFamily: 'var(--font-head)',
  cursor: 'pointer',
}

function CrashScreen({ crash, onReload }: { crash: CrashRecord; onReload: () => void }) {
  const copy = () => {
    try {
      void navigator.clipboard?.writeText(JSON.stringify(crash, null, 2))
    } catch {
      /* clipboard unavailable — the console + __crwLastError still have it */
    }
  }
  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'var(--bg)',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 720,
          background: 'var(--bg-elev-2)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-xl)',
          padding: 24,
          boxShadow: 'var(--card-shadow)',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <span style={{ color: 'var(--danger)', fontSize: 18, lineHeight: 1 }} aria-hidden>
            ⚠
          </span>
          <h2
            style={{
              margin: 0,
              color: 'var(--fg)',
              fontSize: 'var(--fs-lg)',
              fontFamily: 'var(--font-head)',
            }}
          >
            Something went wrong
          </h2>
        </div>
        <p style={{ margin: '0 0 12px', color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)' }}>
          The app hit an unexpected error. The details below are also in the console and{' '}
          <code style={{ fontFamily: 'var(--mono)', fontSize: 'var(--fs-xs)' }}>window.__crwLastError</code>.
        </p>
        <pre
          style={{
            margin: 0,
            padding: 12,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--fg)',
            fontSize: 'var(--fs-xs)',
            fontFamily: 'var(--mono)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 320,
            overflow: 'auto',
          }}
        >
          {crash.message}
          {crash.componentStack ? `\n\ncomponentStack:\n${crash.componentStack}` : ''}
          {crash.stack ? `\n\nstack:\n${crash.stack}` : ''}
        </pre>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button type="button" onClick={onReload} style={btnStyle}>
            Reload
          </button>
          <button type="button" onClick={copy} style={btnStyle}>
            Copy error
          </button>
        </div>
      </div>
    </div>
  )
}
