// In-session "run a custom agent" delegation control.
//
// Renders a compact modal that lets the user pick an ENABLED custom agent
// plus a task, then enqueues the crafted delegation message through the same
// session send path that the composer uses (`POST /sessions/:id/messages`).
//
// Honesty note baked into the UI: delegation is model-guided — the model
// decides whether/how it invokes the Agent tool. We merely queue a message
// that *asks* it to. The picker therefore only ever needs to satisfy the
// crafted-text contract; correctness of the tool call itself is the model's.

import { useMemo, useState } from 'react'
import { Overlay } from '../Overlay'
import { api } from '../../hooks/useApi'
import { useAgentDefinitions } from '../../hooks/useAgentDefinitions'

interface Props {
  sessionId: string
  /** Called when the dialog is dismissed or after a successful enqueue. */
  onClose: () => void
}

export function RunAsAgentControl({ sessionId, onClose }: Props) {
  const { agents } = useAgentDefinitions()
  const enabled = useMemo(() => agents.filter((a) => a.enabled), [agents])

  const [selected, setSelected] = useState<string>(enabled[0]?.name ?? '')
  const [task, setTask] = useState('')
  const [staleError, setStaleError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // The selected agent may have been enabled when picked but no longer resolve
  // if the list changed under us (toggled off / removed). Surface that inline
  // rather than silently dropping the selection.
  const selectedResolvable = enabled.some((a) => a.name === selected)

  const canRun = !busy && task.trim().length > 0 && selectedResolvable

  const close = () => {
    if (busy) return
    onClose()
  }

  const run = async () => {
    if (!canRun) return
    if (!selectedResolvable) {
      setStaleError('This agent is no longer enabled. Pick another agent or re-enable it.')
      return
    }
    const name = selected
    setBusy(true)
    try {
      await api.post<unknown>(`/sessions/${sessionId}/messages`, {
        text: `Use the Agent tool with name "${name}" to complete the following task:\n${task}`,
      })
      onClose()
    } catch (e) {
      setStaleError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Overlay
      variant="modal"
      ariaLabel="Run as agent"
      onClose={close}
      canCloseOnEscape={() => !busy}
      canCloseOnBackdrop={() => !busy}
    >
      <div className="modal-header">
        <h3>Run as agent</h3>
      </div>
      <div className="modal-section">
        <div className="runasagent-field">
          <label className="runasagent-label" htmlFor="runasagent-agent">Agent</label>
          <select
            id="runasagent-agent"
            className="select"
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value)
              setStaleError(null)
            }}
            disabled={busy || enabled.length === 0}
          >
            {enabled.length === 0 && <option value="">No enabled agents</option>}
            {enabled.map((a) => (
              <option key={a.name} value={a.name}>{a.name}</option>
            ))}
          </select>
        </div>

        <div className="runasagent-field">
          <label className="runasagent-label" htmlFor="runasagent-task">Task</label>
          <textarea
            id="runasagent-task"
            aria-label="Task"
            className="textarea"
            rows={4}
            placeholder="What should the agent do?"
            value={task}
            onChange={(e) => {
              setTask(e.target.value)
              setStaleError(null)
            }}
            disabled={busy}
          />
        </div>

        {staleError && <div className="modal-error">{staleError}</div>}

        <p className="hint runasagent-hint">
          Delegation is model-guided: the model decides whether and how it
          invokes the selected agent.
        </p>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn" onClick={close} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => { void run() }}
          disabled={!canRun}
        >
          {busy ? 'Running...' : 'Run'}
        </button>
      </div>
    </Overlay>
  )
}