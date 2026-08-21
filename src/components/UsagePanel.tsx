// Per-session Usage overlay — the structured data behind the CLI's
// `/usage` command: session cost / duration / line totals, a per-model
// token+cost table, and (for claude.ai plan sessions) rate-limit window
// meters. Mounted like GitPanel: Chat.tsx wraps us in a `.git-overlay`
// backdrop (variant="git"), so we reuse the `.git-panel` chrome classes
// and only define `.usage-*` content styles.
//
// The backing SDK API is EXPERIMENTAL — every read is defensive
// (`typeof` checks, optional chaining) and unknown fields are ignored.

import { memo, useEffect } from 'react'
import { Tooltip } from './Tooltip'
import { IconX, IconRefresh, IconDollar, IconLoader } from './icons/ToolIcons'
import { formatTokens, formatElapsed } from '../utils/format'
import { useOverlayScrollbar } from '../hooks/useOverlayScrollbar'
import {
  USAGE_WINDOW_KEYS,
  USAGE_WINDOW_LABELS,
  type SessionUsageData,
  type UsageRateLimitWindow,
} from '../../shared/usage'

interface Props {
  sessionId: string
  data: SessionUsageData | null
  loading: boolean
  error: string | null
  onRefresh: () => void
  onClose: () => void
}

const SUBSCRIPTION_LABELS: Record<string, string> = {
  pro: 'Pro',
  max: 'Max',
  team: 'Team',
  enterprise: 'Enterprise',
}

function fmtCost(v: unknown): string | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
    ? `$${v.toFixed(4)}`
    : null
}

function fmtNum(v: unknown): string | null {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : null
}

function levelFor(pct: number): 'ok' | 'warn' | 'danger' {
  return pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok'
}

function WindowMeter({ label, window }: { label: string; window: UsageRateLimitWindow | null | undefined }) {
  // A window can be present-but-null (unknown on the backend) — render a
  // muted "unknown" row rather than hiding it, so users know the window exists.
  const util =
    typeof window?.utilization === 'number' && Number.isFinite(window.utilization)
      ? Math.min(100, Math.max(0, Math.round(window.utilization)))
      : null
  const resets =
    typeof window?.resets_at === 'string' && window.resets_at
      ? new Date(window.resets_at)
      : null
  const resetsText =
    resets && !Number.isNaN(resets.getTime()) ? resets.toLocaleString() : null
  const level = util != null ? levelFor(util) : 'ok'
  return (
    <div className="usage-window">
      <div className="usage-window-head">
        <span className="usage-window-label">{label}</span>
        <span className={`usage-window-pct usage-window-pct-${level}`}>
          {util != null ? `${util}%` : 'unknown'}
        </span>
      </div>
      <div className="usage-meter-track" aria-hidden>
        <div className={`usage-meter-fill usage-meter-fill-${level}`} style={{ width: `${util ?? 0}%` }} />
      </div>
      {resetsText && <div className="usage-window-resets">resets {resetsText}</div>}
    </div>
  )
}

