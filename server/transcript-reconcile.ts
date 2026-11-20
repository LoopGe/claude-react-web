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
import { isEmptyResultFrame } from '../shared/results.js'
import { frameKindOf, LIFECYCLE_KEYS, semanticEquivalent, type ProjectionEntry, type TombstoneKind } from './transcript-projection.js'

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

/** A rebuild was refused BEFORE any public projection/generation mutation
 *  because an incapable browser subscriber is attached (spec §8.3). Not a
 *  degradation: the old generation stays fully usable; the user must reload
 *  the legacy tab and retry. */
export class TranscriptRebuildBlockedError extends Error {
  constructor(readonly reason: 'client-upgrade-required') {
    super(reason)
  }
}

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

/** Turn-anchor input for the live rebuild trigger (spec §8.1). The composition
 *  layer supplies the incoming result's turn anchor — the uuid of the turn's
 *  LAST main-thread assistant message (the pump's lastAssistantUuid, the same
 *  pairing recordResultFrame persists). Cheap turn-terminal evidence: no
 *  provider-log read / full canonical compose per result. */
export interface RebuildTriggerAnchors {
  assistantUuid?: string | null
}

/** Live anomaly detector (spec §8.1, auto-rebuild Task 3): decides whether an
 *  incoming live result/completion may append at the seq tail or must trigger
 *  an ordered rebuild. PURE — operates on the in-memory projection the manager
 *  supplies (cheap identities: detection matches by uuid+frameKind and scans
 *  turn membership, never occurrenceId, so no per-entry semantic hashing).
 *
 *  rebuild-required when:
 *   - a same-uuid+frameKind result/completion already exists with NON-equivalent
 *     content (a semantic revision — §5.3 forbids in-place content swaps; the
 *     append path's uuid dedup would otherwise silently keep the stale copy);
 *   - the incoming RESULT's canonical turn-terminal position (after every turn
 *     member, before the next root prompt — turnTerminalIndex) PRECEDES the
 *     current tail: the next turn's root prompt was already published, so a
 *     tail append would invert chronology (the A,U,R incident shape live).
 *
 *  append-only otherwise — including the normal tail result (terminal == tail)
 *  and every non-result/completion frame (a queued user send is never a trigger;
 *  T7b's queued-not-published guarantee). Live completions (task_notification)
 *  get the revision check only: their canonical live position IS the arrival
 *  tail (§5.1 live-only record; §7.2.3 places them after the launch ack with a
 *  completedAt-crossable weak upper bound), so they carry no turn-terminal
 *  constraint to invert. Empty result bookends are excluded before identity/
 *  placement (§5.1). An absent anchor is no position evidence → append-only.
 *
 *  CLOSED-ANCHOR guard: lastAssistantUuid is never cleared between turns, so a
 *  result for a LATER turn that produced no assistant yet (an interrupt or
 *  immediate API error before the first model round-trip) arrives with a STALE
 *  anchor pointing at the previous turn's assistant. If a NON-EMPTY result
 *  already sits among the anchor's turn members (before the next root prompt),
 *  that turn is already CLOSED — the incoming result belongs to a later turn and
 *  appends at the tail, NOT an inversion. Without this guard a routine Stop press
 *  would false-trigger (and the stale sidecar pairing would compound into a
 *  dropped footer at rebuild). An EMPTY bookend does NOT close the turn, so the
 *  genuine held-back-result anomaly (only an empty bookend after the anchor)
 *  still triggers. */
export function detectRebuildTrigger(
  old: ProjectionEntry[],
  incoming: ProjectionEntry,
  anchors: RebuildTriggerAnchors,
): 'append-only' | 'rebuild-required' {
  const m = obj(incoming.msg)
  const isResult = m?.type === 'result'
  const isCompletion = m?.type === 'system' && m?.subtype === 'task_notification'
  if (!isResult && !isCompletion) return 'append-only'
  if (isResult && isEmptyResultFrame(incoming.msg as { type?: string })) return 'append-only'

  // Same-uuid semantic revision (result OR completion).
  const uuid = uuidOf(incoming.msg)
  if (uuid !== null) {
    const fk = frameKindOf(incoming.msg)
    const prior = old.find((e) => uuidOf(e.msg) === uuid && frameKindOf(e.msg) === fk)
    if (prior && !semanticEquivalent(prior.msg, incoming.msg)) return 'rebuild-required'
  }

  // Turn-terminal position check: results only (see docblock for completions).
  if (!isResult) return 'append-only'
  const anchor = anchors.assistantUuid
  if (typeof anchor !== 'string' || anchor.length === 0) return 'append-only'
  // Mirror turnTerminalIndex's anchor resolution (assistant preferred, any
  // uuid match fallback); an absent anchor is no position evidence.
  let aIdx = old.findIndex((e) => obj(e.msg)?.type === 'assistant' && uuidOf(e.msg) === anchor)
  if (aIdx < 0) aIdx = old.findIndex((e) => uuidOf(e.msg) === anchor)
  if (aIdx < 0) return 'append-only'
  // Single scan to the turn terminal (same boundary rule as turnTerminalIndex),
  // with the CLOSED-ANCHOR guard: a non-empty result among the members means the
  // anchor's turn already terminated, so the incoming result belongs to a later
  // turn (stale anchor on an interrupt/immediate-error) → tail append.
  const aStop = stopReasonOf(old[aIdx])
  let end = aIdx
  for (let i = aIdx + 1; i < old.length; i++) {
    const e = old[i]
    if (isTurnBoundary(e, aStop)) break
    const em = obj(e.msg)
    if (em?.type === 'result' && !isEmptyResultFrame(e.msg as { type?: string })) return 'append-only'
    end = i
  }
  return end + 1 < old.length ? 'rebuild-required' : 'append-only'
}

