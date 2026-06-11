import { memo } from 'react'
import { Markdown } from '../Markdown'
import { ToolUseBlock } from '../ToolUseBlock'
import { ToolResultDetails } from '../ToolCard'
import type { Block } from '../../types'
import { formatJson } from '../../utils/format'

// Memoised because parent MessageView re-renders on every searchQuery
// keystroke. MessageView keeps block references stable with useMemo([msg]),
// so this shallow memo avoids reparsing Markdown and reconciling tool cards.
export const BlockView = memo(function BlockView({ block, searchQuery, activeMatchIdx }: { block: Block; searchQuery?: string; activeMatchIdx?: number }) {
  if (block.type === 'text' && typeof block.text === 'string') {
    return <Markdown text={block.text} searchQuery={searchQuery} activeMatchIdx={activeMatchIdx} />
  }
  if (block.type === 'image') {
    const source = block.source as { type: string; data?: string; media_type?: string } | undefined
    if (source?.type === 'base64' && source.data && source.media_type) {
      return (
        <img
          className="msg-image"
          src={`data:${source.media_type};base64,${source.data}`}
          alt="pasted image"
          decoding="async"
        />
      )
    }
    return <div className="tool-input">[image: invalid]</div>
  }
  if (block.type === 'thinking' && typeof block.thinking === 'string') {
    if (block.thinking.trim().length === 0) return null
    const preview = block.thinking.replace(/\s+/g, ' ').trim().slice(0, 120)
    return (
      <details className="thinking-details">
        <summary className="thinking-summary">
          <span className="thinking-label">thinking</span>
          <span className="thinking-preview">{preview}</span>
        </summary>
        <pre className="thinking-body">{block.thinking}</pre>
      </details>
    )
  }
  if (block.type === 'tool_use') {
    return <ToolUseBlock block={block} />
  }
  return (
    <div className="tool-input">
      [{block.type}] {formatJson(block)}
    </div>
  )
})

// Standalone orphan-result bubble: a tool_result whose tool_use_id never
// matched a seeded generic tool card (so it couldn't be merged inline).
export const ToolResultBlock = memo(function ToolResultBlock({ block }: { block: Block }) {
  return <ToolResultDetails content={block.content} />
})
