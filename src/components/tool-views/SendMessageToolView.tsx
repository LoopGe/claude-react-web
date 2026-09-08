// Agent-to-agent / agent-to-main SendMessage tool_use view.
//
// Extracted from ToolUseBlock.tsx for modularity.

import { Markdown } from '../Markdown'
import { ToolCard } from '../ToolCard'
import { AnimatedDetails } from '../AnimatedCollapse'
import { IconMessageCircle } from '../icons/ToolIcons'
import { formatJson } from '../../utils/format'
import { truncate } from '../../utils/text'
import type { ToolViewProps } from './shared'

/**
 * Agent-to-agent / agent-to-main message. Input shape (loosely typed — the
 * SDK schema drifts, so every field is validated before use):
 *   { to: string, summary?: string, message: string }
 *
 *   - title  : the recipient ("→ name") so message routing is scannable at
 *              a glance. `to` may be a teammate name, "main", or an agent
 *              id (e.g. "a9c1a4af…"); long ids are truncated with the full
 *              value in the hover title.
 *   - chip   : the sender-provided `summary` (muted, truncated).
 *   - body   : the `message`, collapsed to a one-line preview by default
 *              and expanding to a full Markdown render — agents routinely
 *              embed code blocks / lists in these, and plain <pre> would
 *              show the backticks literally. Auto-opens when a search
 *              query is active so matches inside the body are reachable.
 *
 * Parallels WebSearch's title+chip header and ToolResultDetails' collapsible
 * body, so an inter-agent message reads as part of the same tool-card family
 * instead of falling through to the raw-JSON fallback.
 */
export function SendMessageToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const to = typeof input.to === 'string' ? input.to : null
  const summary = typeof input.summary === 'string' ? input.summary : null
  const message = typeof input.message === 'string' ? input.message : null

  // Without a recipient AND a message there's nothing structured to show —
  // hand back to the raw-JSON branch so the user still sees something.
  if (!to && !message) return <div className="tool-input">{formatJson(input)}</div>

  const toLabel = to ? truncate(to, 40) : '(no recipient)'
  const firstLine = message ? (message.split('\n')[0]?.trim() || message) : ''
  const preview = firstLine ? truncate(firstLine, 120) : '(empty message)'
  const hasSearch = Boolean(searchQuery?.trim())

  const chips = summary ? (
    <span className="tool-chip" title={summary}>{truncate(summary, 80)}</span>
  ) : null

  return (
    <ToolCard
      icon={<IconMessageCircle />}
      title={
        <span className="sendmessage-tool-to" title={to ?? undefined}>
          <span className="sendmessage-tool-arrow" aria-hidden>→</span>
          <code>{toLabel}</code>
        </span>
      }
      chips={chips}
      toolUseId={toolUseId}
      copyValue={message ? () => message : undefined}
      copyLabel="Copy message"
      className="tool-card-sendmessage"
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    >
      <AnimatedDetails
        className="sendmessage-tool-body"
        summaryClassName="sendmessage-tool-summary"
        summary={preview}
        open={hasSearch ? true : undefined}
      >
        <div className="sendmessage-tool-content">
          {message ? (
            <Markdown text={message} searchQuery={searchQuery} activeMatchIdx={activeMatchIdx} />
          ) : (
            <div className="tool-input">(empty message)</div>
          )}
        </div>
      </AnimatedDetails>
    </ToolCard>
  )
}
