// WebSearch tool_use view.
//
// Extracted from ToolUseBlock.tsx for modularity.

import { ToolCard } from '../ToolCard'
import { HoverHint } from '../HoverHint'
import { IconSearch } from '../icons/ToolIcons'
import { formatJson } from '../../utils/format'
import type { ToolViewProps } from './shared'

/**
 * Query in quotes (mono), allowed/blocked domain filters as muted chips
 * — visually parallels Grep / Glob so the "I'm searching X with these
 *   modifiers" pattern reads consistently across tools.
 */
export function WebSearchToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const query = typeof input.query === 'string' ? input.query : null
  if (!query) return <div className="tool-input">{formatJson(input)}</div>

  const allowed = Array.isArray(input.allowed_domains)
    ? (input.allowed_domains as string[]).filter((d) => typeof d === 'string')
    : []
  const blocked = Array.isArray(input.blocked_domains)
    ? (input.blocked_domains as string[]).filter((d) => typeof d === 'string')
    : []

  const chips = (
    <>
      {allowed.length > 0 && (
        <HoverHint label="Allowed domains" side="top">
          <span className="tool-chip tool-chip-accent">
            only: {allowed.join(', ')}
          </span>
        </HoverHint>
      )}
      {blocked.length > 0 && (
        <HoverHint label="Blocked domains" side="top">
          <span className="tool-chip">
            block: {blocked.join(', ')}
          </span>
        </HoverHint>
      )}
    </>
  )

  return (
    <ToolCard
      icon={<IconSearch />}
      title={<code className="grep-tool-pattern">&ldquo;{query}&rdquo;</code>}
      chips={chips}
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
      toolUseId={toolUseId}
      copyValue={() => query}
      copyLabel="Copy query"
      className="tool-card-websearch"
    />
  )
}
