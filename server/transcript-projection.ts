/**
 * transcript-projection — pure ordered-projection model (spec §5).
 *
 * Occurrence identity, semantic comparison and legacy app-only classification
 * for the ordered transcript reconcile. No node:fs, no SDK import: `msg` is the
 * SDK-free live wire shape (unknown), matching transcript-store/sidecar. The
 * composition layer (SessionManager reconcile) supplies OccurrenceContext /
 * LegacyProof; this module only derives identity and equivalence from them.
 */

import { isDeepStrictEqual } from 'node:util'

export type ProjectionSource = 'provider' | 'result' | 'app'

export interface ProjectionEntry {
  occurrenceId: string
  msg: unknown
  source: ProjectionSource
  aliases: string[]
  evicted: boolean
}

export interface OccurrenceContext {
  sourceLogId?: string
  sourceOrdinal?: number
  liveUuid?: string
  appOperationId?: string
}

export type TombstoneKind = 'coverage' | 'retraction'

export type LegacyClass = 'app' | 'provider-ephemeral' | 'source-lost'

export interface LegacyProof {
  restoredFromDisk?: boolean
  appSendProven?: boolean
  localCommandProven?: boolean
  handoffProven?: boolean
  completionProven?: boolean
  agentDropProven?: boolean
  nativeRepair?: boolean
  taskNotification?: 'watcher' | 'provider-live' | null
}

/** Delivery-state lifecycle keys (spec §5.3 lifecycle merge): the old server
 *  copy supplies these onto the canonical content when a matched occurrence
 *  merges. Exported so the reconcile's merge set and the semantic projection's
 *  exclusion set cannot drift — every lifecycle key MUST stay provenance, or a
 *  merged row's hash would diverge from its disk twin and re-classify app-only
 *  on every future reconcile. */
export const LIFECYCLE_KEYS = ['consumedAt', 'injectedAt', 'requeuedAt', 'steeredAt'] as const

/** Transport/persistence provenance excluded from semantic comparison (spec §5.3).
 *  uuid itself is excluded: identity is occurrenceId, not the display uuid. */
const PROVENANCE_KEYS = new Set<string>([
  ...LIFECYCLE_KEYS,
  'uuid',
  'restoredFromDisk',
  'receivedAt',
  'isReplay',
  'timestamp',
  'session_id',
  'sessionId',
])

type Loose = Record<string, unknown>

function asObject(msg: unknown): Loose | null {
  return msg !== null && typeof msg === 'object' ? (msg as Loose) : null
}

/** Frame kind discriminates occurrences that may share one uuid (spec §5.2):
 *  system subtype, and compact boundary vs summary. */
export function frameKindOf(msg: unknown): string {
  const m = asObject(msg)
  if (!m) return 'unknown'
  const type = typeof m.type === 'string' ? m.type : 'unknown'
  if (type === 'system') {
    const subtype = typeof m.subtype === 'string' ? m.subtype : ''
    return `system:${subtype}`
  }
  if (type === 'user' && m.isCompactSummary === true) return 'user:compact_summary'
  return type
}

/** Stable occurrence identity (spec §5.2). A disambiguator is appended when the
 *  caller supplies one (provider ordinal / live id / app operation id) — the
 *  composition layer decides uniqueness and passes the disambiguator only for
 *  uuid+frameKind keys that name more than one logical occurrence. */
export function occurrenceIdOf(msg: unknown, ctx: OccurrenceContext): string {
  const m = asObject(msg)
  const uuid = m && typeof m.uuid === 'string' ? m.uuid : null
  const fk = frameKindOf(msg)
  const hasOrdinal = ctx.sourceLogId !== undefined && ctx.sourceOrdinal !== undefined
  if (uuid !== null) {
    let dis = ''
    if (hasOrdinal) dis = `:provider:${ctx.sourceLogId}:${ctx.sourceOrdinal}`
    else if (ctx.liveUuid !== undefined) dis = `:live:${ctx.liveUuid}`
    else if (ctx.appOperationId !== undefined) dis = `:app:${ctx.appOperationId}`
    return `uuid:${uuid}:${fk}${dis}`
  }
  if (hasOrdinal) return `provider:${ctx.sourceLogId}:${ctx.sourceOrdinal}`
  if (ctx.liveUuid !== undefined) return `live:${ctx.liveUuid}`
  if (ctx.appOperationId !== undefined) return `app:${ctx.appOperationId}`
  return `anon:${fk}`
}

/** Semantic projection: the message minus transport provenance (spec §5.3).
 *  Everything else — type/subtype/parent, the full `message` object incl.
 *  stop_reason/usage, and top-level renderer payload (content/error/…) — is
 *  kept verbatim. isDeepStrictEqual is key-order-insensitive on objects. */
export function semanticMessageProjection(msg: unknown): unknown {
  const m = asObject(msg)
  if (!m) return msg
  const out: Loose = {}
  for (const key of Object.keys(m)) {
    if (PROVENANCE_KEYS.has(key)) continue
    // An explicit `undefined` value (e.g. normalize's `message: o.message` on a
    // system frame) is semantically identical to an absent key.
    if (m[key] === undefined) continue
    out[key] = m[key]
  }
  return out
}

export function semanticEquivalent(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(semanticMessageProjection(a), semanticMessageProjection(b))
}

function isToolResultCarrier(m: Loose): boolean {
  const message = asObject(m.message)
  const content = message?.content
  if (!Array.isArray(content)) return false
  return content.some((b) => asObject(b)?.type === 'tool_result')
}

/** Legacy app-only whitelist (spec §5.1). Proof is computed by the composition
 *  layer; an unproven record is source-lost, never silently kept as app data. */
export function classifyLegacyAppOnly(msg: unknown, proof: LegacyProof): LegacyClass {
  if (proof.taskNotification === 'provider-live') return 'provider-ephemeral'
  if (proof.taskNotification === 'watcher') return 'app'
  if (proof.localCommandProven) return 'app'
  if (proof.handoffProven) return 'app'
  if (proof.completionProven) return 'app'
  if (proof.agentDropProven) return 'app'
  if (proof.nativeRepair) return 'app'
  const m = asObject(msg)
  if (proof.appSendProven && m && m.type === 'user' && !isToolResultCarrier(m)) return 'app'
  return 'source-lost'
}
