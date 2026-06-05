// Sticky bar that surfaces Monitor background tasks that are currently
// running, rendered at the top of the chat area (alongside TodoChecklist) so
// users can see at a glance that a Monitor is live without scrolling the
// transcript.
//
// The `Monitor` tool starts a background script; each stdout line is injected
// into the conversation as a notification. This app has no dedicated handling
// for those events, so without this bar a running Monitor is nearly invisible
// (it falls through to the unknown-tool JSON card in ToolUseBlock).
//
// HOW RUNNING-NESS IS DETERMINED (best-effort, see plan):
// The tool_result for a Monitor call returns at START ("Monitor started …"),
// NOT at completion, so it can't tell us if the monitor is still alive. We
// rely on two signals that are SAFE (no false "stopped" while it's running):
//   - A `TaskStop` whose task_id matches  → stopped. This is the clean,
//     reliable end signal (TaskStop's input carries {task_id}).
//   - Non-persistent + past its timeout window (receivedAt + timeout_ms)
//     → assumed ended.
//   - Otherwise → running.
// `now` is refreshed on an interval so the timeout rule takes effect over time.
//
// We deliberately do NOT scan free text for "ended"/"completed"/"exit"
// markers: a monitor's own grep filter routinely contains those very words
// (e.g. `grep -E "done|exited|completed"`), and the command is echoed into the
// stream — so a text scan would falsely hide a RUNNING monitor. Showing a
// finished monitor slightly too long is far better than hiding a live one.

import { memo, useEffect, useMemo, useState } from 'react'
import type { SdkMessage } from '../types'
import { IconCircleDot } from './icons/ToolIcons'

interface MonitorInfo {
  /** tool_use id of the Monitor call — stable key. */
  key: string
  /** Server-assigned background task id (e.g. "biuwhpwky"), if parsed. */
  taskId?: string
  description: string
  persistent: boolean
}

interface Props {
  messages: SdkMessage[]
}

const TICK_MS = 5000

export const MonitorBar = memo(function MonitorBar({ messages }: Props) {
  const [now, setNow] = useState(() => Date.now())

  // Refresh `now` so the timeout heuristic advances. Only meaningful while the
  // bar might be showing, but the cost is trivial; keep it simple.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(t)
  }, [])

  const monitors = useMemo(() => extractRunningMonitors(messages, now), [messages, now])

  if (monitors.length === 0) return null

  return (
    <div className="monitor-bar" role="status" aria-label="Running monitors">
      <div className="monitor-bar-header">
        <span className="monitor-bar-title">Monitors</span>
        <span className="monitor-bar-count">{monitors.length}</span>
      </div>
      <ul className="monitor-bar-list">
        {monitors.map((m) => (
          <li key={m.key} className="monitor-item">
            <span className="monitor-icon" aria-hidden>
              <IconCircleDot size={12} />
            </span>
            <span className="monitor-text">{m.description}</span>
            {m.persistent && <span className="tool-chip tool-chip-accent">persistent</span>}
          </li>
        ))}
      </ul>
    </div>
  )
})

// ---------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------

const MONITOR = 'Monitor'
const TASK_STOP = 'TaskStop'

/** Walk the message stream and return the Monitor calls that appear to still
 *  be running. Mirrors the tool_use/tool_result correlation approach used by
 *  TodoChecklist's extractFromTaskEvents. */
function extractRunningMonitors(messages: SdkMessage[], now: number): MonitorInfo[] {
  // 1) Index every tool_result text by the tool_use_id it answers.
  const resultByToolUseId = new Map<string, string>()
  for (const msg of messages) {
    const content = msg.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (!block || block.type !== 'tool_result') continue
      const tuid = block.tool_use_id
      if (typeof tuid !== 'string') continue
      resultByToolUseId.set(tuid, resultText(block.content))
    }
  }

  // 2) Collect task ids that have been explicitly stopped via TaskStop.
  const stoppedTaskIds = new Set<string>()
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    const content = msg.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (!block || block.type !== 'tool_use' || block.name !== TASK_STOP) continue
      const input = block.input as Record<string, unknown> | undefined
      const id = str(input?.task_id) ?? str(input?.shell_id)
      if (id) stoppedTaskIds.add(id)
    }
  }

  // 3) Walk Monitor tool_use blocks and decide which are still running.
  const out: MonitorInfo[] = []
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    const content = msg.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (!block || block.type !== 'tool_use' || block.name !== MONITOR) continue
      const toolUseId = typeof block.id === 'string' ? block.id : undefined
      const input = (block.input as Record<string, unknown> | undefined) ?? undefined

      const resText = toolUseId ? resultByToolUseId.get(toolUseId) : undefined
      const taskId = resText ? parseMonitorTaskId(resText) : undefined
      const persistent = input?.persistent === true
      const timeoutMs = typeof input?.timeout_ms === 'number' ? input.timeout_ms : undefined
      const start = typeof msg.receivedAt === 'number' ? msg.receivedAt : undefined

      // --- ended? (only the two safe signals; see header comment) ---
      if (taskId && stoppedTaskIds.has(taskId)) continue
      if (!persistent && start && timeoutMs && now > start + timeoutMs) continue

      const description =
        str(input?.description) ?? firstLine(str(input?.command)) ?? 'Background monitor'

      out.push({
        key: toolUseId ?? `monitor:${out.length}`,
        taskId,
        description,
        persistent,
      })
    }
  }
  return out
}

/** Parse the background task id out of a "Monitor started (task <id>, …)"
 *  result string. */
function parseMonitorTaskId(text: string): string | undefined {
  const m = text.match(/task\s+([A-Za-z0-9]+)/)
  return m ? m[1] : undefined
}

/** Coerce a tool_result `content` field (string | array of text blocks |
 *  other) to a flat string. Same shape as TodoChecklist.resultText. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') {
          return (b as { text: string }).text
        }
        return ''
      })
      .join(' ')
  }
  return ''
}

/** First non-empty line of a string, trimmed. */
function firstLine(s: string | undefined): string | undefined {
  if (!s) return undefined
  const line = s.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  return line
}

/** Narrow an unknown to a non-empty string, else undefined. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
