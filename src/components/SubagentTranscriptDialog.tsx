// Read-only dialog showing a subagent's FULL on-disk transcript (the
// `subagents/agent-<id>.jsonl` the CLI writes for Agent-launched subagents)
// rendered through the SAME MessageList the main transcript uses. Content
// lives in a scratch SessionStore (useSubagentTranscriptStore); the hub
// pushes snapshot + incremental frames so a running background task's
// transcript fills in live.

import type { StreamingRenderMode } from '../../shared/streaming-render-mode'
import { SubagentTranscriptBody } from './SubagentTranscriptBody'
import { Overlay } from './Overlay'
import { IconX } from './icons/ToolIcons'

export const SubagentTranscriptDialog = function SubagentTranscriptDialog({
  sessionId,
  agentId,
  label,
  streamingMode,
  cwd,
  onClose,
}: {
  sessionId: string
  agentId: string
  label: string
  /** Global streaming-preview mode, threaded from the panel prefs so the
   *  dialog follows the same setting as the main transcript. */
  streamingMode?: StreamingRenderMode
  /** Session working directory — relative paths in the transcript resolve
   *  against it. */
  cwd?: string
  onClose: () => void
}) {
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
        <SubagentTranscriptBody
          sessionId={sessionId}
          agentId={agentId}
          streamingMode={streamingMode}
          cwd={cwd}
          variant="dialog"
        />
      </div>
    </Overlay>
  )
}
