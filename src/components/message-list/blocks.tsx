import { memo } from 'react'
import { Markdown } from '../Markdown'
import { MsgImage } from '../MsgImage'
import { ToolUseBlock } from '../ToolUseBlock'
import { ToolResultDetails } from '../ToolCard'
import { ThinkingBody } from './thinking-body'
import type { Block } from '../../types'
import { formatJson } from '../../utils/format'
import { imageBlockToDataUrl } from '../../utils/image-block'
import { isImageRefBlock } from '../../../shared/image-attachment'
import { useImageContent } from '../../hooks/useImageContent'

// Memoised because parent MessageView re-renders on every searchQuery
// keystroke. MessageView keeps block references stable with useMemo([msg]),
// so this shallow memo avoids reparsing Markdown and reconciling tool cards.
export const BlockView = memo(function BlockView({ block, searchQuery, activeMatchIdx, toolResultActiveMatchIdx }: {
  block: Block
  searchQuery?: string
  /** Active match index for text blocks (from blockActiveIdx). */
  activeMatchIdx?: number
  /** Active match index for tool_result content rendered inside tool_use cards. */
  toolResultActiveMatchIdx?: number
}) {
  if (block.type === 'text' && typeof block.text === 'string') {
    return <Markdown text={block.text} searchQuery={searchQuery} activeMatchIdx={activeMatchIdx} />
  }
  if (block.type === 'image') {
    return <ImageBlockView block={block} />
  }
  if (block.type === 'thinking' && typeof block.thinking === 'string') {
    if (block.thinking.trim().length === 0) return null
    return <ThinkingBody text={block.thinking} />
  }
  if (block.type === 'tool_use') {
    return (
      <ToolUseBlock
        block={block}
        searchQuery={searchQuery}
        activeMatchIdx={toolResultActiveMatchIdx}
        diffActiveMatchIdx={activeMatchIdx}
      />
    )
  }
  return (
    <div className="tool-input">
      [{block.type}] {formatJson(block)}
    </div>
  )
})

/** One image content block, both wire shapes:
 *  - durable ref (`attachment`): the bytes live in the object store and
 *    resolve through useImageContent (content route → cached blob URL). The
 *    ref's recorded dimensions hold the layout while the fetch lands — no
 *    decode needed. The resolved URL flows into MsgImage → Lightbox like any
 *    other src.
 *  - legacy base64 (`source`): the synchronous data-URL path, unchanged. */
function ImageBlockView({ block }: { block: Block }) {
  const ref = isImageRefBlock(block) ? block.attachment : null
  const content = useImageContent(ref)
  if (ref !== null) {
    if (content.failed) return <div className="tool-input">[image: unavailable]</div>
    if (content.url === null) {
      return (
        <div
          className="msg-image-loading"
          role="img"
          aria-label="Loading image"
          style={{ aspectRatio: `${ref.width} / ${ref.height}`, width: `min(100%, 600px, ${ref.width}px)` }}
        />
      )
    }
    return <MsgImage src={content.url} alt="pasted image" decoding="async" />
  }
  const src = imageBlockToDataUrl(block)
  if (src) {
    return <MsgImage src={src} alt="pasted image" decoding="async" />
  }
  return <div className="tool-input">[image: invalid]</div>
}

// Standalone orphan-result bubble: a tool_result whose tool_use_id never
// matched a seeded generic tool card (so it couldn't be merged inline).
export const ToolResultBlock = memo(function ToolResultBlock({ block, searchQuery, activeMatchIdx }: { block: Block; searchQuery?: string; activeMatchIdx?: number }) {
  return <ToolResultDetails content={block.content} searchQuery={searchQuery} activeMatchIdx={activeMatchIdx} />
})
