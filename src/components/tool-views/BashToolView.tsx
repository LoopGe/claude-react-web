// Bash / PowerShell tool_use view — shares one component across both
// tools (same input shape: command, description, run_in_background,
// timeout), branching on `toolName` to swap the prompt glyph.
//
// Extracted from ToolUseBlock.tsx for modularity.

import { memo } from 'react'
import { useBackgroundTool } from '../../hooks/useBackgroundTool'
import { ToolCard } from '../ToolCard'
import { AnimatedDetails } from '../AnimatedCollapse'
import { IconTerminal } from '../icons/ToolIcons'
import { formatJson } from '../../utils/format'
import type { ToolViewProps } from './shared'

const BASH_FOLD_THRESHOLD = 240
const BASH_PREVIEW_LINES = 3
const BASH_SINGLE_LINE_PREVIEW = 200

/**
 * Compact one-liner header (`$ command` + description subtitle) so a long
 * stretch of bash hops doesn't bury the transcript in nested JSON. Long
 * or multiline commands collapse into <details> with the first 3 lines
 * as a preview — the model often pipes here-docs that easily exceed the
 * fold threshold.
 *
 * Also serves the `PowerShell` tool (same input shape: command,
 * description, run_in_background, timeout). The `toolName` prop swaps
 * the prompt glyph: `$` for Bash, `PS>` for PowerShell — both are
 * universally recognised shell prompts and disambiguate the language
 * at a glance when both tools appear in the same transcript.
 */
export const BashToolView = memo(function BashToolView({ input, toolName, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
  // Hook first (before the early return below) — the session-level
  // background action from the BackgroundTool context.
  const backgroundTool = useBackgroundTool()
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const command = typeof input.command === 'string' ? input.command : ''
  const description = typeof input.description === 'string' ? input.description : null
  const inBackground = input.run_in_background === true
  const timeoutMs = typeof input.timeout === 'number' ? input.timeout : null
  const isPowerShell = toolName === 'PowerShell'
  const promptGlyph = isPowerShell ? 'PS>' : '$'

  const lines = command.split('\n')
  const tooLong = command.length > BASH_FOLD_THRESHOLD || lines.length > BASH_PREVIEW_LINES
  const isSingleLineLong = lines.length === 1 && command.length > BASH_FOLD_THRESHOLD
  const previewText = isSingleLineLong
    ? command.slice(0, BASH_SINGLE_LINE_PREVIEW) + '…'
    : lines.slice(0, BASH_PREVIEW_LINES).join('\n')
  const remaining = lines.length - BASH_PREVIEW_LINES

  const chips = (
    <>
      {inBackground && <span className="tool-chip tool-chip-accent">background</span>}
      {timeoutMs != null && (
        <span className="tool-chip" title="Timeout in milliseconds">
          {formatBashTimeout(timeoutMs)}
        </span>
      )}
    </>
  )

  // Title is the first line of the command (the most informative bit at a
  // glance); the body holds the full command (folded if long).
  const titleLine = (
    <span className="bash-tool-line">
      <span className="bash-tool-prompt" aria-hidden>{promptGlyph}</span>
      <code className="bash-tool-command">
        {tooLong ? previewText : command}
      </code>
    </span>
  )

  return (
    <ToolCard
      icon={<IconTerminal />}
      title={titleLine}
      chips={chips}
      toolUseId={toolUseId}
      copyValue={() => command}
      copyLabel="Copy command"
      // Per-card background action: only a FOREGROUND shell command is
      // backgroundable (`run_in_background: true` already detached at spawn)
      // and only when the parent wired the session action in. ToolCard
      // further gates on the card still running.
      onBackground={!inBackground && toolUseId && backgroundTool ? () => backgroundTool(toolUseId) : undefined}
      className="tool-card-bash"
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    >
      {(tooLong || description) && (
        <div className="bash-tool-body">
          {tooLong && (
            <AnimatedDetails
              className="bash-tool-collapsible"
              summary={(
                <span className="bash-tool-fold-hint">
                  {remaining > 0
                    ? `... show ${remaining} more line${remaining === 1 ? '' : 's'} (${lines.length} total)`
                    : `... show full command (${command.length} chars)`}
                </span>
              )}
            >
              <pre className="bash-tool-full"><code>{command}</code></pre>
            </AnimatedDetails>
          )}
          {description && (
            <div className="bash-tool-desc">
              <span className="bash-tool-desc-marker" aria-hidden>└─</span>
              <span>{description}</span>
            </div>
          )}
        </div>
      )}
    </ToolCard>
  )
})

function formatBashTimeout(ms: number): string {
  if (ms >= 60_000) {
    const m = Math.round((ms / 60_000) * 10) / 10
    return `timeout ${m}m`
  }
  if (ms >= 1000) return `timeout ${Math.round(ms / 1000)}s`
  return `timeout ${ms}ms`
}
