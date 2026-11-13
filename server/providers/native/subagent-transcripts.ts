// Standalone transcript projection for native subagents. Native history keeps
// every durable sidechain line (including lines before a compact boundary), so
// the reader selects one agent's direct conversation from the shared cache and
// reuses the Claude transcript normalizer for its wire shape.

import type { RawLine } from '../../history-reader.js'
import { normalizeSubagentLine } from '../../subagent-transcripts.js'
import { nativeHistoryCache } from './session-log/cache.js'
import type { NativeSubagentCatalogEntry } from './session-log/subagents.js'
import { publicNativeHistoryLine } from './attachment-projection.js'

function hasPrompt(entry: NativeSubagentCatalogEntry): boolean {
  return typeof entry.prompt === 'string' && entry.prompt.trim().length > 0
}

/** Project one already-selected sidechain line into a standalone transcript.
 *  Removing the persisted parent lets the shared normalizer make assistant and
 *  genuine prompt frames root rows while deriving a tool result's parent from
 *  its own tool_use_id. Cloning the JSON-native frame also isolates nested
 *  content from the normalizer's oversized-result trimming, so cached and
 *  full-recall lines keep their original bytes. */
export function projectNativeSubagentLine(line: RawLine, sessionId: string): unknown | undefined {
  if (line.type !== 'user' && line.type !== 'assistant') return undefined
  const standalone = structuredClone(publicNativeHistoryLine(line))
  delete standalone.parent_tool_use_id
  return normalizeSubagentLine(standalone, sessionId)
}

/** Stable opening prompt for a native descriptor with no durable prompt row. */
export function nativeSubagentPromptFrame(
  entry: NativeSubagentCatalogEntry,
  sessionId: string,
): unknown | null {
  if (!hasPrompt(entry)) return null
  return normalizeSubagentLine({
    type: 'user',
    uuid: `native-subagent-prompt:${entry.agentId}`,
    session_id: sessionId,
    timestamp: entry.timestamp,
    message: {
      role: 'user',
      content: [{ type: 'text', text: entry.prompt! }],
    },
  }, sessionId) ?? null
}

/** Read only the direct durable conversation of one cataloged native agent. */
export async function readNativeSubagentTranscript(
  stateDir: string,
  sessionId: string,
  agentId: string,
): Promise<unknown[]> {
  const loaded = await nativeHistoryCache.load(stateDir, sessionId)
  const entry = loaded?.subagents.byId.get(agentId)
  if (!loaded || !entry) return []

  const output: unknown[] = []
  let hasDurablePrompt = false
  for (const line of loaded.lines) {
    if (line.parent_tool_use_id !== agentId) continue
    const frame = projectNativeSubagentLine(line, sessionId)
    if (frame === undefined) continue
    output.push(frame)
    if (line.type === 'user' && (frame as { parent_tool_use_id?: unknown }).parent_tool_use_id === null) {
      hasDurablePrompt = true
    }
  }

  if (hasDurablePrompt) return output
  const prompt = nativeSubagentPromptFrame(entry, sessionId)
  return prompt === null ? output : [prompt, ...output]
}
