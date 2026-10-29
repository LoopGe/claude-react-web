// Task 1 (session-synchronizer): the ContextUsage type relocated verbatim
// from `hooks/useChatStream`. The hook used to own and re-export this shape;
// pulling it into a dedicated type module lets the context components and
// the future SessionSynchronizer depend on it without dragging in the whole
// ChatStream surface. The interface body is byte-for-byte the former
// `useChatStream.ContextUsage`.
import type { SkillFrontmatter } from '../types'

export interface ContextUsage {
  totalTokens?: number
  maxTokens?: number
  rawMaxTokens?: number
  percentage?: number
  model?: string
  /** Tokens written to the cache on this turn. Present when the source
   *  iteration reports it; absent otherwise. */
  cacheCreationTokens?: number
  /** Tokens served from cache on this turn (cache hit). Present when the
   *  source iteration reports it; absent otherwise. */
  cacheReadTokens?: number
  /** Output tokens the model generated on this API call. Present when the
   *  source reports it; absent otherwise. */
  outputTokens?: number
  /** Token count at which the SDK's auto-compact triggers. Present once a
   *  `result` has supplied the model's context window; the bar renders
   *  "X% until auto-compact" from it. */
  autoCompactThreshold?: number
  /** The model's advertised max output tokens, surfaced so the draggable
   *  marker can invert a threshold position back into Settings.autoCompactWindow
   *  exactly (mirror of the server's LiteContextUsage.maxOutputTokens). */
  maxOutputTokens?: number
  /** Whether the CLI says auto-compact is on. Three state: `true`/`false` are
   *  CLI-authoritative; `null` / absent means unknown — the bar must not claim
   *  "off" from a formula-only reading. `null` is the explicit cleared form
   *  (survives JSON + spread-merge over a stale detailed payload). */
  autoCompactEnabled?: boolean | null
  skills?: {
    includedSkills: number
    totalSkills: number
    tokenCount: number
    skillFrontmatter?: SkillFrontmatter[]
  }
  agents?: {
    tokenCount: number
    agents?: Array<{ agentType: string; source: string; tokens: number }>
  }
  /** Two generations, like mcpTools: the old aggregate `{ tokenCount }`
   *  (feeds the no-categories fallback row) and — SDK 0.3.311+ — the
   *  per-file array `{ path, type?, tokens }` (aggregated into the same
   *  fallback row). Classify on `Array.isArray` before use. */
  memoryFiles?: { tokenCount: number } | Array<{ path: string; type?: string; tokens: number }>
  /** Per-MCP-server context breakdown (detailed payload only). Shape has
   *  TWO generations: the old aggregate `{ tokenCount }` (fed the
   *  no-categories fallback row) and — SDK 0.3.304+ — the per-tool array
   *  `{ name, serverName, tokens, isLoaded? }` the per-server section
   *  aggregates. Classify on `Array.isArray` before use. */
  mcpTools?: { tokenCount: number } | Array<{ name: string; serverName: string; tokens: number; isLoaded?: boolean }>
  /** Each server's share of the 'mcp_instructions' category row (SDK
   *  0.3.304+), estimated by the CLI from the length of its text. Present
   *  only where the CLI answers on its own stdio. */
  mcpInstructions?: Array<{ serverName: string; tokens: number }>
  /** Canonical context rows from the SDK control response (0.3.268). Classify
   *  on `kind` — 'used' occupies the window, 'free' is the remainder,
   *  'buffer' is the compaction reserve, 'deferred' is an out-of-window tool
   *  schema listed for awareness — never on the English `name`. */
  categories?: Array<{
    name: string
    tokens: number
    kind: 'used' | 'free' | 'buffer' | 'deferred'
  }>
}
