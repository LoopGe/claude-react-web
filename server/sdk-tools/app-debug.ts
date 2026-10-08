// Dev-only first-party `appdebug` in-process MCP server.
//
// Gives the agent a view of the HOST process it is running inside — the
// in-process log ring, the metrics registry, per-session internals, and three
// permission-gated runtime writes — rather than of the workspace (that is what
// the `git-tools` git server is for).
//
// REACHABILITY IS THE SECURITY BOUNDARY: this module is only ever imported by
// `server/dev-mode.ts`, whose `enableDevMode` the CLI calls when the server
// runs from TypeScript source. `firstPartyRegistry.injectAll` only iterates
// REGISTERED servers, so a published `dist/cli.mjs` run cannot expose these
// tools through configuration alone.
//
// Handlers bind a `DebugHost` — a narrow structural slice of SessionManager —
// so this module never touches session internals and tests can pass a fake.
//
// The read tools go into `readOnlyToolNames`, which is the single source
// `permission-broker.ts` consults for its first-party read-only exemption (the
// SDK's own readOnlyHint annotation is not surfaced through canUseTool). The
// write tools are deliberately NOT in that set, so they prompt like any other
// tool. There is no `mutatingToolNames`: nothing here touches the worktree, so
// git-broadcast must not schedule a snapshot for them.

import { z } from 'zod'
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { FirstPartyToolServer } from './types.js'
import type { DebugSessionDetail, DebugSessionSummary } from '../session-types.js'
import type { ClientDebugOp, DomComputedStylesParams, DomEvalParams, DomQueryParams, DomScreenshotParams } from '../../shared/client-debug.js'
import {
  getLogConfig,
  getLogFilePath,
  isFileLoggingEnabled,
  isLogRingEnabled,
  readLogRing,
  setLogConfig,
  type LogLevel,
} from '../log.js'
import { metrics } from '../metrics.js'

/** Server name — tool FQN is `mcp__appdebug__{name}`. */
export const DEBUG_TOOLS_SERVER_NAME = 'appdebug'

/** Bare read-only tool names. Membership here is what makes the permission
 *  broker auto-approve the call in every mode. The dom_* reads only observe
 *  the browser tab's DOM (same trust level as reading server logs) — but
 *  note `dom_eval` is deliberately NOT here: it runs arbitrary JS in the
 *  page and must prompt like any other tool. */
export const DEBUG_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'logs',
  'metrics',
  'sessions',
  'session',
  'dom_query',
  'dom_computed_styles',
  'dom_screenshot',
])

/** The slice of SessionManager the debug tools need. Declared structurally so
 *  `app-debug.ts` stays free of session internals and tests can fake it. */
export interface DebugHost {
  debugSessions(): DebugSessionSummary[]
  debugSession(id: string, historyLimit?: number): Promise<DebugSessionDetail>
  setCliDebug(id: string, body: { cliDebug?: boolean | null }): Promise<unknown>
  /** SYNCHRONOUS on SessionManager (`send(id, text): SentUserMessage`) — it
   *  throws synchronously via requireSendable for an unknown/unusable session.
   *  `SentUserMessage` is module-private there, and a sync value-returning
   *  method is assignable to this `void` signature. */
  send(id: string, text: string): void
  /** Dev-only client-debug: broadcast one DOM op to the connected browser
   *  tabs and await the first tab's answer. Rejects when no tab is
   *  connected, the executor failed, or the request timed out. */
  clientDebugRequest(op: ClientDebugOp, params: Record<string, unknown>): Promise<unknown>
}

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

function err(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** Run a handler so no failure can reject the MCP call (a rejection hangs the
 *  turn); every error becomes an `isError` text result instead. */
async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn()
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }
}

/** Pretty-printed JSON result — what every read tool returns. */
function json(value: unknown): CallToolResult {
  return ok(JSON.stringify(value, null, 2))
}

const LEVEL = z.enum(['error', 'warn', 'info', 'debug', 'trace'])

function processInfo(): { pid: number; uptimeSec: number; rssMb: number; nodeVersion: string } {
  return {
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    nodeVersion: process.version,
  }
}

/** Substring-filter the keyed maps of a metrics snapshot. */
function pickSeries<T>(o: Record<string, T>, needle: string): Record<string, T> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => k.includes(needle)))
}

/** The tool definitions for the appdebug server, bound to the host. Exported
 *  separately from the server factory so tests can assert the tool set /
 *  annotations and invoke handlers without owning an McpServer. */
