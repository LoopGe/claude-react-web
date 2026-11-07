// First-party `mcp-tools` in-process MCP server (SDK createSdkMcpServer).
//
// Exposes global MCP server management (list / get / add / update / remove /
// set_enabled / test) to the agent as `mcp__mcp-tools__*`. The host owns the
// store, the HTTP-route write semantics (mcp-ops), connection testing and the
// calling session's live MCP attachment, so this module holds no policy of its
// own — it only shapes the tool surface and the two tool-only flags.
//
// Two flags exist only here and must never reach the stored record:
//   - `overwrite`: `add` replaces an existing name only when it is true.
//   - `attachToSession`: default true for `add` / `set_enabled(true)`; set it
//     false to mutate the global config without touching the calling session.
//
// `list` / `get` return the host's already-masked records: env and header
// values never cross back to the model. `test` is not read-only — it spawns or
// connects to the server.

import { z } from 'zod'
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { FirstPartyToolBuildContext, FirstPartyToolServer } from './types.js'
import { guard, json } from './call-result.js'
import type { MaskedMcpServer, McpServerInput, TestConnectionResult } from '../mcp-config.js'

/** Server name — tool FQN is `mcp__mcp-tools__{name}`. */
export const MCP_TOOLS_SERVER_NAME = 'mcp-tools'

/** Bare read-only tool names — permission-broker exemption via the registry.
 *  `test` is deliberately absent: it spawns/connects to the server. */
export const MCP_READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['list', 'get'])

/** Outcome of syncing one server against the calling session's live MCP set.
 *  `alreadyAttached` is NOT a uniform "nothing happened" flag — attach's no-op
 *  is true, detach's is false — so results key on `added` / `removed`. */
export interface McpSessionSyncResult {
  alreadyAttached: boolean
  added: string[]
  removed: string[]
  errors: Record<string, string>
}

/** Structural slice of the host the mcp tools need — declared locally so this
 *  module stays free of session internals and tests can pass a fake. */
export interface McpToolsHost {
  list(): MaskedMcpServer[]
  get(name: string): MaskedMcpServer | null
  create(input: McpServerInput): MaskedMcpServer
  update(name: string, input: Partial<McpServerInput>): MaskedMcpServer
  remove(name: string): void
  setEnabled(name: string, enabled: boolean): MaskedMcpServer
  attach(sessionId: string, name: string): Promise<McpSessionSyncResult>
  detach(sessionId: string, name: string): Promise<McpSessionSyncResult>
  test(name: string): Promise<TestConnectionResult>
}

const NO_SESSION_ERROR = 'this tool requires a live session context'

const TYPE = z
  .enum(['stdio', 'sse', 'http'])
  .describe("transport; defaults to 'stdio'. stdio uses command/args/env, sse/http use url/headers")

/** The stored-record fields, shared by `add` and `update`. */
const SERVER_FIELDS = {
  name: z.string().describe('unique server name (the key other tools address it by)'),
  type: TYPE.optional(),
  command: z.string().optional().describe('stdio: executable to spawn'),
  args: z.array(z.string()).optional().describe('stdio: argv passed to command'),
  env: z.record(z.string(), z.string()).optional().describe('stdio: environment variables for the spawned process'),
  url: z.string().optional().describe('sse/http: server endpoint URL'),
  headers: z.record(z.string(), z.string()).optional().describe('sse/http: request headers (e.g. auth)'),
  alwaysLoad: z.boolean().optional(),
  enabled: z.boolean().optional().describe('global default; omitted means true on create'),
}

/** The tool definitions for the mcp-tools server bound to the host and the
 *  calling session (absent for metadata listing — session sync then fails
 *  loudly on `add` and is skipped elsewhere). Exported separately from the
 *  server builder so tests can invoke handlers without owning an McpServer. */
