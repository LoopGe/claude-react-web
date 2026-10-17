// server/subagent-transcripts.ts
//
// Reads a subagent's on-disk JSONL (`subagents/agent-<id>.jsonl` under the
// session's transcript dir) and converts it to live-wire SDKMessage frames
// via history-reader.normalize() — the SAME conversion the main session's
// disk-paged history uses, so the client reducer ingests both identically.
//
// Line-shape facts verified against 186 real subagent files (2026-10-18
// spike, ~18k lines): every user/assistant line is isSidechain:true and
// carries uuid + timestamp + full message; zero system lines; noise types
// attachment / api-request* exist and are dropped by the default-false
// branch; isMeta appears only on user lines.

import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { findTranscriptFile, normalize, type RawLine } from './history-reader.js'
import { BROADCAST_SYSTEM_SUBTYPES, isInterruptPlaceholder } from './history-utils.js'
import { createLogger } from './log.js'

const log = createLogger('subagent-transcripts')

/** The subagents dir for a session: a DIRECTORY named after the session id,
 *  sibling of the main `<sessionId>.jsonl`. */
export function resolveSubagentDir(mainPath: string, sessionId: string): string {
  return path.join(path.dirname(mainPath), path.basename(sessionId), 'subagents')
}

/** Path of one subagent transcript. `basename()` on BOTH ids so a crafted
 *  id can never traverse out of the projects tree — same guard as
 *  findTranscriptFile's session id. */
export function subagentTranscriptPath(mainPath: string, sessionId: string, agentId: string): string {
  return path.join(resolveSubagentDir(mainPath, sessionId), `agent-${path.basename(agentId)}.jsonl`)
}

/** Renderability for subagent-transcript lines: the shared predicate MINUS
 *  the `isSidechain` gate (every real line in a subagent transcript is one
 *  — the shared gate would drop the whole file) and MINUS the
 *  `parent_tool_use_id` gate (disk lines never carry the field). isMeta
 *  and noise types are excluded exactly like the main transcript. */
export function isRenderableSubagentLine(o: RawLine): boolean {
  if (o.isMeta) return false
  if (o.type === 'user') return !isInterruptPlaceholder(o.message?.content)
  if (o.type === 'assistant' || o.type === 'result' || o.type === 'tool_use_summary') return true
  if (o.type === 'system') return BROADCAST_SYSTEM_SUBTYPES.has(o.subtype ?? '')
  return false
}

/** Read + normalize one subagent's full transcript. Returns [] for a
 *  missing file (the dialog renders its "No transcript on disk" state) —
 *  a missing subagent transcript is the ordinary no-output case, not an
 *  error. */
export async function readSubagentTranscript(sessionId: string, agentId: string): Promise<unknown[]> {
  const main = await findTranscriptFile(sessionId)
  if (!main) return []
  const file = subagentTranscriptPath(main.path, sessionId, agentId)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return []
    log.warn(`read failed session=${sessionId} agent=${agentId}: ${e.message ?? err}`)
    throw err
  }
  const out: unknown[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let o: RawLine
    try {
      o = JSON.parse(line) as RawLine
    } catch {
      continue // corrupt line — skip, same as the history parser's tolerance
    }
    if (!isRenderableSubagentLine(o)) continue
    out.push(normalize(o, sessionId, true))
  }
  return out
}
