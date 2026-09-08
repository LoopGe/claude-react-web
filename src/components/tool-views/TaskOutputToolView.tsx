// Background task/agent output-retrieval tool_use view.
//
// Extracted from ToolUseBlock.tsx for modularity.

import { ToolCard } from '../ToolCard'
import { IconDownload } from '../icons/ToolIcons'
import { formatJson } from '../../utils/format'
import { truncate } from '../../utils/text'
import type { ToolViewProps } from './shared'

/**
 * Retrieve output from a background task/agent. Input shape (loosely typed):
 *   { task_id: string, block?: boolean, timeout?: number }
 *
 * Unlike SendMessage, the interesting payload here is NOT the input — it's
 * the tool_result (the retrieved output stream), which ToolCard already
 * renders inline via ToolCardResult/ToolResultDetails. So this view is a
 * body-less header card (like WebSearch): the task_id in a mono pill so
 * you can see WHICH background task is being polled, plus block/timeout
 * chips that distinguish a one-shot peek from a blocking wait.
 *
 * Without this, the input dumps as raw JSON (`{"task_id":"bash-7",
 * "block":true,"timeout":180000}`) and the id — the only bit you'd want
 * to scan for — is buried.
 */
export function TaskOutputToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const taskId = typeof input.task_id === 'string' ? input.task_id : null
  const block = typeof input.block === 'boolean' ? input.block : null
  const timeout = typeof input.timeout === 'number' ? input.timeout : null

  if (!taskId) return <div className="tool-input">{formatJson(input)}</div>

  // Render timeout as a human chip: ms when <1s, seconds otherwise. The
  // raw ms is preserved in the title for copy/debug.
  const timeoutChip =
    timeout != null ? (
      <span className="tool-chip" title={`${timeout}ms`}>
        {timeout >= 1000
          ? `${(timeout / 1000).toFixed(timeout % 1000 === 0 ? 0 : 1)}s`
          : `${timeout}ms`}
      </span>
    ) : null

  const chips = (
    <>
      {block === true && <span className="tool-chip tool-chip-accent">blocking</span>}
      {block === false && <span className="tool-chip">non-blocking</span>}
      {timeoutChip}
    </>
  )

  return (
    <ToolCard
      icon={<IconDownload />}
      title={
        <span className="taskoutput-tool-to" title={taskId}>
          <code>{truncate(taskId, 40)}</code>
        </span>
      }
      chips={chips}
      toolUseId={toolUseId}
      className="tool-card-taskoutput"
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    />
  )
}
