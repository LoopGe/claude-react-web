// Grep tool_use view.
//
// Extracted from ToolUseBlock.tsx for modularity.

import { memo } from 'react'
import { ToolCard } from '../ToolCard'
import { IconSearch } from '../icons/ToolIcons'
import { formatJson } from '../../utils/format'
import type { ToolViewProps } from './shared'
import { CopyablePathChip } from './shared'

/**
 * Pattern in quotes (the most important bit visually) plus modifier chips
 * for glob/type/path/output_mode and the case/multiline/-n flags. Order
 * mirrors how a human reads `rg "pattern" --glob='*.tsx' src/`.
 */
export const GrepToolView = memo(function GrepToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const pattern = typeof input.pattern === 'string' ? input.pattern : null
  if (!pattern) return <div className="tool-input">{formatJson(input)}</div>

  const path = typeof input.path === 'string' ? input.path : null
  const glob = typeof input.glob === 'string' ? input.glob : null
  const type = typeof input.type === 'string' ? input.type : null
  const outputMode = typeof input.output_mode === 'string' ? input.output_mode : null
  const caseInsensitive = input['-i'] === true
  const multiline = input.multiline === true
  const headLimit = typeof input.head_limit === 'number' ? input.head_limit : null
  const before = typeof input['-B'] === 'number' ? (input['-B'] as number) : null
  const after = typeof input['-A'] === 'number' ? (input['-A'] as number) : null
  const context = typeof input['-C'] === 'number' ? (input['-C'] as number) : null

  const chips = (
    <>
      {(glob || type) && (
        <span className="tool-chip tool-chip-accent">
          {glob ? `glob:${glob}` : `type:${type}`}
        </span>
      )}
      {path && <CopyablePathChip path={path} />}
      {outputMode && outputMode !== 'files_with_matches' && (
        <span className="tool-chip">{outputMode}</span>
      )}
      {caseInsensitive && <span className="tool-chip" title="Case insensitive">-i</span>}
      {multiline && <span className="tool-chip" title="Multiline mode">multiline</span>}
      {context != null
        ? <span className="tool-chip">±{context}</span>
        : (before != null || after != null) && (
            <span className="tool-chip">
              {before != null ? `-B${before}` : ''}
              {before != null && after != null ? ' ' : ''}
              {after != null ? `-A${after}` : ''}
            </span>
          )}
      {headLimit != null && <span className="tool-chip">head:{headLimit}</span>}
    </>
  )

  return (
    <ToolCard
      icon={<IconSearch />}
      title={<code className="grep-tool-pattern">&ldquo;{pattern}&rdquo;</code>}
      chips={chips}
      toolUseId={toolUseId}
      copyValue={() => pattern}
      copyLabel="Copy pattern"
      className="tool-card-grep"
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    />
  )
})