export function buildMcpTools(host: McpToolsHost, ctx?: FirstPartyToolBuildContext): SdkMcpToolDefinition<any>[] {
  const readOnly = { readOnlyHint: true }
  const sessionId = ctx?.sessionId

  /** Attach/detach against the calling session when there is one. */
  const syncSession = async (mode: 'attach' | 'detach', name: string): Promise<McpSessionSyncResult | null> =>
    sessionId ? host[mode](sessionId, name) : null

  return [
    tool(
      'list',
      'List global MCP servers with their transport, tool-relevant settings and env/header KEY names (values are never returned).',
      {},
      async () => guard(async () => json({ servers: host.list() })),
      { annotations: readOnly },
    ),
    tool(
      'get',
      'Read one global MCP server by name. Secrets stay masked; env/header values are never returned.',
      { name: z.string() },
      async (a) => guard(async () => json({ server: host.get(a.name) })),
      { annotations: readOnly },
    ),
    tool(
      'add',
      'Create a global MCP server and attach it to this session by default. Fails if the name already exists unless overwrite is true (then the stored config is merged, not replaced). Set attachToSession false to only save the config.',
      {
        ...SERVER_FIELDS,
        overwrite: z.boolean().optional().describe("update an existing server's config (merge semantics)"),
        attachToSession: z.boolean().optional().describe('attach to the calling session; defaults to true'),
      },
      async (a) =>
        guard(async () => {
          if (!sessionId) throw new Error(NO_SESSION_ERROR)
          const { overwrite, attachToSession, ...fields } = a
          // The store trims names, so normalize once here: every host call and
          // the result must address the same key regardless of whitespace.
          const name = a.name.trim()
          const input = { ...fields, name }
          const existing = host.get(name)
          if (existing && overwrite !== true) {
            throw new Error(
              `MCP server "${name}" already exists; pass overwrite: true to update its config instead`,
            )
          }
          const saved = existing ? host.update(name, input) : host.create(input)
          const attach = attachToSession === false ? null : await host.attach(sessionId, name)
          return json({ saved, attach })
        }),
    ),
    tool(
      'update',
      'Merge changes into an existing global MCP server (env and headers are merged key-by-key, not replaced). Use add with overwrite to create-or-update.',
      SERVER_FIELDS,
      async (a) =>
        guard(async () => {
          const { name, ...patch } = a
          return json({ server: host.update(name, patch) })
        }),
    ),
    tool(
      'remove',
      'Delete a global MCP server and detach it from this session. The global removal succeeds even if the session detach fails; the detach outcome (or error) is reported.',
      { name: z.string() },
      async (a) =>
        guard(async () => {
          host.remove(a.name)
          let detach: McpSessionSyncResult | { error: string } | null = null
          if (sessionId) {
            try {
              detach = await host.detach(sessionId, a.name)
            } catch (e) {
              detach = { error: e instanceof Error ? e.message : String(e) }
            }
          }
          return json({ removed: true, detach })
        }),
    ),
    tool(
      'set_enabled',
      "Enable or disable a global MCP server. Enabling attaches it to this session (unless attachToSession is false); disabling detaches it.",
      {
        name: z.string(),
        enabled: z.boolean(),
        attachToSession: z.boolean().optional().describe('attach to the calling session when enabling; defaults to true'),
      },
      async (a) =>
        guard(async () => {
          const server = host.setEnabled(a.name, a.enabled)
          const attach = a.enabled
            ? a.attachToSession === false
              ? null
              : await syncSession('attach', a.name)
            : await syncSession('detach', a.name)
          return json({ server, attach })
        }),
    ),
    tool(
      'test',
      'Test a global MCP server connection: spawns/connects to it and reports status, tools and any error. Not read-only — it starts the server process.',
      { name: z.string() },
      async (a) => guard(async () => json(await host.test(a.name))),
    ),
  ]
}

/** Build the mcp-tools first-party server bound to a host. requiresCwd is
 *  false — global MCP config is cwd-independent. */
export function createMcpTools(host: McpToolsHost): FirstPartyToolServer {
  return {
    name: MCP_TOOLS_SERVER_NAME,
    description: 'List, inspect, create, update and remove global MCP servers, and attach them to this session',
    defaultEnabled: true,
    requiresCwd: false,
    buildTools: (_cwd, ctx) => buildMcpTools(host, ctx),
    readOnlyToolNames: MCP_READ_ONLY_TOOLS,
  }
}
