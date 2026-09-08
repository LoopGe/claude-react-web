// Read tool_use view.
//
// Extracted from ToolUseBlock.tsx for modularity.

import { memo } from 'react'
import { ToolCard } from '../ToolCard'
import { IconFileText } from '../icons/ToolIcons'
import { formatJson } from '../../utils/format'
import type { ToolViewProps } from './shared'
import { FilePathTitle } from './shared'

/**
 * File-path header (filename + grey dir) plus a "lines N–M" / "pages X–Y"
 * chip when offset/limit/pages are set. Reads have no body — the file path
 * + range is the entire useful payload at the tool_use stage.
 */
export const ReadToolView = memo(function ReadToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const filePath = typeof input.file_path === 'string' ? input.file_path : null
  const offset = typeof input.offset === 'number' ? input.offset : null
  const limit = typeof input.limit === 'number' ? input.limit : null
  const pages = typeof input.pages === 'string' ? input.pages : null

  if (!filePath) return <div className="tool-input">{formatJson(input)}</div>

  // offset is 0-indexed (per Read tool spec), but humans expect 1-indexed
  // line numbers, so display as offset+1 .. offset+limit.
  let rangeText: string | null = null
  if (offset != null && limit != null) {
    rangeText = `lines ${offset + 1}–${offset + limit}`
  } else if (offset != null) {
    rangeText = `from line ${offset + 1}`
  } else if (limit != null) {
    rangeText = `first ${limit} lines`
  }
  if (pages) rangeText = rangeText ? `${rangeText} · pages ${pages}` : `pages ${pages}`

  return (
    <ToolCard
      icon={<IconFileText />}
      title={<FilePathTitle path={filePath} />}
      chips={rangeText ? <span className="tool-chip">{rangeText}</span> : null}
      toolUseId={toolUseId}
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
      className="tool-card-read"
    />
  )
})
