// Shared body for a subagent's DISK transcript (the `agent-<id>.jsonl` the CLI
// writes), rendered through the same MessageList as the main transcript. The
// scratch store is fed by the hub's subagent-transcript channel and the
// pure-disk REST bootstrap (dormant sessions work).
//
// Hosts: SubagentTranscriptDialog (variant="dialog", fixed height) and the
// resource preview (variant="fill", fills the modal body).

import { McpAppsProvider } from '../hooks/useMcpApps'
import { useSubagentTranscriptStore, subagentStoreId } from '../hooks/useSubagentTranscriptStore'
import { useSessionField } from '../session-store/selectors'
import type { StreamingRenderMode } from '../../shared/streaming-render-mode'
import { MessageList } from './MessageList'

export function SubagentTranscriptBody({
  sessionId,
  agentId,
  streamingMode,
  cwd,
  variant = 'fill',
}: {
  sessionId: string
  agentId: string
  streamingMode?: StreamingRenderMode
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
            items={items}
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