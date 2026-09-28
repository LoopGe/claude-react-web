// Context-composition breakdown for the SettingsPanel's Context tab.
//
// Two halves: a short static explanation of what a context window holds,
// and a live table driven by the SDK's canonical `categories` rows. Rows
// are classified on `kind` — never on the English `name` — so new SDK
// categories render with no changes here (see ContextUsage.categories in
// useChatStream.ts). memoryFiles / mcpTools ride in as supplement rows
// only when the payload carries no categories (older SDK shapes), so the
// two views can never double-count the same tokens.

import { memo } from 'react'
import type { ContextUsage } from '../hooks/useChatStream'
import { contextWindowTokens } from '../utils/context-usage'
import { formatTokens } from '../utils/format'

/** Legend copy per canonical kind. `deferred` = an out-of-window tool
 *  schema listed for awareness — it does NOT occupy the window. */
const KIND_LEGEND: Record<string, string> = {
  used: 'occupies the window',
  free: 'remaining space',
  buffer: 'auto-compact reserve',
  deferred: 'not injected (awareness only)',
}

interface CompositionRow {
  key: string
  name: string
  kind: string | null
  tokens: number
}

export const ContextComposition = memo(function ContextComposition({
  usage,
  loading = false,
  error = false,
  onRetry,
}: {
  /** Merged usage snapshot (WS lite + detailed REST payload). The
   *  categories breakdown only exists in the detailed payload. */
  usage: ContextUsage | null
  /** True while the detailed fetch is in flight — shows the loading note
   *  instead of an empty section. */
  loading?: boolean
  /** True when the last detailed-fetch attempt failed — without this the
   *  empty area below the explainer would look like "no data" instead of
   *  a failed read (the Skills tab has its own copy of this hint). */
  error?: boolean
  /** Retry callback for the error hint (loadDetailedUsage). */
  onRetry?: () => void
}) {
  // Share-of-window math: same window preference as ContextBar — one
  // owner (contextWindowTokens), no drift between the bar and this table.
  const windowTokens = contextWindowTokens(usage)
  const categories = usage?.categories ?? []

  const rows: CompositionRow[] =
    categories.length > 0
      ? categories.map((c, i) => ({
          key: `${c.kind}:${c.name}:${i}`,
          name: c.name,
          kind: c.kind,
          tokens: c.tokens,
        }))
      : [
          ...(usage?.memoryFiles?.tokenCount != null
            ? [{ key: 'memory-files', name: 'Memory files', kind: null, tokens: usage.memoryFiles.tokenCount }]
            : []),
          ...(usage?.mcpTools?.tokenCount != null
            ? [{ key: 'mcp-tools', name: 'MCP tools', kind: null, tokens: usage.mcpTools.tokenCount }]
            : []),
        ]

  // Share of the window. Deferred rows show '—': their schemas are NOT
  // injected (awareness only, per the legend), so presenting a percentage
  // in the same column that means real occupancy elsewhere would make the
  // column sum over-count the window. Sub-1% rows render '<1%' rather than
  // a rounding-to-zero '0%' that would deny real occupancy.
  const share = (tokens: number, kind: string | null): string => {
    if (kind === 'deferred') return '—'
    if (windowTokens == null || windowTokens <= 0) return '—'
    const pct = (tokens / windowTokens) * 100
    if (pct > 0 && pct < 1) return '<1%'
    return `${Math.round(pct)}%`
  }

  return (
    // Plain div, NOT .settings-section: the Context tab already wraps this
    // in a .settings-section (padding + border-bottom + flex gap) — a nested
    // one would double the horizontal padding and draw a stray rule mid-tab.
    // The section's descendant `h4` styling still applies through the outer
    // wrapper; this class only carries the inner stack spacing.
    <div className="settings-context-composition">
      <h4>Context composition</h4>
      <span className="hint">
        Each turn sends the model the whole window: the system prompt
        (CLAUDE.md, environment info, tool schemas for built-in and MCP
        tools), discovered skills and agent definitions, memory files, and
        the conversation so far. The SDK keeps a buffer at the top of the
        window for auto-compact; whatever is left is free space.
      </span>
      {rows.length > 0 ? (
        // Plain wrapper — .settings-detail-body's margin-top would stack
        // with this stack's flex gap and break the spacing rhythm.
        <div>
          {rows.map((r) => (
            <div key={r.key} className="settings-kv-row">
              <code>{r.name}</code>
              {r.kind != null && (
                <span className={`ctx-kind-badge ctx-kind-${r.kind}`}>{r.kind}</span>
              )}
              <span className="ctx-kind-share">{share(r.tokens, r.kind)}</span>
              <span className="settings-kv-tokens">{formatTokens(r.tokens)}</span>
            </div>
          ))}
          {/* Legend derived from the kinds actually present — a static
              four-entry glossary would advertise kinds the payload never
              emitted (e.g. a buffer row the SDK omitted). Ordered by the
              canonical kind order, not payload order. */}
          {categories.length > 0 && (
            <div className="ctx-kind-legend">
              {Object.keys(KIND_LEGEND)
                .filter((kind) => categories.some((c) => c.kind === kind))
                .map((kind) => (
                  <span key={kind} className="ctx-kind-legend-item">
                    <span className={`ctx-kind-badge ctx-kind-${kind}`}>{kind}</span>
                    {KIND_LEGEND[kind]}
                  </span>
                ))}
            </div>
          )}
        </div>
      ) : loading ? (
        <div className="settings-empty-note">Loading breakdown…</div>
      ) : null}
      {/* Failure hint renders BESIDE the rows too: a failed refresh with
          stale rows still displayed must not read as current numbers (the
          Skills tab flags the same state as "showing last known numbers").
          The caller passes error only for live sessions — a dormant one
          gets the resume hint there instead of a retry that no-ops. */}
      {error && (
        <span className="hint">
          {rows.length > 0
            ? "Couldn't refresh the breakdown — showing last known numbers. "
            : "Couldn't load the breakdown — "}
          {onRetry && (
            <button type="button" className="settings-reset-link" onClick={onRetry}>retry</button>
          )}
        </span>
      )}
    </div>
  )
})
