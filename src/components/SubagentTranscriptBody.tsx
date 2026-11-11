// Shared body for a subagent's DISK transcript (the `agent-<id>.jsonl` the CLI
// writes), rendered through the same MessageList as the main transcript. The
// scratch store is fed by the hub's subagent-transcript channel and the
// pure-disk REST bootstrap (dormant sessions work).
//
// Hosts: SubagentTranscriptDialog (variant="dialog", fixed height) and the
// resource preview (variant="fill", fills the modal body).

import { useMemo } from 'react'
import { McpAppsProvider } from '../hooks/useMcpApps'
import { useSubagentTranscriptStore, subagentStoreId } from '../hooks/useSubagentTranscriptStore'
import { useSessionField } from '../session-store/selectors'
import type { ActiveSubagent } from '../session-store/types'
import type { TaskRecordUi } from '../types'
import { isTerminalTaskStatus } from '../../shared/tasks'
import { resultContentToText } from '../session-store/live-turn'
import type { StreamingRenderMode } from '../../shared/streaming-render-mode'
import { MessageList } from './MessageList'
import { useSubagentSyntheticRows } from './message-list/useSubagentSyntheticRows'

function taskAsSubagent(task: TaskRecordUi): ActiveSubagent | undefined {
  if (!task.toolUseId) return undefined
  const terminal = isTerminalTaskStatus(task.status)
  const result = task.result != null && task.result !== ''
    ? { content: task.result, isError: task.status !== 'completed' && task.status !== 'stopped' }
    : undefined
  return {
    toolUseId: task.toolUseId,
    taskId: task.taskId,
    label: task.description || task.taskId,
    status: terminal
      ? (task.status === 'completed' || task.status === 'stopped' ? 'done' : 'interrupted')
      : (task.isBackgrounded ? 'background' : 'running'),
    isAsync: task.isBackgrounded ?? true,
    toolCount: 0,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    result,
    resultOrigin: result ? 'notification' : undefined,
  }
}

export function SubagentTranscriptBody({
  sessionId,
  agentId,
  streamingMode,
  subagent,
  suppressResult = false,
  cwd,
  variant = 'fill',
}: {
  sessionId: string
  agentId: string
  streamingMode?: StreamingRenderMode
  /** Live lifecycle record used to restore a result absent from the disk rows. */
  subagent?: ActiveSubagent
  /** The host already renders the terminal result outside this transcript. */
  suppressResult?: boolean
  /** Session working directory — relative paths in the transcript (tool-row
   *  open buttons, Markdown links) resolve against it. */
  cwd?: string
  /** 'dialog' keeps the historical fixed-height body; 'fill' fills its host. */
  variant?: 'dialog' | 'fill'
}) {
  const { replayReady, error } = useSubagentTranscriptStore(sessionId, agentId)
  const storeId = subagentStoreId(sessionId, agentId)
  const items = useSessionField(storeId, 'items')
  const toolStatus = useSessionField(storeId, 'toolStatus')
  const toolResults = useSessionField(storeId, 'toolResults')
  const planStatus = useSessionField(storeId, 'planStatus')
  const planContent = useSessionField(storeId, 'planContent')
  const questionAnswers = useSessionField(storeId, 'questionAnswers')
  const subagentIndex = useSessionField(sessionId, 'subagentIndex')
  const tasks = useSessionField(sessionId, 'tasks')
  const task = tasks.find((record) => record.taskId === agentId)
  const resolvedSubagent = useMemo(() => {
    const taskResult = task ? taskAsSubagent(task) : undefined
    const indexed = subagent ?? Array.from(subagentIndex.values()).find((record) => record.taskId === agentId)
    if (indexed && taskResult?.result && !indexed.result) {
      return { ...indexed, result: taskResult.result, resultOrigin: 'notification' as const }
    }
    return indexed ?? taskResult
  }, [subagent, subagentIndex, task, agentId])
  const resultSubagent = useMemo(() => {
    if (!suppressResult) return resolvedSubagent
    const content = resolvedSubagent?.result?.content
    if (task?.result && Array.isArray(content) && resultContentToText(content).trim() === task.result.trim()) {
      const supplemental = content.filter((block) => block?.type !== 'text')
      if (supplemental.length > 0 && resolvedSubagent?.result) {
        return { ...resolvedSubagent, result: { ...resolvedSubagent.result, content: supplemental } }
      }
    }
    // A richer indexed result outranks the task row's older text. Suppress
    // only when the host already renders the same text and no blocks remain.
    return resolvedSubagent?.result && task?.result && resultContentToText(content).trim() !== task.result.trim()
      ? resolvedSubagent
      : undefined
  }, [suppressResult, resolvedSubagent, task])
  // The disk transcript owns the conversation. Only the terminal result is
  // synthesized here: the prompt is already a disk row, and MessageList's
  // parent filter is not applicable to this separate transcript.
  const { trailingItems } = useSubagentSyntheticRows(
    resultSubagent?.toolUseId,
    resultSubagent,
    items,
    true,
  )
  const displayItems = useMemo(
    () => trailingItems?.length
      ? [
          ...items,
          ...trailingItems.map((item) => ({
            ...item,
            msg: { ...item.msg, parent_tool_use_id: null },
          })),
        ]
      : items,
    [items, trailingItems],
  )

  return (
    <div
      className={`subagent-transcript-body${
        variant === 'fill' ? ' subagent-transcript-body-fill' : ''
      }`}
    >
      {/* Data present = show data: a stale store error must not hide content
          that already arrived (the scratch store's error field is sticky by
          design — the reducer never clears it on REPLAY_REPLACE). */}
      {error && items.length === 0 ? (
        <div className="subagent-transcript-error">Failed to load transcript: {error}</div>
      ) : (
        <McpAppsProvider sessionId={sessionId}>
          <MessageList
            items={displayItems}
            sessionId={sessionId}
            cwd={cwd}
            replayReady={replayReady}
            // Gate the empty state on the REST bootstrap: without this the
            // "No transcript on disk" card flashes before the store's
            // replayReady flips.
            expectHistory
            toolStatus={toolStatus}
            toolResults={toolResults}
            planStatus={planStatus}
            planContent={planContent}
            questionAnswers={questionAnswers}
            // Fixed defaults: the TasksPanel context has no panel prefs.
            toolGroupCards
            autoExpandRunningGroups
            showMessageHeaders
            streamingMode={streamingMode}
            emptyStateContent={
              <div className="chat-messages-empty-side">
                <div className="chat-messages-empty-title">
                  No transcript on disk for this subagent.
                </div>
                <div className="chat-messages-empty-hint">
                  Background subagents write their transcript when they run — nothing was recorded.
                </div>
              </div>
            }
          />
        </McpAppsProvider>
      )}
    </div>
  )
}