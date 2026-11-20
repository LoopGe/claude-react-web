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
import { MessageList } from './MessageList'
import { useSubagentSyntheticRows } from './message-list/useSubagentSyntheticRows'
import { useTaskResult } from '../hooks/useTaskResult'
import { TaskResultView, type TaskResultState } from './TaskResultView'
import { canonicalResultText, hasRicherCanonicalResult as hasRicherResult } from '../utils/task-result'

function taskAsSubagent(task: TaskRecordUi, resultPreview = task.result): ActiveSubagent | undefined {
  if (!task.toolUseId) return undefined
  const terminal = isTerminalTaskStatus(task.status)
  const hasOutput = task.resultRef?.hasResult ?? (typeof resultPreview === 'string' && resultPreview.trim() !== '')
  const isError = task.resultRef?.isError ?? (task.status !== 'completed' && task.status !== 'stopped')
  const result = resultPreview != null && resultPreview !== ''
    ? { content: resultPreview, isError }
    : undefined
  return {
    toolUseId: task.toolUseId,
    taskId: task.taskId,
    label: task.description || task.taskId,
    status: terminal
      ? (task.status === 'completed' || (task.status === 'stopped' && hasOutput && !isError) ? 'done' : 'interrupted')
      : (task.isBackgrounded ? 'background' : 'running'),
    isAsync: task.isBackgrounded ?? true,
    toolCount: 0,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    result,
    resultOrigin: result ? (task.resultRef?.projection === 'partial' ? 'summary' : 'notification') : undefined,
  }
}

export function SubagentTranscriptBody({
  sessionId,
  agentId,
  subagent,
  resultState: externalResultState,
  resultPreview: externalResultPreview,
  suppressResult = false,
  visible = true,
  cwd,
  variant = 'fill',
}: {
  sessionId: string
  agentId: string
  /** Live lifecycle record used to restore a result absent from the disk rows. */
  subagent?: ActiveSubagent
  /** A resource host may share its already-fetched result page so details and
   *  transcript suppression compare the same generation. */
  resultState?: TaskResultState
  resultPreview?: string
  /** The host already renders the terminal result outside this transcript. */
  suppressResult?: boolean
  /** Hidden keep-alive hosts stop paged reads. */
  visible?: boolean
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
  const indexedSubagent = useMemo(() => {
    if (subagent) return subagent
    const candidates = Array.from(subagentIndex.values()).filter((record) => record.taskId === agentId)
    if (!tasks.some((task) => task.taskId === agentId)) return candidates[0]
    return candidates.find((record) => tasks.some((task) =>
      task.taskId === agentId && task.toolUseId === record.toolUseId,
    ))
  }, [subagent, subagentIndex, agentId, tasks])
  const task = tasks.find((record) =>
    record.taskId === agentId && (!indexedSubagent || record.toolUseId === indexedSubagent.toolUseId),
  )
  const hasRicherCanonicalResult = useMemo(
    () => hasRicherResult(task, indexedSubagent),
    [task, indexedSubagent],
  )
  const internalResultState = useTaskResult({
    sessionId,
    taskId: agentId,
    runId: task?.runId,
    updatedAt: task?.updatedAt ?? 0,
    resultVersion: task?.resultRef?.resultVersion,
    totalChars: task?.resultRef?.totalChars ?? 0,
    enabled: visible && task?.resultRef?.projection === 'partial' &&
      !hasRicherCanonicalResult && externalResultState === undefined,
  })
  const resultPreview = externalResultPreview ?? externalResultState?.page?.result ?? internalResultState.page?.result ?? task?.result
  const resolvedSubagent = useMemo(() => {
    const taskResult = task ? taskAsSubagent(task, resultPreview) : undefined
    const indexed = indexedSubagent
    const canRestore = indexed && taskResult?.result && !hasRicherCanonicalResult
    if (canRestore) {
      const supplemental = Array.isArray(indexed.result?.content)
        ? indexed.result.content.filter((block) => block?.type !== 'text')
        : []
      const result = supplemental.length > 0 && taskResult.result
        ? {
            ...taskResult.result,
            content: [
              { type: 'text', text: canonicalResultText(taskResult.result.content) },
              ...supplemental,
            ],
          }
        : taskResult.result
      return { ...indexed, result, resultOrigin: taskResult.resultOrigin }
    }
    return indexed ?? taskResult
  }, [indexedSubagent, task, resultPreview, hasRicherCanonicalResult])
  const showPagedResult = !suppressResult && task?.resultRef?.projection === 'partial' &&
    !hasRicherCanonicalResult
  const resultSubagent = useMemo(() => {
    if (resolvedSubagent && task?.resultRef?.projection === 'partial' && !hasRicherCanonicalResult) {
      const content = resolvedSubagent.result?.content
      if (Array.isArray(content)) {
        const supplemental = content.filter((block) => block?.type !== 'text')
        if (supplemental.length > 0 && resolvedSubagent.result) {
          return { ...resolvedSubagent, result: { ...resolvedSubagent.result, content: supplemental } }
        }
      }
      return undefined
    }
    if (!suppressResult) return resolvedSubagent
    const content = resolvedSubagent?.result?.content
    const previewText = resultPreview?.trim()
    const exactTextMatch = previewText != null && previewText.length > 0 && canonicalResultText(content).trim() === previewText
    if (exactTextMatch && Array.isArray(content)) {
      const supplemental = content.filter((block) => block?.type !== 'text')
      if (supplemental.length > 0 && resolvedSubagent?.result) {
        return { ...resolvedSubagent, result: { ...resolvedSubagent.result, content: supplemental } }
      }
    }
    // Only an exact full-text match proves the host and canonical results are
    // identical. Partial pages never suppress a richer canonical prefix.
    return resolvedSubagent?.result && !exactTextMatch
      ? resolvedSubagent
      : undefined
  }, [suppressResult, resolvedSubagent, resultPreview, task?.resultRef?.projection, hasRicherCanonicalResult])
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
      <McpAppsProvider sessionId={sessionId}>
        {showPagedResult && task && (
          <TaskResultView
            sessionId={sessionId}
            task={task}
            enabled={visible}
            state={externalResultState ?? internalResultState}
          />
        )}
        {error && items.length === 0 ? (
          <div className="subagent-transcript-error">Failed to load transcript: {error}</div>
        ) : (
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
        )}
      </McpAppsProvider>
    </div>
  )
}