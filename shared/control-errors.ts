// Shared SDK-control error classification.
//
// The CLI reports MCP/control failures as opaque transport-level strings
// ("Connection closed", "timed out", …) with no structured root cause, and
// MCP-server stderr never reaches the host. This module maps the KNOWN raw
// messages to a small error taxonomy (code + human title + actionable hint);
// unknown messages classify to null so callers keep showing the raw text
// instead of a made-up explanation. Both server (HttpError body) and client
// (McpServerCard) import this single source of truth.

export type ControlErrorCode = 'connection-closed' | 'timeout' | 'spawn-failure'

export interface ControlErrorInfo {
  code: ControlErrorCode
  /** Short headline for the failure. */
  title: string
  /** Actionable explanation — usual causes and what to do next. */
  hint: string
}

/** Classify a raw upstream error message. Matching is deliberately
 *  substring/regex-based and case-insensitive — the CLI's wording is not a
 *  contract. Returns null when nothing matches. Copy states only what the
 *  transport text proves: "Connection closed" does not reveal WHEN or WHY the
 *  process died, so the hint names the possibilities instead of asserting one. */
export function classifyControlError(raw: string): ControlErrorInfo | null {
  const s = raw.toLowerCase()
  // Spawn check comes FIRST: a launch failure whose echoed message mentions
  // the close or a timeout flag ("spawn npx: connection closed",
  // "--request-timeout 30") must classify as a launch failure, not as a
  // dropped connection. Word-boundary on "spawn" so "respawn throttled"
  // doesn't misclassify either.
  if (/\bspawn\b|enoent|einval|e2big/.test(s)) {
    return {
      code: 'spawn-failure',
      title: 'Failed to launch the server command',
      hint:
        'The command could not be spawned — check the command name, its arguments, and that the binary exists on PATH.',
    }
  }
  if (s.includes('connection closed')) {
    return {
      code: 'connection-closed',
      title: 'Server connection lost',
      hint:
        'The server process may have failed to start, crashed, or exited. If it never connected, common causes are expired registry credentials (npm E401), a failed package fetch, or a missing command — the server\'s start command, run in a terminal, will show the real error.',
    }
  }
  // Word boundaries so "timeoutMs" inside an echoed config doesn't match;
  // a URL path containing "timeout" can still trip this — accepted residue
  // of pattern-matching on non-contractual CLI text. `etimedout` is the
  // canonical Node socket-failure code (no space, no boundary to anchor).
  if (/\btimed out\b|\btimeout\b|etimedout/.test(s)) {
    return {
      code: 'timeout',
      title: 'Connection timed out',
      hint:
        'The server did not respond in time — it may be starting slowly or the network path may be down. Try Reconnect, or run the server\'s start command in a terminal to check.',
    }
  }
  return null
}