export function buildDebugTools(host: DebugHost): SdkMcpToolDefinition<any>[] {
  const readOnly = { readOnlyHint: true }
  return [
    tool(
      'logs',
      'Read the server process log ring buffer (in-memory, dev only). Filters are ANDed and limit keeps the NEWEST N. level means "at least this severe"; scope is an exact logger-scope match; since is ts>=; grep is case-insensitive on the message. Also reports the current level/scopes and whether file logging is on (with its path, for older history).',
      {
        level: LEVEL.optional(),
        scope: z.string().optional(),
        since: z.number().optional(),
        grep: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
      async (a) =>
        guard(async () => {
          const { lines, total, dropped } = readLogRing({
            level: a.level as LogLevel | undefined,
            scope: a.scope,
            since: a.since,
            grep: a.grep,
            limit: a.limit ?? 200,
          })
          return json({
            ...getLogConfig(),
            fileLogging: { enabled: isFileLoggingEnabled(), path: getLogFilePath() ?? undefined },
            ringEnabled: isLogRingEnabled(),
            ringLines: total,
            dropped,
            lines,
          })
        }),
      { annotations: readOnly },
    ),
    tool(
      'metrics',
      'Read the in-process metrics registry snapshot: uptime, gauges, counters, and histograms (p50/p95/p99/max). Optional series is a case-sensitive substring filter over the full series key, including label suffixes (e.g. `http_request_ms:route=GET /api/x`), so it can narrow by label value as well as by metric name.',
      { series: z.string().optional() },
      async (a) =>
        guard(async () => {
          const snap = metrics.snapshot()
          if (!a.series) return json(snap)
          return json({
            ...snap,
            gauges: pickSeries(snap.gauges, a.series),
            counters: pickSeries(snap.counters, a.series),
            histograms: pickSeries(snap.histograms, a.series),
          })
        }),
      { annotations: readOnly },
    ),
    tool(
      'sessions',
      'List every session in the server pool (live and hibernated) with lifecycle, pending counters, queued input count, and background tasks, plus process gauges.',
      {},
      async () => guard(async () => json({ sessions: host.debugSessions(), process: processInfo() })),
      { annotations: readOnly },
    ),
    tool(
      'session',
      'Deep-dive one session: the overview fields plus history-tail routing metadata (no message bodies), withdrawn/prompt uuids, the task table, CLI diagnostics, first-party tool server status, and context usage — BOTH lenses: `contextUsage` is the CLI\'s live rich breakdown, `cachedContextUsage` is the pump-cached Lite snapshot the WS/ContextBar actually serve, and `contextUsageMismatch` flags when the two disagree by more than 1.5× (the "one lens is lying" signal). Works for dormant sessions too; cli, toolServers, contextUsage and cachedContextUsage are null off-live.',
      { id: z.string(), history: z.number().int().min(0).max(200).optional() },
      async (a) => guard(async () => json(await host.debugSession(a.id, a.history))),
      { annotations: readOnly },
    ),
    tool(
      'dom_query',
      'Query the connected browser tab\'s DOM (dev-only; requires the web UI open). Returns per-node tag/id/classes/text summary plus truncated outerHTML. selector is a CSS selector; maxNodes caps results (default 10); includeHtml=false drops the HTML bodies. Answers from the FIRST tab that responds.',
      {
        selector: z.string().min(1),
        maxNodes: z.number().int().min(1).max(50).optional(),
        includeHtml: z.boolean().optional(),
      },
      async (a) =>
        guard(async () =>
          json(await host.clientDebugRequest('dom_query', a satisfies DomQueryParams)),
        ),
      { annotations: readOnly },
    ),
    tool(
      'dom_computed_styles',
      'Read the computed CSS of the first element matching a CSS selector in the connected browser tab (dev-only; requires the web UI open). Pass properties to narrow to a subset; omit it to get a curated set of common layout/typography/color properties.',
      {
        selector: z.string().min(1),
        properties: z.array(z.string()).optional(),
      },
      async (a) =>
        guard(async () =>
          json(await host.clientDebugRequest('dom_computed_styles', a satisfies DomComputedStylesParams)),
        ),
      { annotations: readOnly },
    ),
    tool(
      'dom_screenshot',
      'Render a node (or the whole viewport when selector is omitted) of the connected browser tab to a PNG data URL via SVG foreignObject serialization (dev-only; requires the web UI open; no external deps). Fidelity is approximate — external images/CORS fonts may be missing.',
      { selector: z.string().optional() },
      async (a) =>
        guard(async () =>
          json(await host.clientDebugRequest('dom_screenshot', a satisfies DomScreenshotParams)),
        ),
      { annotations: readOnly },
    ),
    tool(
      'set_log',
      'Change the server log level and/or scope filter at runtime. Omit a key to leave it unchanged; scopes: [] clears the filter (server-wide, not per session).',
      { level: LEVEL.optional(), scopes: z.array(z.string()).optional() },
      async (a) => guard(async () => json(setLogConfig({ level: a.level as LogLevel | undefined, scopes: a.scopes }))),
    ),
    tool(
      'set_cli_debug',
      'Toggle per-session CLI debug logging (captures the claude subprocess stderr for that session). null clears the per-session override and re-inherits the global value. Applies on the next session start.',
      { sessionId: z.string(), cliDebug: z.boolean().nullable() },
      async (a) => guard(async () => json(await host.setCliDebug(a.sessionId, { cliDebug: a.cliDebug }))),
    ),
    tool(
      'send_message',
      'Send a user message into a session (any session, not just the caller). The full path of POST /sessions/:id/messages — use it to drive a reproduction.',
      { sessionId: z.string(), text: z.string() },
      async (a) =>
        guard(async () => {
          host.send(a.sessionId, a.text)
          return ok(`sent ${a.text.length} char(s) to ${a.sessionId}`)
        }),
    ),
    tool(
      'dom_eval',
      'Evaluate JavaScript in the connected browser tab\'s page context (dev-only; requires the web UI open). The code runs as an async function body; the result is JSON-safe serialized. NOT read-only: it can mutate the page and may execute more than once (every connected tab races to answer), so use it for inspection, not for stateful edits.',
      { code: z.string().min(1) },
      async (a) =>
        guard(async () =>
          json(await host.clientDebugRequest('dom_eval', a satisfies DomEvalParams)),
        ),
    ),
  ]
}

/** Build the appdebug first-party server bound to a host. `requiresCwd` is
 *  false because these tools inspect the process, not a workspace. */
export function createDebugAppTools(host: DebugHost): FirstPartyToolServer {
  return {
    name: DEBUG_TOOLS_SERVER_NAME,
    description: 'Dev-only host introspection tools (logs, metrics, session internals)',
    defaultEnabled: true,
    requiresCwd: false,
    buildTools: () => buildDebugTools(host),
    readOnlyToolNames: DEBUG_READ_ONLY_TOOLS,
  }
}
