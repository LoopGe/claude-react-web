// The single model-facing name for an MCP tool. The Anthropic API requires
// `^[A-Za-z0-9_-]{1,64}$`, while MCP server and tool names are arbitrary user
// text, so every consumer that needs the name (the native provider's tool
// list, the first-party registry's FQN sets and the client's MCP-Apps map)
// builds it through this function instead of composing the template itself.
//
// The 8-hex suffix is an FNV-1a hash rather than sha1 so the browser bundle
// can import this module without a Node builtin: it makes two inputs that
// differ only in an invalid character distinct and keeps long names stable.

/** The one model-facing tool name for an MCP tool: `mcp__{server}__{tool}`,
 *  sanitized to the Anthropic API charset and ≤64 chars. */
export function mcpToolFqn(server: string, tool: string): string {
  const raw = `mcp__${server}__${tool}`
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, '_')
  if (sanitized === raw && raw.length <= 64) return raw
  let hash = 2166136261
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return `${sanitized.slice(0, 55)}_${hash.toString(16).padStart(8, '0')}`
}