export const UsagePanel = memo(function UsagePanel({
  sessionId, data, loading, error, onRefresh, onClose,
}: Props) {
  const setPanelOs = useOverlayScrollbar({ autoHide: 'leave' })

  // Refetch whenever the panel mounts with a session id (the panel is
  // unmounted when closed, so open == mount == fresh data).
  useEffect(() => {
    if (sessionId) onRefresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onRefresh is stable per sessionId; re-running on identity changes would double-fetch.
  }, [sessionId])

  const totals = data?.session
  const cost = fmtCost(totals?.total_cost_usd)
  const apiDur = typeof totals?.total_api_duration_ms === 'number' ? formatElapsed(totals.total_api_duration_ms) : null
  const wallDur = typeof totals?.total_duration_ms === 'number' ? formatElapsed(totals.total_duration_ms) : null
  const added = fmtNum(totals?.total_lines_added)
  const removed = fmtNum(totals?.total_lines_removed)
  const subLabel = data?.subscription_type ? SUBSCRIPTION_LABELS[data.subscription_type] ?? data.subscription_type : null
  const rateLimits = data?.rate_limits
  const modelEntries = Object.entries(totals?.model_usage ?? {}) as [string, Record<string, unknown>][]
  const extra = rateLimits?.extra_usage

  return (
    <aside className="git-panel usage-panel" role="region" aria-label="Usage" ref={setPanelOs}>
      <header className="git-panel-header">
        <span className="git-panel-branch"><IconDollar size={13} /> usage</span>
        {subLabel && <span className="usage-sub-badge">{subLabel}</span>}
        <span className="git-panel-spacer" />
        <Tooltip label="Refresh" placement="bottom">
          <button
            className="git-panel-icon-btn"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refresh usage"
          >
            {loading
              ? <IconLoader size={14} className="git-panel-spin" />
              : <IconRefresh size={14} />}
          </button>
        </Tooltip>
        <Tooltip label="Close" placement="bottom">
          <button className="git-panel-icon-btn" onClick={onClose} aria-label="Close usage panel"><IconX size={14} /></button>
        </Tooltip>
      </header>

      <div className="usage-body">
        {error && (
          <div className="usage-error">
            <p>{error}</p>
            <button className="usage-action" onClick={onRefresh}>Try again</button>
          </div>
        )}

        {!error && !data && (
          <div className="usage-empty"><p>{loading ? 'Loading usage…' : 'No usage data yet.'}</p></div>
        )}

        {data && (
          <>
            <section className="usage-section">
              <div className="usage-cost-row">
                <span className="usage-cost">{cost ?? '$0.0000'}</span>
                <span className="usage-cost-caption">session total</span>
              </div>
              <div className="usage-totals">
                {wallDur && <span title="Wall-clock session duration">{wallDur} total</span>}
                {apiDur && <span title="Time spent on API calls">{apiDur} api</span>}
                {added != null && removed != null && (
                  <span title="Lines added / removed this session">+{added} −{removed} lines</span>
                )}
              </div>
            </section>

            {modelEntries.length > 0 && (
              <section className="usage-section">
                <h3 className="usage-section-title">By model</h3>
                <table className="usage-model-table">
                  <thead>
                    <tr><th>model</th><th>in</th><th>out</th><th>cache</th><th>cost</th></tr>
                  </thead>
                  <tbody>
                    {modelEntries.map(([model, m]) => {
                      const get = (k: string): number | null =>
                        typeof m[k] === 'number' && Number.isFinite(m[k] as number) ? (m[k] as number) : null
                      const inTok = get('inputTokens')
                      const outTok = get('outputTokens')
                      const cacheTok = (get('cacheReadInputTokens') ?? 0) + (get('cacheCreationInputTokens') ?? 0)
                      const mCost = fmtCost(m.costUSD)
                      return (
                        <tr key={model}>
                          <td className="usage-model-name" title={model}>{model}</td>
                          <td>{inTok != null ? formatTokens(inTok) : '—'}</td>
                          <td>{outTok != null ? formatTokens(outTok) : '—'}</td>
                          <td>{cacheTok > 0 ? formatTokens(cacheTok) : '—'}</td>
                          <td>{mCost ?? '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </section>
            )}

            <section className="usage-section">
              <h3 className="usage-section-title">Plan rate limits</h3>
              {data.rate_limits_available ? (
                <>
                  {USAGE_WINDOW_KEYS.map((key) => (
                    <WindowMeter
                      key={key}
                      label={USAGE_WINDOW_LABELS[key]}
                      window={rateLimits?.[key]}
                    />
                  ))}
                  {extra && (extra.is_enabled ?? true) && (
                    <div className="usage-extra">
                      extra usage: {fmtNum(extra.used_credits) ?? '—'} / {fmtNum(extra.monthly_limit) ?? '—'}{' '}
                      {extra.currency ?? ''}
                      {typeof extra.utilization === 'number' && ` (${Math.round(extra.utilization)}%)`}
                    </div>
                  )}
                </>
              ) : (
                <p className="usage-muted">
                  Plan rate limits are not available for API-key / third-party sessions.
                </p>
              )}
            </section>
          </>
        )}
      </div>
    </aside>
  )
})
