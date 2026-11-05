// Per-panel right-side overlay that holds a subagent's full internal
// conversation. Same overlay-inside-the-Chat-column pattern as
// SettingsPanel: absolute positioned, semi-transparent backdrop, only
// covers this column. ESC or backdrop click closes; the breadcrumb
// supports nested drill-down (a Task spawned inside an Agent etc.).

import { memo, useEffect } from 'react'
import { SubagentConversationBody } from './SubagentConversationBody'
import { TranscriptDrawerShell } from './TranscriptDrawerShell'
import { ElapsedTimer } from './ElapsedTimer'
import { IconX, IconArrowLeft, IconEye } from './icons/ToolIcons'
import { subagentResource } from '../../shared/resource-address'
import { useOptionalOpenResource } from '../resources/context'
import type {
  ActiveSubagent,
  PlanStatus,
  ToolResultEntry,
  ToolStatus,
  TranscriptItem,
} from '../session-store/types'
import type { QuestionAnswerEntry } from '../utils/question-answers'
import type { StreamingRenderMode } from '../../shared/streaming-render-mode'
import { cx } from '../utils/cx'

interface Props {
  /** Stack of toolUseIds: stack[0] is the outermost subagent the user
   *  drilled into, stack[length-1] is the one currently shown. */
  stack: string[]
  /** Owning session id — feeds the MCP Apps provider below (a subagent can
   *  call the session's mcp tools; its cards need the same resource map). */
  sessionId: string
  /** Full session transcript — we filter it to messages whose
   *  parent_tool_use_id matches the current frame. */
  items: TranscriptItem[]
  index: ReadonlyMap<string, ActiveSubagent>
  onClose: () => void
  onPop: () => void
  /** When provided, the × (close) button dismisses an in-flight subagent
   *  (running/background/pending — flips to `dismissed` via
   *  DISMISS_SUBAGENT) before closing the overlay. For already-settled
   *  subagents (done/interrupted/dismissed/rejected) the × just closes. */
  onDismiss?: (toolUseId: string) => void
  isExiting?: boolean
  transitionDirection?: 'forward' | 'back' | null
  onExited?: () => void
  /** Tool/plan/question lifecycle maps. These MUST be forwarded to the
   *  nested MessageList — it builds its OWN status context providers, so
   *  without them every tool card inside a drilled-in subagent reads the
   *  empty-default provider and useToolStatus() falls back to 'running'
   *  forever (the "tool stuck running" bug). The reducer already seeds
   *  subagent-internal tool ids (it ignores parent_tool_use_id), so the
   *  data exists — it just has to reach this MessageList. */
  toolStatus?: ReadonlyMap<string, ToolStatus>
  /** Captured tool_result payloads — forwarded so subagent-internal tool
   *  cards merge their results inline too (the reducer seeds those ids
   *  regardless of parent_tool_use_id). */
  toolResults?: ReadonlyMap<string, ToolResultEntry>
  planStatus?: ReadonlyMap<string, PlanStatus>
  planContent?: ReadonlyMap<string, string>
  questionAnswers?: ReadonlyMap<string, QuestionAnswerEntry[]>
  /** Background ONE in-flight tool call by tool_use id — forwarded to the
   *  nested MessageList so Bash cards inside the subagent's conversation can
   *  offer the per-card background button too (same session, tool ids are
   *  session-scoped). */
  onBackgroundTool?: (toolUseId: string) => void
  /** Transcript's collapsible transcript-group-cards pref (tool-group fold) (effective value from
   *  the owning Chat panel) — forwarded so the subagent's inner transcript
   *  matches the main one. */
  toolGroupCards?: boolean
  /** Auto-expand running groups pref (effective value from the owning Chat
   *  panel) — forwarded for consistency with the main transcript. */
  autoExpandRunningGroups?: boolean
  /** Message-card header visibility pref (effective value from the owning
   *  Chat panel) — forwarded for consistency with the main transcript. */
  showMessageHeaders?: boolean
  /** Global streaming-preview mode (from the owning Chat panel) — forwarded
   *  so the seam here follows the same setting as the main transcript. */
  streamingMode?: StreamingRenderMode
  /** Session working directory — relative paths in the conversation resolve
   *  against it (tool-row open buttons / Markdown links). */
  cwd?: string
}

