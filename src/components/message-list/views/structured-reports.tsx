// Structured cards for the SDK's `/context` and `/usage` result twins.
//
// The CLI delivers these commands as a synthetic assistant message whose text
// is a markdown table, and (SDK >=0.3.232 for /context, >=0.3.273 for /usage)
// attaches a structured twin on the message wrapper. When the twin is present
// and usable we render it as a card and tuck the markdown into a collapsible
// "Raw output", so the numeric detail is readable and nothing is lost. Both
// components are fully defensive: an unusable payload renders null and the
// caller leaves the markdown in place.

import type { StructuredContextUsage, StructuredUsageReport } from '../../../types'
import { formatTokens } from '../../../utils/format'

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

const pct = (v: number | undefined): string => (v === undefined ? '—' : `${Math.round(v)}%`)

const cost = (v: number | undefined): string => (v === undefined ? '—' : `$${v.toFixed(4)}`)

/** Rows the SDK classifies as real window usage vs. informational. */
function usableCategories(u: StructuredContextUsage): Array<{ name: string; tokens: number; kind: string }> {
  if (!Array.isArray(u.categories)) return []
  const out: Array<{ name: string; tokens: number; kind: string }> = []
  for (const c of u.categories) {
    const tokens = num(c?.tokens)
    if (tokens === undefined) continue
    out.push({ name: typeof c?.name === 'string' ? c.name : '(unnamed)', tokens, kind: c?.kind ?? 'used' })
  }
  return out
}

export function ContextUsageReportCard({ usage }: { usage: StructuredContextUsage }) {
  const total = num(usage.total_tokens)
  const max = num(usage.raw_max_tokens)
  const percentage = num(usage.percentage)
  const rows = usableCategories(usage)
  if (total === undefined && max === undefined && rows.length === 0) return null
  const over = usage.over_limit && num(usage.over_limit.tokens_over) !== undefined

  return (
    <div className="report-card" aria-label="Context usage">
      <div className="report-card-head">
        <span className="report-card-title">Context usage</span>
        <span className="report-card-metric">
          {total !== undefined ? formatTokens(total) : '—'}
          {max !== undefined ? ` / ${formatTokens(max)}` : ''}
          {percentage !== undefined ? ` · ${pct(percentage)}` : ''}
        </span>
      </div>
      {usage.model && <div className="report-card-sub">{usage.model}</div>}
      {over && (
        <div className="report-card-warn">
          over limit by {formatTokens(num(usage.over_limit?.tokens_over) ?? 0)}
        </div>
      )}
      {rows.length > 0 && (
        <div className="report-card-rows">
          {rows.map((r, i) => (
            <div key={`${r.kind}:${r.name}:${i}`} className="report-card-row">
              <span className="report-card-row-name">{r.name}</span>
              <span className="report-card-row-kind">{r.kind}</span>
              <span className="report-card-row-value">{formatTokens(r.tokens)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const SEVERITY_CLASS: Record<string, string> = {
  critical: 'report-danger',
  warning: 'report-warn',
}

export function UsageReportCard({ report }: { report: StructuredUsageReport }) {
  const session = report.session
  const limits = report.rate_limits?.limits ?? null
  const extra = report.rate_limits?.extra_usage ?? null
  const models = session?.model_usage ? Object.entries(session.model_usage) : []
  const hasSession = session && (num(session.total_cost_usd) !== undefined || num(session.total_duration_ms) !== undefined)
  if (!hasSession && !limits?.length && !extra && models.length === 0) return null

  return (
    <div className="report-card" aria-label="Usage report">
      <div className="report-card-head">
        <span className="report-card-title">Usage</span>
        {session && (
          <span className="report-card-metric">
            {cost(num(session.total_cost_usd))}
            {num(session.total_duration_ms) !== undefined ? ` · ${Math.round((num(session.total_duration_ms) ?? 0) / 1000)}s` : ''}
          </span>
        )}
      </div>
      {session && (num(session.total_lines_added) !== undefined || num(session.total_lines_removed) !== undefined) && (
        <div className="report-card-sub">
          +{num(session.total_lines_added) ?? 0} −{num(session.total_lines_removed) ?? 0} lines
        </div>
      )}
      {limits && limits.length > 0 && (
        <div className="report-card-rows">
          {limits.map((l, i) => (
            <div key={`${l.kind ?? 'limit'}:${i}`} className="report-card-row">
              <span className="report-card-row-name">
                {l.scope?.model?.display_name ?? l.scope?.surface?.display_name ?? l.group ?? l.kind ?? 'limit'}
                {l.is_active ? ' ·' : ''}
              </span>
              <span className={`report-card-row-kind ${SEVERITY_CLASS[l.severity ?? ''] ?? ''}`}>
                {l.severity ?? ''}
              </span>
              <span className="report-card-row-value">{pct(num(l.percent))}</span>
            </div>
          ))}
        </div>
      )}
      {extra?.is_enabled && (
        <div className="report-card-sub">
          extra usage: {extra.used_credits ?? '—'} / {extra.monthly_limit ?? '—'} {extra.currency ?? ''}
        </div>
      )}
      {models.length > 0 && (
        <div className="report-card-rows">
          {models.map(([model, m]) => (
            <div key={model} className="report-card-row">
              <span className="report-card-row-name" title={model}>{model}</span>
              <span className="report-card-row-kind">
                {num(m.thinkingTokens) !== undefined ? `${formatTokens(num(m.thinkingTokens) ?? 0)} think` : ''}
              </span>
              <span className="report-card-row-value">{cost(num(m.costUSD))}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
