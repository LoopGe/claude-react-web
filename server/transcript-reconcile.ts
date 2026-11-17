/**
 * transcript-reconcile — ordered reconcile decision + projection builder (spec §6/§7).
 *
 * Pure: no node:fs. Operates on ProjectionEntry[] supplied by the composition
 * layer (SessionManager). `canonical` is the authoritative provider order;
 * `old` is the persisted projection (provider/result/app). The builder places
 * app-only occurrences by their old anchors + strong semantic constraints
 * (result turn terminal, completion launch), merges prompt bridges, includes
 * pending operations exactly once, and applies tombstones by identity.
 *
 * Turn-terminal placement uses a stop_reason/source heuristic here; the
 * composition layer (Task 6) refines it with TurnAnchorStore membership.
 */

import { isDeepStrictEqual } from 'node:util'
import { assistantMessageShapeOf } from '../shared/assistant-message.js'
import { semanticEquivalent, type ProjectionEntry, type TombstoneKind } from './transcript-projection.js'

export type { ProjectionEntry } from './transcript-projection.js'

export type ReconcileMode = 'append-only' | 'ordered-rebuild'

export interface PendingOperation {
  operationId: string
  entry: ProjectionEntry
}

export interface ReconcileInput {
  old: ProjectionEntry[]
  canonical: ProjectionEntry[]
  pending: PendingOperation[]
  oldTombstones: Array<{ occurrenceId: string; kind: TombstoneKind }>
}

export type ReconcileError =
  | 'identity-conflict'
  | 'source-lost'
  | 'ambiguous-legacy-identity'
  | 'ambiguous-prompt-alias'
  | 'ambiguous-result-series'
  | 'ambiguous-app-placement'
  | 'result-anchor-missing'
  | 'unmapped-tombstone'
  | 'sidecar-missing'

type Loose = Record<string, unknown>
const obj = (m: unknown): Loose | null => (m !== null && typeof m === 'object' ? (m as Loose) : null)
const uuidOf = (m: unknown): string | null => {
  const u = obj(m)?.uuid
  return typeof u === 'string' ? u : null
}
const isApp = (e: ProjectionEntry): boolean => e.source === 'app'

function isToolResult(m: unknown): boolean {
  const content = obj(obj(m)?.message)?.content
  return Array.isArray(content) && content.some((b) => obj(b)?.type === 'tool_result')
}
function isUserPrompt(e: ProjectionEntry): boolean {
  const m = obj(e.msg)
  return m?.type === 'user' && !isToolResult(e.msg) && m.isCompactSummary !== true
}
function stopReasonOf(e: ProjectionEntry): unknown {
  return obj(obj(e.msg)?.message)?.stop_reason
}

/** Known content/form supersessions (spec §5.3) — not identity conflicts. */
function isKnownSupersession(o: ProjectionEntry, c: ProjectionEntry): boolean {
  if (o.source === 'result' && c.source === 'result') return true
  if (c.occurrenceId.startsWith('subagent-completion:') || c.occurrenceId.startsWith('native-tool-repair:')) return true
  const os = assistantMessageShapeOf(o.msg)
  const cs = assistantMessageShapeOf(c.msg)
  if (os?.blocks && cs?.blocks && os.id === cs.id && cs.blocks.length > os.blocks.length) return true
  return false
}

/** Append-only iff the old canonical sequence is an identical ordered prefix of
 *  the new one, no app-only occurrence would be displaced by new canonical
 *  items, matched content is equivalent, and no new retraction appeared (spec §6.1). */