export const SubagentOverlay = memo(function SubagentOverlay({
  stack,
  items,
  index,
  onClose,
  onPop,
  onDismiss,
  isExiting = false,
  transitionDirection = null,
  onExited,
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
  sessionId,
  cwd,
}: Props) {
  const currentId = stack[stack.length - 1]
  const current = currentId ? index.get(currentId) : undefined
  const openResource = useOptionalOpenResource()
  // Synthetic prompt/result rows are derived by MessageList from the record.

  // If the referenced subagent vanishes from the index (session reset,
  // fork, etc.) the overlay would render null and the stack would be
  // stuck non-empty — close/back become silent no-ops. Drive a real
  // close so subsequent open() calls work.
  useEffect(() => {
    if (currentId && !current) {
      if (onExited) onExited()
      else onClose()
    }
  }, [currentId, current, onClose, onExited])

  if (!currentId || !current) return null

  // Live elapsed for the current frame's header. Re-renders piggy-back
  // on the parent (Chat) re-rendering — good enough at second granularity.
  const startedAt = current.startedAt
  const endedAt = current.endedAt
  // In-flight statuses keep counting; settled ones freeze at endedAt. Before
  // this the header computed Date.now() once per render, so an open overlay on
  // a running subagent showed a frozen elapsed until some unrelated state
  // change happened to re-render it.
  const elapsedLive =
    current.status === 'running' || current.status === 'background' || current.status === 'pending'

  const statusText =
    current.status === 'running'
      ? 'running'
      : current.status === 'background'
        ? 'background'
        : current.status === 'pending'
          ? 'pending'
          : current.status === 'dismissed'
            ? 'dismissed'
            : current.status === 'done'
              ? 'done'
              : current.status === 'rejected'
                ? 'rejected'
                : 'interrupted'

  return (
    <TranscriptDrawerShell
      variant="subagent"
      ariaLabel="Subagent details"
      isExiting={isExiting}
      onClose={onClose}
      onEscape={() => {
        if (stack.length > 1) onPop()
        else onClose()
      }}
      onExited={onExited}
      header={
        <div className="subagent-overlay-header">
          <button
            type="button"
            className="subagent-overlay-back"
            onClick={stack.length > 1 ? onPop : onClose}
            disabled={isExiting}
            title={stack.length > 1 ? 'Back to outer subagent' : 'Back to conversation'}
            aria-label="Back"
          >
            <IconArrowLeft size={14} />
          </button>
          <div className="subagent-overlay-title">
            {stack.length > 1 && (
              <span className="subagent-overlay-breadcrumb truncate">
                {stack.slice(0, -1).map((id) => {
                  const r = index.get(id)
                  return (r?.label ?? 'subagent') + ' › '
                })}
              </span>
            )}
            <span className="subagent-overlay-current-label">{current.label}</span>
            <span className={`subagent-overlay-status status-${current.status}`}>
              {statusText}
              {startedAt != null && ' · '}
              <ElapsedTimer startedAt={startedAt} endedAt={endedAt} live={elapsedLive} />
            </span>
            {/* Live progress summary (agentProgressSummaries) — shown only
                while the subagent is in flight; cleared on terminal. */}
            {current.progressSummary &&
              (current.status === 'running' ||
                current.status === 'background' ||
                current.status === 'pending') && (
                <span className="subagent-overlay-progress" title={current.progressSummary}>
                  {current.progressSummary}
                </span>
              )}
          </div>
          {openResource && (
          <button
            type="button"
            className="subagent-overlay-open"
            onClick={() => {
              openResource(sessionId, subagentResource(sessionId, currentId))
              onClose()
            }}
            disabled={isExiting}
            title="Open in resource preview"
            aria-label="Open in resource preview"
          >
            <IconEye size={14} />
          </button>
        )}
          <button
            type="button"
            className="subagent-overlay-close"
            onClick={() => {
              const st = current?.status
              if (onDismiss && (st === 'running' || st === 'background' || st === 'pending')) {
                onDismiss(currentId)
              }
              onClose()
            }}
            disabled={isExiting}
            title={
              current &&
              (current.status === 'running' ||
                current.status === 'background' ||
                current.status === 'pending') &&
              onDismiss
                ? 'Dismiss and close'
                : 'Close (Esc)'
            }
            aria-label={
              current &&
              (current.status === 'running' ||
                current.status === 'background' ||
                current.status === 'pending') &&
              onDismiss
                ? 'Dismiss and close'
                : 'Close'
            }
          >
            <IconX size={14} />
          </button>
        </div>
      }
    >
      <div
        key={currentId}
        className={cx(
          'subagent-overlay-body',
          transitionDirection ? `subagent-overlay-body-${transitionDirection}` : '',
        )}
      >
        <SubagentConversationBody
          sessionId={sessionId}
          currentId={currentId}
          current={current}
          items={items}
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
          cwd={cwd}
        />
      </div>
    </TranscriptDrawerShell>
  )
})
