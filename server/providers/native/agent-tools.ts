import type { NativeAgentProfile } from './agent-profile.js'
import type { ToolDef } from './tools/types.js'

/** Apply a profile to the complete builtin + MCP tool snapshot. MCP ownership
 *  is resolved from connection metadata; tool names are never parsed to infer
 *  their owning server. */
export function filterToolsForProfile(
  tools: readonly ToolDef[],
  profile: Pick<NativeAgentProfile, 'tools' | 'disallowedTools' | 'mcpServers'>,
  ownership: ReadonlyMap<string, { name: string }>,
): ToolDef[] {
  const allow = profile.tools === undefined ? undefined : new Set(profile.tools)
  const deny = new Set(profile.disallowedTools ?? [])
  const servers = profile.mcpServers === undefined ? undefined : new Set(profile.mcpServers)
  return tools.filter((tool) => {
    if (allow !== undefined && !allow.has(tool.name)) return false
    if (deny.has(tool.name)) return false
    if (servers === undefined) return true
    const owner = ownership.get(tool.name)
    return owner === undefined || servers.has(owner.name)
  })
}