export function decideReconcile(input: ReconcileInput): { mode: ReconcileMode } {
  const oldCanon = input.old.filter((e) => !isApp(e))
  const newCanon = input.canonical
  if (oldCanon.length > newCanon.length) return { mode: 'ordered-rebuild' }
  for (let i = 0; i < oldCanon.length; i++) {
    if (oldCanon[i].occurrenceId !== newCanon[i].occurrenceId) return { mode: 'ordered-rebuild' }
    if (!semanticEquivalent(oldCanon[i].msg, newCanon[i].msg)) return { mode: 'ordered-rebuild' }
  }
  const hasApp = input.old.some(isApp)
  if (hasApp && newCanon.length > oldCanon.length) return { mode: 'ordered-rebuild' }
  const oldByOcc = new Map(input.old.map((e) => [e.occurrenceId, e]))
  const newRetraction = input.oldTombstones.some(
    (t) => t.kind === 'retraction' && oldByOcc.get(t.occurrenceId)?.evicted !== true,
  )
  if (newRetraction) return { mode: 'ordered-rebuild' }
  return { mode: 'append-only' }
}

/** Insertion index for a result/pending entry at its assistant's turn terminal
 *  (after every turn member, before the next root prompt). A mid-turn steering
 *  supplement (app-source user after a tool_use assistant) is NOT a boundary. */
function turnTerminalIndex(out: ProjectionEntry[], assistantUuid: string): number {
  let aIdx = out.findIndex((e) => obj(e.msg)?.type === 'assistant' && uuidOf(e.msg) === assistantUuid)
  if (aIdx < 0) aIdx = out.findIndex((e) => uuidOf(e.msg) === assistantUuid)
  if (aIdx < 0) throw new Error('result-anchor-missing')
  const aStop = stopReasonOf(out[aIdx])
  let end = aIdx
  for (let i = aIdx + 1; i < out.length; i++) {
    const e = out[i]
    if (isUserPrompt(e)) {
      if (e.source === 'provider') break
      if (e.source === 'app' && aStop !== 'tool_use') break
    }
    end = i
  }
  return end + 1
}

function resultAssistantUuid(e: ProjectionEntry): string | null {
  const a = obj(e.msg)?.assistantUuid
  return typeof a === 'string' ? a : null
}

/** Insertion index for an app-only occurrence using its old canonical anchors
 *  and strong semantic constraints (spec §7.2). */
function appInsertIndex(a: ProjectionEntry, old: ProjectionEntry[], out: ProjectionEntry[]): number {
  const rUuid = resultAssistantUuid(a)
  if (obj(a.msg)?.type === 'result' && rUuid) return turnTerminalIndex(out, rUuid)
  const oldIdx = old.indexOf(a)
  let prev: ProjectionEntry | null = null
  let next: ProjectionEntry | null = null
  for (let i = oldIdx - 1; i >= 0; i--) if (!isApp(old[i])) { prev = old[i]; break }
  for (let i = oldIdx + 1; i < old.length; i++) if (!isApp(old[i])) { next = old[i]; break }
  if (isUserPrompt(a)) {
    // A trailing root prompt goes after the whole canonical run; a bounded one
    // goes before its old next canonical anchor.
    if (next === null) return out.length
    const nIdx = out.findIndex((e) => e.occurrenceId === next!.occurrenceId)
    return nIdx < 0 ? out.length : nIdx
  }
  if (next) {
    const nIdx = out.findIndex((e) => e.occurrenceId === next!.occurrenceId)
    if (nIdx >= 0) return nIdx
  }
  if (prev) {
    const pIdx = out.findIndex((e) => e.occurrenceId === prev!.occurrenceId)
    if (pIdx >= 0) return pIdx + 1
  }
  return out.length
}

/** Build the ordered projection (spec §7). Throws a ReconcileError on any
 *  validation failure; never drops data silently. seq is the array index. */
