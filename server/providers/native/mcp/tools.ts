// server/providers/native/mcp/tools.ts
//
// Adapts the MCP tools discovered by a session's NativeMcpConnections into
// native `ToolDef`s so the in-process loop can offer and run them exactly like
// the builtin tools. One def per discovered tool, named by the shared
// API-safe FQN (`mcpToolFqn`), which is also what the permission broker and
// the client's MCP-Apps mapping see.
//
// `guidance` is empty and deliberately NOT registered as a prompt section:
// the session's system prompt is rendered once at create time, so a
// discovered-later tool cannot add one (and registering would re-register the
// builtins). MCP guidance lives in the tool definition (`description`).

import type { NativeMcpConnections } from './connections.js'
import type { ToolDef } from '../tools/types.js'

/** Base prompt order for MCP tool defs. The builtins stay well below this
 *  (`tools/*.ts` use small orders), so the discovered set appends after them. */
export const MCP_PROMPT_ORDER_BASE = 200

/** One `ToolDef` per tool the connection manager has discovered, in the order
 *  `tools()` returns (server name, then listing order). */
export function mcpToolDefs(conns: NativeMcpConnections): ToolDef[] {
  return conns.tools().map((info, index) => ({
    name: info.fqn,
    description: info.description,
    guidance: '',
    promptOrder: MCP_PROMPT_ORDER_BASE + index,
    schema: info.inputSchema,
    run: (input, ctx) => conns.call(info.fqn, input, ctx.signal),
  }))
}