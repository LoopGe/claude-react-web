import { memo, useEffect, useState } from 'react'
import { IconLoader } from './icons/ToolIcons'
import { api } from '../hooks/useApi'
import { formatError } from '../utils/format-error'

/**
 * Read-only renderer for an MCP Apps (SEP-1865) tool UI.
 *
 * The HTML comes from `GET /sessions/:id/mcp-app-resource` — the server
 * validates the `ui://` scheme and `text/html` mime, then forwards the
 * CLI-fetched document verbatim. It is UNTRUSTED third-party content: the
 * iframe is sandboxed with `allow-scripts` and deliberately WITHOUT
 * `allow-same-origin`, so the document runs in an opaque origin — scripts
 * execute, but the content can never reach this app's DOM, cookies,
 * localStorage or any same-origin API. The UI↔session postMessage channel
 * (`ui_surface_v1`) is intentionally absent at this step: no channel back
 * means nothing to authorize.
 */

const FRAME_HEIGHT = 360

export const McpAppFrame = memo(function McpAppFrame({ sessionId, server, resourceUri, toolName }: {
  sessionId: string
  server: string
  resourceUri: string
  toolName: string
}) {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Fetch on mount (the section only exists while expanded — lazy by
  // construction), once per (session, server, uri).
  useEffect(() => {
    let alive = true
    setError(null)
    api
      .get<{ mimeType: string; html: string }>(
        `/sessions/${sessionId}/mcp-app-resource?server=${encodeURIComponent(server)}&uri=${encodeURIComponent(resourceUri)}`,
      )
      .then((r) => {
        if (alive) setHtml(r.html)
      })
      .catch((e) => {
        if (alive) setError(formatError(e))
      })
    return () => {
      alive = false
    }
  }, [sessionId, server, resourceUri])

  if (error) {
    return (
      <div className="mcp-app-note mcp-app-error" role="alert">
        Couldn't load app UI for {toolName}: {error}
      </div>
    )
  }
  if (html === null) {
    return (
      <div className="mcp-app-note">
        <IconLoader size={12} className="settings-card-spin" /> Loading app UI…
      </div>
    )
  }
  return (
    <iframe
      className="mcp-app-frame"
      title={`App UI: ${toolName}`}
      sandbox="allow-scripts"
      srcDoc={html}
      style={{ height: FRAME_HEIGHT }}
    />
  )
})