/** Whether entry `e` bounds the turn whose last assistant has stop reason
 *  `aStop`: the next root prompt ends the turn. A provider root prompt is an
 *  unconditional boundary; an app-source user prompt is a boundary UNLESS the
 *  assistant stopped on tool_use (then it is a mid-turn steering supplement —
 *  a turn member). Shared by turnTerminalIndex and detectRebuildTrigger so the
 *  builder's placement and the live trigger's scan cannot drift. */
function isTurnBoundary(e: ProjectionEntry, aStop: unknown): boolean {
  if (!isUserPrompt(e)) return false
  if (e.source === 'provider') return true
  return e.source === 'app' && aStop !== 'tool_use'
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
    if (isTurnBoundary(out[i], aStop)) break
    end = i
  }
  return end + 1
}

function resultAssistantUuid(e: ProjectionEntry): string | null {
  const a = obj(e.msg)?.assistantUuid
  return typeof a === 'string' ? a : null
}

/** Insertion index for an app-only occurrence using its old canonical anchors
 *  and strong semantic constraints (spec §7.2). `trailingCount` tracks how many
 *  app entries were already inserted after each prev anchor so successive
 *  trailing entries (e.g. a handoff boundary+summary) keep their old order
 *  instead of reversing (each fresh pIdx+1 would otherwise re-insert at slot 1). */
function appInsertIndex(
  a: ProjectionEntry,
  old: ProjectionEntry[],
  out: ProjectionEntry[],
  trailingCount: Map<string, number>,
): number {
  const rUuid = resultAssistantUuid(a)
  if (obj(a.msg)?.type === 'result' && rUuid) return turnTerminalIndex(out, rUuid)
  const oldIdx = old.indexOf(a)
  let prev: ProjectionEntry | null = null
  let next: ProjectionEntry | null = null
  for (let i = oldIdx - 1; i >= 0; i--) if (!isApp(old[i])) { prev = old[i]; break }
  for (let i = oldIdx + 1; i < old.length; i++) if (!isApp(old[i])) { next = old[i]; break }
  if (isUserPrompt(a)) {
    // A trailing root prompt appends after the whole canonical run (out.length
    // advances naturally); a bounded one goes before its old next anchor (fresh
    // nIdx already accounts for earlier insertions shifting the anchor).
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
    if (pIdx >= 0) {
      const count = trailingCount.get(prev.occurrenceId) ?? 0
      trailingCount.set(prev.occurrenceId, count + 1)
      return pIdx + 1 + count
    }
  }
  return out.length
}

/** Align unmatched old (app-classified) occurrences to canonical by the spec
 *  §5.2 base identity `uuid+frameKind` BEFORE the ordered rebuild.
 *
 *  The composition layer disambiguates occurrence identity with a semantic
 *  content hash. A live wire frame and the CLI's persisted final frame of the
 *  SAME logical message legitimately differ in usage/stop_reason (streaming
 *  pre-finalization vs final), which §5.3 keeps semantic — so the twins hash
 *  differently, the old copy classifies as app-only, and the rebuild would
 *  insert it beside its canonical twin (one uuid, two seqs: the resume-
 *  duplicate incident). A UNIQUE uuid+frameKind match proves the old entry is
 *  that canonical occurrence's wire twin, not a distinct occurrence:
 *
 *    - the old entry adopts the canonical occurrenceId/msg/source, so the
 *      builder's identity-conflict check sees equivalent content and the
 *      app-only insertion loop skips it;
 *    - lifecycle metadata merges onto the canonical copy (canonical values
 *      win — §5.3);
 *    - eviction OR-merges onto the canonical copy (§5.4: a retraction covers
 *      every copy of the occurrence).
 *
 *  Zero or multiple canonical candidates leave the old entry untouched —
 *  multiple same-key canonical entries are §5.2's legitimate multi-occurrence
 *  case (or an ambiguity the hash identity/bridge machinery must resolve);
 *  guessing a merge there would drop data. Pure: inputs are never mutated. */
