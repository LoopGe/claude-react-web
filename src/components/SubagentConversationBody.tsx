// Presentational body for an Agent/Task subagent CONVERSATION from the main
// session mirror (filtered by parent_tool_use_id). Hosts: SubagentOverlay
// (drill-in) and the `subagent` resource preview.
//
// The overlay owns the chrome (header/breadcrumb/animation); this component is
// only the MessageList + the MCP Apps provider it needs.

import { MessageList } from './MessageList'
import { McpAppsProvider } from '../hooks/useMcpApps'
import type {
  ActiveSubagent,
  PlanStatus,
  ToolResultEntry,
  ToolStatus,
  TranscriptItem,
} from '../session-store/types'
import type { QuestionAnswerEntry } from '../utils/question-answers'
import type { StreamingRenderMode } from '../../shared/streaming-render-mode'

export function SubagentConversationBody({
  sessionId,
  currentId,
  current,
  items,
  toolStatus,
  toolResults,
  planStatus,
  planContent,
  questionAnswers,
  onBackgroundTool,
  toolGroupCards,
  autoExpandRunningGroups,
  showMessageHeaders,
  streamingMode,
  replayReady = true,
  cwd,
}: {
  sessionId: string
  cwd?: string
  /** The toolUseId whose conversation is shown. */
  currentId: string
  current: ActiveSubagent
  items: TranscriptItem[]
  toolStatus?: ReadonlyMap<string, ToolStatus>
  toolResults?: ReadonlyMap<string, ToolResultEntry>
  planStatus?: ReadonlyMap<string, PlanStatus>
  planContent?: ReadonlyMap<string, string>
  questionAnswers?: ReadonlyMap<string, QuestionAnswerEntry[]>
  onBackgroundTool?: (toolUseId: string) => void
  toolGroupCards?: boolean
  autoExpandRunningGroups?: boolean
  showMessageHeaders?: boolean
  streamingMode?: StreamingRenderMode
  /** Gates the empty state until the main history replay lands. */
  replayReady?: boolean
}) {
  return (
    // Same-session MCP Apps context: a subagent can call the session's mcp
    // tools too, and its transcript renders through the same ToolUseBlock.
    // Lazy-demand keyed on mcp__ tool names — an mcp-free subagent transcript
    // costs nothing.
    <McpAppsProvider sessionId={sessionId}>
      <MessageList
        items={items}
        sessionId={sessionId}
        cwd={cwd}
        parentToolUseIdFilter={currentId}
        subagent={current}
        transcriptRevealKey={`subagent:${currentId}`}
        toolStatus={toolStatus}
        toolResults={toolResults}
        planStatus={planStatus}
        planContent={planContent}
        questionAnswers={questionAnswers}
        onBackgroundTool={onBackgroundTool}
        toolGroupCards={toolGroupCards}
        autoExpandRunningGroups={autoExpandRunningGroups}
        showMessageHeaders={showMessageHeaders}
        streamingMode={streamingMode}
        replayReady={replayReady}
        // Subagents are not interactive — you can't type into them. The
        // default ChatEmptyState ("Type a message below…") would mislead, so
        // override with copy that explains why the body is empty.
        emptyStateContent={
          <div className="chat-messages-empty-side">
            <div className="chat-messages-empty-title">
              {current.status === 'running' ||
              current.status === 'background' ||
              current.status === 'pending'
                ? 'This subagent is working'
                : 'No subagent output'}
            </div>
            <div className="chat-messages-empty-hint">
              Subagents run autonomously — you can follow its progress here, but can't send messages to
              it.
            </div>
          </div>
        }
      />
    </McpAppsProvider>
  )
}