export function buildOrderedProjection(input: ReconcileInput): ProjectionEntry[] {
  const oldByOcc = new Map(input.old.map((e) => [e.occurrenceId, e]))
  for (const c of input.canonical) {
    const o = oldByOcc.get(c.occurrenceId)
    if (o && !semanticEquivalent(o.msg, c.msg) && !isKnownSupersession(o, c)) {
      throw new Error('identity-conflict')
    }
  }

  const out: ProjectionEntry[] = input.canonical.map((e) => ({ ...e, aliases: [...e.aliases] }))

  // Prompt bridge: an old app prompt whose content uniquely matches a canonical
  // prompt merges into it (alias), rather than appearing twice (spec §7.1).
  const merged = new Set<ProjectionEntry>()
  for (const u of input.old.filter((e) => isApp(e) && isUserPrompt(e))) {
    const matches = out.filter((c) => isUserPrompt(c) && semanticEquivalent(u.msg, c.msg))
    if (matches.length > 1) throw new Error('ambiguous-prompt-alias')
    if (matches.length === 1) {
      const target = matches[0]
      const uUuid = uuidOf(u.msg)
      if (uUuid && !target.aliases.includes(uUuid)) target.aliases.push(uUuid)
      merged.add(u)
    }
  }

  // Remaining app-only occurrences (not merged, not already canonical).
  for (const a of input.old.filter((e) => isApp(e) && !merged.has(e) && !out.some((c) => c.occurrenceId === e.occurrenceId))) {
    const idx = appInsertIndex(a, input.old, out)
    out.splice(idx, 0, { ...a, aliases: [...a.aliases] })
  }

  // Pending operations: a matched occurrence is superseded in place; a new one
  // is inserted at its semantic position. Each appears exactly once (spec §7.1).
  for (const p of input.pending) {
    const idx = out.findIndex((e) => e.occurrenceId === p.entry.occurrenceId)
    if (idx >= 0) {
      out[idx] = { ...p.entry, aliases: [...p.entry.aliases] }
    } else {
      const rUuid = resultAssistantUuid(p.entry)
      const at = obj(p.entry.msg)?.type === 'result' && rUuid ? turnTerminalIndex(out, rUuid) : out.length
      out.splice(at, 0, { ...p.entry, aliases: [...p.entry.aliases] })
    }
  }

  // Whole-message coverage dedup (spec §5.2): a multi-block assistant row whose
  // blocks equal the concatenation of same-response per-block rows is redundant
  // — tombstone it (coverage) and alias its uuid onto the first covering frame.
  const respGroups = new Map<string, { whole: ProjectionEntry[]; singles: ProjectionEntry[] }>()
  for (const e of out) {
    const shape = assistantMessageShapeOf(e.msg)
    if (!shape?.blocks || !shape.id) continue
    const g = respGroups.get(shape.id) ?? { whole: [], singles: [] }
    if (shape.blocks.length > 1) g.whole.push(e)
    else g.singles.push(e)
    respGroups.set(shape.id, g)
  }
  for (const g of respGroups.values()) {
    if (g.whole.length === 0 || g.singles.length === 0) continue
    const merged = g.singles.flatMap((s) => assistantMessageShapeOf(s.msg)?.blocks ?? [])
    for (const w of g.whole) {
      const wBlocks = assistantMessageShapeOf(w.msg)?.blocks ?? []
      if (!isDeepStrictEqual(wBlocks, merged)) continue
      w.evicted = true
      const wUuid = uuidOf(w.msg)
      const first = g.singles[0]
      if (wUuid && !first.aliases.includes(wUuid)) first.aliases.push(wUuid)
    }
  }

  // Tombstones by identity (spec §5.4/§7.3).
  for (const t of input.oldTombstones) {
    const e = out.find((x) => x.occurrenceId === t.occurrenceId)
    if (e) {
      e.evicted = true
      continue
    }
    if (t.kind === 'retraction') throw new Error('unmapped-tombstone')
    // coverage on a deduped/absent occurrence is not an orphan
  }
  for (const e of out) {
    if (oldByOcc.get(e.occurrenceId)?.evicted) e.evicted = true
  }

  validateProjection(out, input)
  return out
}

/** Pre-commit validation (spec §7.4): unique identities, no duplicate pending
 *  occurrence, dense seq assignment (index). Throws on failure. */
export function validateProjection(entries: ProjectionEntry[], input: ReconcileInput): void {
  const seen = new Set<string>()
  for (const e of entries) {
    if (seen.has(e.occurrenceId)) throw new Error('identity-conflict')
    seen.add(e.occurrenceId)
  }
  for (const p of input.pending) {
    const count = entries.filter((e) => e.occurrenceId === p.entry.occurrenceId).length
    if (count !== 1) throw new Error('identity-conflict')
  }
}
