// Read-only dialog showing a subagent's FULL on-disk transcript (the
// `subagents/agent-<id>.jsonl` the CLI writes for Agent-launched subagents)
// rendered through the SAME MessageList the main transcript uses. Content
// lives in a scratch SessionStore (useSubagentTranscriptStore); the hub
// pushes snapshot + incremental frames so a running background task's
// transcript fills in live.

import { McpAppsProvider } from '../hooks/useMcpApps'
import { useSubagentTranscriptStore, subagentStoreId } from '../hooks/useSubagentTranscriptStore'
import { useSessionField } from '../session-store/selectors'
import { MessageList } from './MessageList'
import { Overlay } from './Overlay'
import { IconX } from './icons/ToolIcons'

export const SubagentTranscriptDialog = function SubagentTranscriptDialog({
  sessionId,
  agentId,
  label,
  onClose,
}: {
  sessionId: string
  agentId: string
  label: string
  onClose: () => void
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
    <Overlay
      variant="modal"
      onClose={onClose}
      ariaLabel={`Subagent transcript: ${label}`}
      // ~860px: tool cards need more width than the old 620px text renderer.
      cardStyle={{ maxWidth: 860, maxHeight: '80vh' }}
      // Portal to body: opened from inside the TasksPanel overlay (an
      // animated ancestor that would otherwise clip the fixed backdrop).
      portal
    >
      <div className="subagent-transcript">
        <header className="subagent-transcript-header">
          <span className="subagent-transcript-title" title={agentId}>
            {label || agentId}
          </span>
          <span className="subagent-transcript-sub">disk transcript</span>
          <span className="subagent-transcript-spacer" />
          <button type="button" className="subagent-transcript-close" onClick={onClose} aria-label="Close">
            <IconX size={14} />
          </button>
        </header>
        <div className="subagent-transcript-body">
          {/* Data present = show data: a stale store error must not hide
              content that already arrived (the scratch store's error field is
              sticky by design — the reducer never clears it on REPLAY_REPLACE). */}
          {error && items.length === 0 ? (
            <div className="subagent-transcript-error">Failed to load transcript: {error}</div>
          ) : (
            <McpAppsProvider sessionId={sessionId}>
              <MessageList
                items={items}
                sessionId={sessionId}
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
                emptyStateContent={(
                  <div className="chat-messages-empty-side">
                    <div className="chat-messages-empty-title">No transcript on disk for this subagent.</div>
                    <div className="chat-messages-empty-hint">
                      Background subagents write their transcript when they run — nothing was recorded.
                    </div>
                  </div>
                )}
              />
            </McpAppsProvider>
          )}
        </div>
      </div>
    </Overlay>
  )
}
