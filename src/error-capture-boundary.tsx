/**
 * Root error boundary — converts a render crash (the white-screen mechanism)
 * into a visible, copyable diagnostic card and records the component stack
 * that names the culprit. Kept separate from error-capture.ts so this file
 * exports only the component (react-refresh/only-export-components).
 */

import { Component, useState, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'
import { writeClipboard } from './hooks/useCopy'
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
  // The clipboard layer's plain function, not its hook: this screen is the
  // last thing that renders when the app is already broken, so it stays free of
  // context subscriptions and timers. It also needs no toast host — there is
  // none above ToastProvider, which RootErrorBoundary deliberately sits outside.
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle')
  const copyReport = async () => {
    // Serialise the fields the card renders, plus whatever the thrown value
    // contributes. Not `JSON.stringify(crash)` outright: a render crash
    // routinely throws something non-serialisable (a cyclic DOM node, a React
    // element), which would throw and leave nothing — or, with an error-safe
    // fallback, just "[object Object]". `crash.error` is folded in on its own
    // so a cyclic one degrades to a placeholder instead of taking the whole
    // report down with it; an ApiError's own `status`/`code` survive this way.
    const report: Record<string, unknown> = {
      kind: crash.kind,
      at: crash.at,
      message: crash.message,
      componentStack: crash.componentStack,
      stack: crash.stack,
    }
    try {
      // Round-trips through JSON to strip anything unserialisable in place.
      report.error = JSON.parse(JSON.stringify(crash.error))
    } catch {
      report.error = String(crash.error)
    }
    // Report the outcome on the button itself: with no toast host above this
    // screen, a refused write is otherwise indistinguishable from a successful
    // one, and the user pastes stale clipboard content into their bug report
    // believing it holds the crash dump.
    setCopyState((await writeClipboard(JSON.stringify(report, null, 2))) ? 'done' : 'failed')
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
          <span style={{ color: 'var(--danger)', fontSize: 'calc(18px * var(--fs-scale))', lineHeight: 1 }} aria-hidden>
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
          <button type="button" onClick={copyReport} style={btnStyle}>
            {copyState === 'done' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy error'}
          </button>
        </div>
      </div>
    </div>
  )
}
