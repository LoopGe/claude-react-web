// Per-session usage content — the structured data behind the CLI's
// `/usage` command: session cost / duration / line totals, a per-model
// token+cost table, and (for claude.ai plan sessions) rate-limit window
// meters. Rendered inside the Session Settings "Usage" tab as a
// `.settings-section` whose head carries the refresh action.
//
// The backing SDK API is EXPERIMENTAL — every read is defensive
// (`typeof` checks, optional chaining) and unknown fields are ignored.

import { memo, useEffect } from 'react'
import { IconLoader } from './icons/ToolIcons'
import { formatTokens, formatElapsed } from '../utils/format'
import {
  USAGE_WINDOW_KEYS,
  USAGE_WINDOW_LABELS,
  type SessionUsageData,
  type UsageRateLimitWindow,
} from '../../shared/usage'
import { ACCOUNT_PROVIDER_LABELS, type AccountInfoData } from '../../shared/account-info'

interface Props {
  sessionId: string
  data: SessionUsageData | null
  /** Authenticated-account info (fetched by the same refresh as `data`;
   *  null when unavailable — it's supplementary and never blocks usage). */
  account?: AccountInfoData | null
  loading: boolean
  error: string | null
  onRefresh: () => void
  /** The server can serve `/usage` right now (session is running and not
   *  terminated). It's a live-Query-only control read, so when unavailable
   *  skip the auto-fetch and show a note instead of an error. Data loaded
   *  before the session went dormant/terminated stays visible. */
  available?: boolean
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
  sessionId,
  data,
  account,
  loading,
  error,
  onRefresh,
  available,
}: Props) {
  // Refetch whenever the panel mounts with a session id (the panel is
  // unmounted when closed, so open == mount == fresh data). Sessions that
  // aren't running (dormant / terminated) can't serve /usage (a live-Query
  // control read), so skip the auto-fetch and let the muted note explain.
  useEffect(() => {
    if (sessionId && available) onRefresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onRefresh is stable per sessionId; re-running on identity changes would double-fetch.
  }, [sessionId, available])

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

  // Account rows — every value is already narrowed server-side, so anything
  // present is displayable. Rows render only when their value exists; a
  // third-party / gateway session typically shows just the backend row.
  const accountSub = account?.subscriptionType
    ? SUBSCRIPTION_LABELS[account.subscriptionType] ?? account.subscriptionType
    : null
  const accountRows: { label: string; value: string; title?: string }[] = []
  if (account?.email) accountRows.push({ label: 'email', value: account.email })
  if (account?.organization) accountRows.push({ label: 'org', value: account.organization })
  if (accountSub) accountRows.push({ label: 'plan', value: accountSub })
  if (account?.apiProvider) {
    const authBits = [account.tokenSource, account.apiKeySource].filter(Boolean).join(' · ')
    accountRows.push({
      label: 'auth',
      value: ACCOUNT_PROVIDER_LABELS[account.apiProvider],
      title: authBits || undefined,
    })
  } else if (account?.tokenSource || account?.apiKeySource) {
    // No known provider enum, but a source is reported — still useful.
    accountRows.push({
      label: 'auth',
      value: [account.tokenSource, account.apiKeySource].filter(Boolean).join(' · '),
    })
  }

  const content = (
    <>
      {!available && !data ? (
        <p className="usage-muted">Usage data is only available for live sessions.</p>
      ) : (
        <>
          {/* Only offer a retry when /usage can actually be served — a
              stale error left over from a live-session refresh shouldn't
              surface once the session has gone dormant/terminated. */}
          {error && available && (
            <div className="usage-error">
              <p>{error}</p>
              <button className="usage-action" onClick={onRefresh}>
                Try again
              </button>
            </div>
          )}

          {!error && !data && (
            <div className="usage-empty">
              <p>{loading ? 'Loading usage…' : 'No usage data yet.'}</p>
            </div>
          )}

          {accountRows.length > 0 && (
            <section className="usage-section usage-account">
              <h3 className="usage-section-title">Account</h3>
              <div className="usage-account-rows">
                {accountRows.map((row) => (
                  <div className="usage-account-row" key={row.label} title={row.title ?? row.value}>
                    <span className="usage-account-label">{row.label}</span>
                    <span className="usage-account-value">{row.value}</span>
                  </div>
                ))}
              </div>
            </section>
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
                    <span title="Lines added / removed this session">
                      +{added} −{removed} lines
                    </span>
                  )}
                </div>
              </section>

              {modelEntries.length > 0 && (
                <section className="usage-section">
                  <h3 className="usage-section-title">By model</h3>
                  <table className="usage-model-table">
                    <thead>
                      <tr>
                        <th>model</th>
                        <th>in</th>
                        <th>out</th>
                        <th>cache</th>
                        <th>cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {modelEntries.map(([model, m]) => {
                        const get = (k: string): number | null =>
                          typeof m[k] === 'number' && Number.isFinite(m[k] as number)
                            ? (m[k] as number)
                            : null
                        const inTok = get('inputTokens')
                        const outTok = get('outputTokens')
                        const cacheTok =
                          (get('cacheReadInputTokens') ?? 0) + (get('cacheCreationInputTokens') ?? 0)
                        const mCost = fmtCost(m.costUSD)
                        return (
                          <tr key={model}>
                            <td className="usage-model-name" title={model}>
                              {model}
                            </td>
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
                      <WindowMeter key={key} label={USAGE_WINDOW_LABELS[key]} window={rateLimits?.[key]} />
                    ))}
                    {extra && (extra.is_enabled ?? true) && (
                      <div className="usage-extra">
                        extra usage: {fmtNum(extra.used_credits) ?? '—'} /{' '}
                        {fmtNum(extra.monthly_limit) ?? '—'} {extra.currency ?? ''}
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
        </>
      )}
    </>
  )

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <span className="settings-section-head-title">
          <h4>Session usage</h4>
          {subLabel && <span className="usage-sub-badge">{subLabel}</span>}
        </span>
        <span className="settings-section-head-actions">
          <button
            className="btn btn-sm"
            onClick={onRefresh}
            disabled={loading || !available}
            aria-label="Refresh usage"
          >
            {loading ? <IconLoader size={12} className="settings-card-spin" /> : 'Refresh'}
          </button>
        </span>
      </div>
      <div className="usage-body">{content}</div>
    </div>
  )
})
