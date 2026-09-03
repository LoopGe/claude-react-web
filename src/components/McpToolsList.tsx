// Collapsible tool list for a settings MCP card — shared by the normal
// (live-probed) MCP server cards and the first-party in-process server cards
// so both kinds of server present their tools identically.

import type { FirstPartyToolDef } from '../../shared/first-party'
import type { McpServerTool } from '../types'

/** Map a first-party static tool def onto the McpServerTool shape the list
 *  renders (readOnly flag travels as the annotation the badge keys off). */
// eslint-disable-next-line react-refresh/only-export-components -- the adapter exists to produce exactly the shape this file's list renders; keeping them adjacent keeps the mapping honest
export function firstPartyToolDefsAsMcpTools(defs: FirstPartyToolDef[]): McpServerTool[] {
  return defs.map((t) => ({ name: t.name, description: t.description, annotations: { readOnly: t.readOnly } }))
}

/** One tool row in a settings tool list — shared by the overlay list
 *  (McpToolsList) and the inline card expansions (McpServerCard /
 *  FirstPartyStatusCard) so every tool renders identically. */
export function McpToolRow({ tool, itemClassName }: { tool: McpServerTool; itemClassName?: string }) {
  return (
    <div className={itemClassName ? `settings-card-item ${itemClassName}` : 'settings-card-item'}>
      <code>{tool.name}</code>
      {tool.annotations?.readOnly && <span className="settings-tag readonly">read-only</span>}
      {tool.annotations?.destructive && <span className="settings-tag destructive">destructive</span>}
      {tool.annotations?.openWorld && <span className="settings-tag openworld">open-world</span>}
      {tool.description && <span className="settings-card-desc">{tool.description}</span>}
    </div>
  )
}

export function McpToolsList({ tools, loading, error, onClose }: {
  tools: McpServerTool[]
  loading: boolean
  /** Present when the listing request itself failed (shown instead of the
   *  empty-state so a fetch failure is never mistaken for "no tools"). */
  error?: string | null
  onClose: () => void
}) {
  return (
    <div className="settings-card-body settings-mcp-tools">
      <div className="settings-mcp-tools-head">
        <span className="settings-card-grouplabel">Tools</span>
        <button className="btn btn-xs" onClick={onClose}>Hide</button>
      </div>
      {loading && <div className="settings-card-desc">Loading tools...</div>}
      {!loading && error && <div className="settings-mcp-tools-error">{error}</div>}
      {!loading && !error && tools.length === 0 && <div className="settings-card-desc">No tools returned by this server.</div>}
      {!loading && !error && tools.map((tool) => (
        <McpToolRow key={tool.name} tool={tool} itemClassName="settings-mcp-tool-item" />
      ))}
    </div>
  )
}
