// Export a session transcript to a Markdown file and trigger a browser
// download. Pure client-side — no server round-trip needed.

import type { SdkMessage } from '../types'

/** Convert the SDK message array into Markdown and trigger a download. */
export function exportConversation(messages: SdkMessage[], title?: string): void {
  const lines: string[] = []
  lines.push(`# ${title || 'Conversation'}`)
  lines.push('')
  lines.push(`_Exported ${new Date().toISOString()}_`)
  lines.push('---')
  lines.push('')

  for (const msg of messages) {
    // Skip stream_event partials — the final assistant message has the
    // complete content.
    if (msg.type === 'stream_event') continue

    if (msg.type === 'user') {
      const text = extractText(msg)
      if (!text) continue
      // Check if this is a tool_result frame (synthetic) — skip those
      // for export since they're implementation detail.
      const content = msg.message?.content
      const hasToolResult = Array.isArray(content) &&
        (content as Array<{ type?: string }>).some((b) => b.type === 'tool_result')
      if (hasToolResult) continue

      lines.push('## You')
      lines.push('')
      lines.push(text)
      lines.push('')
    } else if (msg.type === 'assistant') {
      const text = extractText(msg)
      if (text) {
        lines.push('## Assistant')
        lines.push('')
        lines.push(text)
        lines.push('')
      }
    } else if (msg.type === 'system' && msg.subtype === 'error') {
      lines.push('## Error')
      lines.push('')
      lines.push(String(msg.error ?? 'unknown error'))
      lines.push('')
    } else if (msg.type === 'result') {
      const parts: string[] = []
      if (typeof msg.num_turns === 'number') parts.push(`${msg.num_turns} turns`)
      if (typeof msg.duration_ms === 'number') parts.push(`${Math.round(msg.duration_ms)}ms`)
      if (typeof msg.total_cost_usd === 'number') parts.push(`$${msg.total_cost_usd.toFixed(4)}`)
      if (parts.length > 0) {
        lines.push('---')
        lines.push(`_${parts.join(' · ')}_`)
        lines.push('')
      }
    }
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = sanitizeFilename(title || 'conversation') + '.md'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function extractText(msg: SdkMessage): string | null {
  const content = msg.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts = (content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
    return texts.length > 0 ? texts.join('\n\n') : null
  }
  return null
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-. ]/g, '').slice(0, 80) || 'conversation'
}
