// Context-composition breakdown for the SettingsPanel's Context tab.
//
// Body content only: the hosting .settings-group carries the title and the
// static "what a context window holds" explainer in its settings-group-head
// (same pattern as every other tab). The live table is driven by the SDK's
// canonical `categories` rows. Rows are classified on `kind` — never on the
// English `name` — so new SDK categories render with no changes here (see
// ContextUsage.categories in types/context-usage.ts). memoryFiles / mcpTools ride
// in as supplement rows only when the payload carries no categories (older
// SDK shapes); the per-server MCP section below is a deliberate DRILL-DOWN
// of the mcp_tools / mcp_instructions category rows (which stay totals) —
// the same tokens appear twice by design, once as a row, once split by
// server, so those views must not be summed together.

import { memo } from 'react'
import type { ContextUsage } from '../types/context-usage'
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

/** One per-server row of the MCP breakdown: tool-schema tokens (split into
 *  loaded vs deferred) plus, when the CLI reports it, the server's share of
 *  the 'mcp_instructions' row. */
interface McpServerRow {
  name: string
  toolsTokens: number
  deferredTokens: number
  instructionsTokens: number | null
}

/** Aggregate the detailed payload's per-server MCP data. Accepts BOTH
 *  generations of `mcpTools` — the old `{ tokenCount }` aggregate (feeds
 *  the no-categories fallback row, never this section) and the SDK
 *  0.3.304+ per-tool array (aggregated here by server). Returns [] when
 *  the payload carries neither form's per-server data.
 *
 *  The join folds case: the SDK documents mcpInstructions.serverName as
 *  NOT normalized while mcpTools[].serverName is, so raw equality could
 *  split one server into a phantom duplicate row. The display name is the
 *  first spelling seen (the tools form arrives in every payload that has
 *  both). */
function mcpServerRows(usage: ContextUsage | null): McpServerRow[] {
  const tools = Array.isArray(usage?.mcpTools) ? usage.mcpTools : []
  const instructions = usage?.mcpInstructions ?? []
  if (tools.length === 0 && instructions.length === 0) return []
  const byKey = new Map<string, McpServerRow>()
  const rowFor = (name: string): McpServerRow => {
    const key = name.toLowerCase()
    let r = byKey.get(key)
    if (!r) {
      r = { name, toolsTokens: 0, deferredTokens: 0, instructionsTokens: null }
      byKey.set(key, r)
    }
    return r
  }
  for (const t of tools) {
    const r = rowFor(t.serverName)
    r.toolsTokens += t.tokens
    if (t.isLoaded === false) r.deferredTokens += t.tokens
  }
  for (const i of instructions) {
    const r = rowFor(i.serverName)
    // Accumulate, never overwrite: the case-folded join can meet two
    // spellings of one server, and the category row above shows the full
    // total — dropping one entry would under-report against it.
    r.instructionsTokens = (r.instructionsTokens ?? 0) + i.tokens
  }
  return [...byKey.values()]
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
  // The no-categories fallback rows. ASYMMETRY between the two fields:
  // mcpTools' array form renders in the per-server section instead (this
  // row only serves the old `{ tokenCount }` aggregate), while memoryFiles
  // has no richer view — its per-file array (SDK 0.3.311+) is summed right
  // into this row. Feeding either array into its aggregate row would
  // double-count against the categories / per-server views.
  const mcpFallbackTokens =
    usage?.mcpTools && !Array.isArray(usage.mcpTools) ? usage.mcpTools.tokenCount : undefined
  const memoryFallbackTokens = usage?.memoryFiles
    ? Array.isArray(usage.memoryFiles)
      ? usage.memoryFiles.reduce((sum, f) => sum + f.tokens, 0)
      : usage.memoryFiles.tokenCount
    : undefined

  const rows: CompositionRow[] =
    categories.length > 0
      ? categories.map((c, i) => ({
          key: `${c.kind}:${c.name}:${i}`,
          name: c.name,
          kind: c.kind,
          tokens: c.tokens,
        }))
      : [
          ...(memoryFallbackTokens != null
            ? [{ key: 'memory-files', name: 'Memory files', kind: null, tokens: memoryFallbackTokens }]
            : []),
          ...(mcpFallbackTokens != null
            ? [{ key: 'mcp-tools', name: 'MCP tools', kind: null, tokens: mcpFallbackTokens }]
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

  // Per-server MCP breakdown (SDK 0.3.304+ detailed payload). Rendered
  // independently of the composition rows so a payload that carries the
  // arrays but no categories still shows it; absent → no section at all.
  const mcpServers = mcpServerRows(usage)

  return (
    // Plain div inside the .settings-group body — a nested .settings-section
    // or a second card chrome would double the group's own. This class only
    // carries the inner stack spacing between the rows and the state hints;
    // the group body's flex gap handles the rest.
    <div className="settings-context-composition">
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
      {/* Per-server MCP breakdown — a server's tool schemas plus its share
          of the instructions row. Column semantics mirror the composition
          rows above: the share column carries the window percentage and the
          tokens column the raw total. The share EXCLUDES deferred tool
          schemas (they occupy no window — same rule as the 'deferred' kind
          showing '—'); a server with nothing in-window shows '—' rather
          than a rounding-to-zero '0%'. */}
      {mcpServers.length > 0 && (
        <div className="ctx-mcp-servers">
          <div className="ctx-mcp-servers-title">MCP servers</div>
          {mcpServers.map((s) => {
            const inWindow = s.toolsTokens - s.deferredTokens + (s.instructionsTokens ?? 0)
            return (
              <div key={s.name} className="settings-kv-row">
                <code>{s.name}</code>
                <span className="ctx-mcp-server-detail">
                  {s.toolsTokens > 0 && (
                    <>
                      tools {formatTokens(s.toolsTokens)}
                      {s.deferredTokens > 0 && (
                        <span className="ctx-mcp-server-deferred">
                          {' '}
                          ({formatTokens(s.deferredTokens)} deferred)
                        </span>
                      )}
                    </>
                  )}
                  {s.instructionsTokens != null && (
                    <>{s.toolsTokens > 0 ? ' · ' : ''}instructions {formatTokens(s.instructionsTokens)}</>
                  )}
                </span>
                <span className="ctx-kind-share">
                  {inWindow > 0 ? share(inWindow, 'used') : '—'}
                </span>
                <span className="settings-kv-tokens">
                  {formatTokens(s.toolsTokens + (s.instructionsTokens ?? 0))}
                </span>
              </div>
            )
          })}
        </div>
      )}
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
