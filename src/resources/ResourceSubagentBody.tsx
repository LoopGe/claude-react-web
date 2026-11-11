// Body for a `subagent` resource (Phase 3): an Agent/Task conversation.
// Sync/foreground agents render from the main session mirror (filtered by
// parent_tool_use_id); ASYNC agents (`isAsync === true` — the single authority,
// written by TASKS_SNAPSHOT) render the shared disk-transcript body.
// Mirror-backed — no registry provider.

import { useMemo } from 'react'
import { parseSubagentResource, taskResource } from '../../shared/resource-address'
import { useSessionField } from '../session-store/selectors'
import { ElapsedTimer } from '../components/ElapsedTimer'
import { SubagentConversationBody } from '../components/SubagentConversationBody'
import { SubagentTranscriptBody } from '../components/SubagentTranscriptBody'
import { useOptionalOpenResource } from './context'

export function ResourceSubagentBody({
  address,
  cwd,
}: {
  address: string
  /** Session working directory — relative paths in the conversation resolve
   *  against it (tool-row open buttons / Markdown links). */
  cwd?: string
}) {
  const parsed = useMemo(() => parseSubagentResource(address), [address])
  if (!parsed) return <div className="hint">Nothing can open this address.</div>
  return <AgentBody sessionId={parsed.sessionId} toolUseId={parsed.toolUseId} cwd={cwd} />
}

function AgentBody({
  sessionId,
  toolUseId,
  cwd,
}: {
  sessionId: string
  toolUseId: string
  cwd?: string
}) {
  const index = useSessionField(sessionId, 'subagentIndex')
  const ready = useSessionField(sessionId, 'replayReady')
  const openResource = useOptionalOpenResource()

  const current = index.get(toolUseId)
  if (!current) {
    return (
      <div className="hint">
        {ready ? 'Subagent not found (history may have been compacted).' : 'Loading subagent…'}
      </div>
    )
  }

  const taskId = current.taskId
  // Only an ASYNC agent has an on-disk transcript keyed by the agent id. A
  // sync agent can also carry a taskId (TASKS_SNAPSHOT joins it), but its
  // conversation lives in the main mirror.
  const showTranscript = current.isAsync === true && taskId != null

  return (
    <div className="resource-agent-body">
      <header className="resource-agent-header">
        <span className="resource-agent-title" title={toolUseId}>
          {current.label || toolUseId}
        </span>
        <span className="resource-agent-meta">
          {current.status}
          {current.toolCount > 0 ? ` · ${current.toolCount} tools` : ''}
        </span>
        {current.startedAt != null && (
          <span className="resource-agent-elapsed">
            <ElapsedTimer
              startedAt={current.startedAt}
              endedAt={current.endedAt}
              live={current.endedAt == null}
            />
          </span>
        )}
        <span className="resource-agent-spacer" />
        {taskId && openResource && (
          <button
            type="button"
            className="btn"
            onClick={() => openResource(sessionId, taskResource(sessionId, taskId))}
          >
            Open task
          </button>
        )}
      </header>
      {showTranscript ? (
        <SubagentTranscriptBody
          sessionId={sessionId}
          agentId={taskId!}
          subagent={current}
          variant="fill"
          cwd={cwd}
        />
      ) : (
        <MirrorConversation
          sessionId={sessionId}
          toolUseId={toolUseId}
          current={current}
          cwd={cwd}
        />
      )}
    </div>
  )
}

/** Owns the main-mirror subscriptions so the async/transcript branch does not
 *  re-render on every streaming flush it ignores. */
function MirrorConversation({
  sessionId,
  toolUseId,
  current,
  cwd,
}: {
  sessionId: string
  toolUseId: string
  current: import('../session-store/types').ActiveSubagent
  cwd?: string
}) {
  const items = useSessionField(sessionId, 'items')
  const toolStatus = useSessionField(sessionId, 'toolStatus')
  const toolResults = useSessionField(sessionId, 'toolResults')
  const planStatus = useSessionField(sessionId, 'planStatus')
  const planContent = useSessionField(sessionId, 'planContent')
  const questionAnswers = useSessionField(sessionId, 'questionAnswers')
  const ready = useSessionField(sessionId, 'replayReady')

  return (
    <div className="resource-agent-conversation">
      <SubagentConversationBody
        sessionId={sessionId}
        currentId={toolUseId}
        current={current}
        items={items}
        toolStatus={toolStatus}
        toolResults={toolResults}
        planStatus={planStatus}
        planContent={planContent}
        questionAnswers={questionAnswers}
        replayReady={ready}
        cwd={cwd}
      />
    </div>
  )
}