// Read-only dialog showing a subagent's FULL on-disk transcript (the
// `subagents/agent-<id>.jsonl` the CLI writes for Agent-launched subagents).
// Unlike the in-memory SubagentOverlay (which filters frames the SDK forwarded
// onto the main stream by parent_tool_use_id), this is authoritative even for
// background / async subagents whose frames never reached the stream.
//
// Minimal renderer by design: flat user/assistant text turns — no tool cards.
// Opened from a terminal subagent row in the TasksPanel.

import { useEffect, useState } from 'react'
import { Overlay } from './Overlay'
import { useSubagentTranscripts, subagentMessageText, type SubagentSessionMessage } from '../hooks/useSubagentTranscripts'
import { IconX, IconLoader } from './icons/ToolIcons'

function TranscriptRow({ msg }: { msg: SubagentSessionMessage }) {
  const text = subagentMessageText(msg)
  const isAssistant = msg.type === 'assistant'
  const isSystem = msg.type === 'system'
  const label = isAssistant ? 'Claude' : isSystem ? 'system' : 'input'
  return (
    <div className={`subagent-transcript-row ${isAssistant ? 'subagent-transcript-row-assistant' : 'subagent-transcript-row-user'}`}>
      <div className="subagent-transcript-role">{label}</div>
      {text ? (
        <pre className="subagent-transcript-text">{text}</pre>
      ) : (
        <div className="subagent-transcript-empty">(non-text turn — tool call / result)</div>
      )}
    </div>
  )
}

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
  const { getTranscript } = useSubagentTranscripts(sessionId)
  const [messages, setMessages] = useState<SubagentSessionMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getTranscript(agentId)
      .then((msgs) => {
        if (!cancelled) setMessages(msgs)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [getTranscript, agentId])

  return (
    <Overlay variant="modal" onClose={onClose} ariaLabel={`Subagent transcript: ${label}`} cardStyle={{ maxWidth: 620, maxHeight: '80vh' }}>
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
          {error ? (
            <div className="subagent-transcript-error">Failed to load transcript: {error}</div>
          ) : messages === null ? (
            <div className="subagent-transcript-loading">
              <IconLoader size={14} className="subagent-transcript-spin" aria-hidden />
              Loading transcript…
            </div>
          ) : messages.length === 0 ? (
            <div className="subagent-transcript-empty-state">
              No transcript on disk for this subagent.
            </div>
          ) : (
            messages.map((m, i) => <TranscriptRow key={m.uuid ?? i} msg={m} />)
          )}
        </div>
      </div>
    </Overlay>
  )
}
