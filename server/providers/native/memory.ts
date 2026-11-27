// server/providers/native/memory.ts
//
// Recall state machine (core) for native auto-memory: candidate exclusion +
// session byte budget, aux-LLM selection with fail-soft degradation, and
// recall-text assembly. Pure logic plus ONE injected aux port call — no fs, no
// session reference. The turn-start wiring (root resolution, model selection,
// bounded reads, supplement enqueue, frame emit) lives in the session (Task 7/8);
// this module only owns the timing/budget/selection decisions the core keeps.
//
// Degradation posture (spec §7.2): an aux failure, abort or malformed selection
// means "no recall this turn" — never a throw into the user path, and never a
// speculative deterministic fallback ranking. The caller passes the deadline
// signal (AbortSignal.timeout(RECALL_DEADLINE_MS)); this module honours it by
// forwarding it to the port and treating the resulting rejection as a skip.
import { createLogger } from '../../log.js'
import type { MemoryCandidate, NativeAuxLlmPort } from './ports.js'

const log = createLogger('native-memory')

/** CLI-measured recall constants (RS §7.3): the per-session surfaced-byte
 *  budget, the turn-start blocking deadline, and the top-k selection cap. */
export const RECALL_SESSION_BUDGET = 61440
export const RECALL_DEADLINE_MS = 2000
export const RECALL_TOP_K = 5

/** Session-level recall state: the paths already surfaced this session (so a
 *  file is never re-injected) and the cumulative surfaced byte count (the
 *  budget walk). Reset on resume/clear/fork, preserved across in-place compact
 *  (spec §10) — the session owns that lifecycle, not this module. */
export interface RecallState {
  surfacedPaths: Set<string>
  surfacedBytes: number
}

export function newRecallState(): RecallState {
  return { surfacedPaths: new Set(), surfacedBytes: 0 }
}

/** Drop candidates already surfaced this session or already read (read-state),
 *  and skip the whole turn once the session byte budget is exhausted. MEMORY.md
 *  is excluded by the port enumeration, so there is deliberately no name filter
 *  here — exclusion is purely path membership + budget. */
export function excludeCandidates(
  cs: MemoryCandidate[],
  s: RecallState,
  readPaths: ReadonlySet<string>,
): MemoryCandidate[] {
  if (s.surfacedBytes >= RECALL_SESSION_BUDGET) return []
  return cs.filter((c) => !s.surfacedPaths.has(c.path) && !readPaths.has(c.path))
}

/** The selector system prompt, verbatim from the design (CLI `jbr` precedent):
 *  top-5 with a relevance floor — an empty array when nothing is relevant. */
const SELECTOR_SYSTEM_PROMPT =
  `Select the memory files relevant to the user's query. Return JSON {"selected_memories":[filenames]}. Select at most 5; return an empty array when nothing is relevant.`

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Ask the aux LLM which candidate files are relevant to the query. Returns the
 *  selected filenames (filtered to known candidates, capped at RECALL_TOP_K),
 *  or [] on any failure — aux throw, abort, malformed JSON, or a non-array
 *  selection. The caller supplies the deadline signal; it is forwarded to the
 *  port, which replaces its built-in timeout with it. */
export async function selectMemories(
  deps: { auxLlm: NativeAuxLlmPort; model: string; credentials: () => { baseUrl: string; authToken: string } },
  query: string,
  candidates: MemoryCandidate[],
  signal: AbortSignal,
): Promise<string[]> {
  if (candidates.length === 0) return []
  const known = new Set(candidates.map((c) => c.filename))
  const candidateList = candidates
    .map((c) => (c.description ? `- ${c.filename}: ${c.description}` : `- ${c.filename}`))
    .join('\n')
  const userContent = `${query}\n\nAvailable memory files:\n${candidateList}`

  let raw: string
  try {
    raw = await deps.auxLlm.call({
      model: deps.model,
      system: SELECTOR_SYSTEM_PROMPT,
      userContent,
      maxTokens: 1024,
      temperature: 0,
      caller: 'memory_recall_select',
      target: deps.credentials(),
      signal,
    })
  } catch (err) {
    log.warn(`recall selection skipped (aux failure/abort): ${errMessage(err)}`)
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    log.warn('recall selection skipped: selector returned malformed JSON')
    return []
  }
  const selected = (parsed as { selected_memories?: unknown } | null)?.selected_memories
  if (!Array.isArray(selected)) {
    log.warn('recall selection skipped: selected_memories is not an array')
    return []
  }
  return selected
    .filter((name): name is string => typeof name === 'string' && known.has(name))
    .slice(0, RECALL_TOP_K)
}

/** Assemble the model-visible recall text: a per-file header (filename) plus
 *  the bounded content. A truncated file carries a hint naming the Read tool
 *  and the file so the model can fetch the full body (CLI `Fwr` precedent).
 *  When the item carries its absolute `path`, the hint names THAT — memory
 *  files live outside the session cwd, so the absolute path is the only
 *  Read-recoverable address; without it the hint falls back to the root-relative
 *  filename (the caller then relies on the # Memory prompt section's directory). */
export function buildRecallText(items: Array<{ filename: string; content: string; truncated: boolean; path?: string }>): string {
  return items
    .map((item) => {
      const body = item.truncated
        ? `${item.content}\n\nThis memory file was truncated. Use the Read tool to view the complete file at: ${item.path ?? item.filename}`
        : item.content
      return `## ${item.filename}\n\n${body}`
    })
    .join('\n\n')
}