// Shared CallToolResult helpers for the first-party in-process MCP servers
// (git-tools / appdebug / history-tools). One home for the error-result
// shape: a failed handler must never reject the MCP call (a rejection hangs
// the turn) — `guard` turns every throw into an `isError` text result the
// model can read, and `ok`/`json` are the success shorthands.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/** Clean `CallToolResult` for a successful call. */
export function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

/** `CallToolResult` carrying an error message (surfaced to the model, not a
 *  thrown exception that could reject the MCP call / hang the turn). */
export function err(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** Run a handler so no failure can reject the MCP call; every error becomes
 *  an `isError` text result instead. */
export async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn()
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }
}

/** Pretty-printed JSON result — what the read tools return. */
export function json(value: unknown): CallToolResult {
  return ok(JSON.stringify(value, null, 2))
}