export function alignOldByUuid(
  old: ProjectionEntry[],
  canonical: ProjectionEntry[],
): { old: ProjectionEntry[]; canonical: ProjectionEntry[] } {
  // No blanket "no app entries" early return here: a corrupt store can hold
  // two identical hash-matched rows for one retracted occurrence with no app
  // twin at all, and the eviction OR below must still reach the builder. The
  // clone cost is marginal next to the per-message semantic hashing the
  // composition layer already runs; the untouched-inputs return is below.
  const canonOut = canonical.map((c) => ({ ...c, aliases: [...c.aliases] }))
  const byKey = new Map<string, ProjectionEntry[]>()
  const byOcc = new Map<string, ProjectionEntry>()
  for (const c of canonOut) {
    byOcc.set(c.occurrenceId, c)
    const u = uuidOf(c.msg)
    if (u === null) continue
    const key = u + ':' + frameKindOf(c.msg)
    const list = byKey.get(key)
    if (list) list.push(c)
    else byKey.set(key, [c])
  }
  // Phase 1: resolve alignment targets and accumulate evicted/lifecycle state.
  // Eviction OR-merges from EVERY old copy that names the occurrence — including
  // hash-matched provider copies — because the builder's oldByOcc is last-wins:
  // an aligned entry reporting only its own flag could shadow an evicted twin
  // and resurrect a retracted message (§5.4).
  const targets = new Map<ProjectionEntry, ProjectionEntry>()
  const lifecycle = new Map<ProjectionEntry, Loose>()
  let evictedTouched = false
  for (const e of old) {
    const matched = byOcc.get(e.occurrenceId)
    if (matched && e.evicted && !matched.evicted) {
      matched.evicted = true
      evictedTouched = true
    }
    if (e.source !== 'app') continue
    const u = uuidOf(e.msg)
    if (u === null) continue
    const candidates = byKey.get(u + ':' + frameKindOf(e.msg))
    if (!candidates || candidates.length !== 1) continue
    const c = candidates[0]
    c.evicted = c.evicted || e.evicted
    targets.set(e, c)
    // Among multiple wire twins the NEWEST delivery stamp wins (max): a
    // positional first-merge would let an older copy's consumedAt block a
    // newer one's. Canonical values still win over all of them (phase 2).
    const em = obj(e.msg)
    if (!em) continue
    for (const k of LIFECYCLE_KEYS) {
      const v = em[k]
      if (v == null) continue
      let add = lifecycle.get(c)
      if (!add) {
        add = {}
        lifecycle.set(c, add)
      }
      const prev = add[k]
      if (prev == null || (typeof v === 'number' && typeof prev === 'number' && v > prev)) add[k] = v
    }
  }
  // Nothing aligned AND no eviction merged: return the originals untouched.
  // When an eviction OR landed on a canonical clone (a hash-matched retracted
  // copy with no alignable app twin), the merged canonical must still ship —
  // dropping it would let the builder's last-wins oldByOcc resurrect the
  // retracted occurrence from a visible identical copy.
  if (targets.size === 0 && !evictedTouched) return { old, canonical }
  // Phase 2: apply the accumulated lifecycle onto the canonical clones (only
  // where canonical lacks a value), then rewrite the aligned old entries to
  // the canonical identity/content/evicted state.
  for (const [c, add] of lifecycle) {
    const cm = obj(c.msg)
    const missing: Loose = {}
    let any = false
    for (const k of LIFECYCLE_KEYS) {
      if (add[k] != null && cm?.[k] == null) {
        missing[k] = add[k]
        any = true
      }
    }
    if (any) c.msg = { ...(c.msg as Loose), ...missing }
  }
  const oldOut = old.map((e) => {
    const c = targets.get(e)
    if (!c) return e
    return { ...e, occurrenceId: c.occurrenceId, msg: c.msg, source: c.source, evicted: c.evicted }
  })
  return { old: oldOut, canonical: canonOut }
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
  const trailingCount = new Map<string, number>()
  for (const a of input.old.filter((e) => isApp(e) && !merged.has(e) && !out.some((c) => c.occurrenceId === e.occurrenceId))) {
    const idx = appInsertIndex(a, input.old, out, trailingCount)
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
