// Glob tool_use view.
//
// Extracted from ToolUseBlock.tsx for modularity.

import { ToolCard } from '../ToolCard'
import { IconFolderSearch } from '../icons/ToolIcons'
import { formatJson } from '../../utils/format'
import type { ToolViewProps } from './shared'
import { CopyablePathChip } from './shared'

/**
 * Pattern-only file matcher. Visually a stripped-down Grep — same row
 * layout, same chip vocabulary.
 */
export function GlobToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const pattern = typeof input.pattern === 'string' ? input.pattern : null
  if (!pattern) return <div className="tool-input">{formatJson(input)}</div>

  const path = typeof input.path === 'string' ? input.path : null

  return (
    <ToolCard
      icon={<IconFolderSearch />}
      title={<code className="grep-tool-pattern">{pattern}</code>}
      chips={path ? <CopyablePathChip path={path} /> : null}
      toolUseId={toolUseId}
      copyValue={() => pattern}
      copyLabel="Copy pattern"
      className="tool-card-glob"
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    />
  )
}
