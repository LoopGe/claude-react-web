// server/providers/native/explore.ts
import type { ToolDef } from './tools/types.js'

export const EXPLORE_AGENT_NAME = 'Explore'
export const EXPLORE_AGENT_INSTRUCTION =
  'Explore the codebase read-only. Use available read-only tools to answer with concrete file references; do not modify files or run state-changing tools.'
export const EXPLORE_AGENT_DESCRIPTION =
  'Read-only codebase exploration with concrete file references.'

/** A final role boundary applied after all ordinary profile filters. */
export function filterExploreTools(tools: readonly ToolDef[]): ToolDef[] {
  return tools.filter((tool) => tool.readOnlyHint === true)
}
