// WebFetch tool_use view.
//
// Extracted from ToolUseBlock.tsx for modularity.

import { ToolCard } from '../ToolCard'
import { HoverHint } from '../HoverHint'
import { IconExternalLink, IconGlobe } from '../icons/ToolIcons'
import { formatJson } from '../../utils/format'
import { truncate } from '../../utils/text'
import type { ToolViewProps } from './shared'
import { isSafeUrl } from './shared'

/**
 * URL on top as a real anchor so the user can click through; prompt as
 * a muted body line. The URL itself is the key information — what the
 * model wants from it is secondary.
 *
 * The link is hardcoded to noopener/noreferrer + _blank — opening into
 * the chat tab is never what the user wants here, and a webpage that
 * inherits this app's window context could read its origin.
 */
export function WebFetchToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const url = typeof input.url === 'string' ? input.url : null
  const prompt = typeof input.prompt === 'string' ? input.prompt : null
  if (!url) return <div className="tool-input">{formatJson(input)}</div>

  const safe = isSafeUrl(url)
  const titleNode = safe ? (
    <HoverHint label={url} side="top">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="web-tool-url"
        onClick={(e) => e.stopPropagation()}
      >
        {url}
        <IconExternalLink size={12} />
      </a>
    </HoverHint>
  ) : (
    <>
      <HoverHint label={url} side="top">
        <code className="web-tool-url">{url}</code>
      </HoverHint>
      <HoverHint
        label="URL scheme is not in the http/https/mailto/ftp allowlist; rendered as plain text to avoid javascript: / data: URL execution."
        side="top"
      >
        <span className="tool-chip">
          unsafe scheme
        </span>
      </HoverHint>
    </>
  )

  return (
    <ToolCard
      icon={<IconGlobe />}
      title={titleNode}
      toolUseId={toolUseId}
      copyValue={() => url}
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
      copyLabel="Copy URL"
      className="tool-card-web"
    >
      {prompt && (
        <div className="web-tool-prompt">
          <span className="web-tool-prompt-marker" aria-hidden>└─</span>
          <span>{truncate(prompt, 240)}</span>
        </div>
      )}
    </ToolCard>
  )
}
