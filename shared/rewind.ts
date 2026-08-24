// File-checkpoint rewind (SDK Options.enableFileCheckpointing +
// Query.rewindFiles): restore tracked files to their state at a given user
// message. Browser-safe, SDK-agnostic — the server narrows the raw SDK
// response through coerceRewindResult before it goes over the wire.

/** Mirrors the SDK's RewindFilesResult. `canRewind: false` carries a
 *  human-readable `error` (checkpointing disabled, message unknown, …);
 *  the stats describe the diff the rewind will apply (dryRun) or applied
 *  (real run). */
export interface RewindFilesResult {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

/** Defensive narrowing of an unknown SDK response into RewindFilesResult.
 *  `canRewind` defaults to false when absent/invalid; stats are kept only
 *  when type-correct; unknown keys are dropped. Entirely malformed input
 *  collapses to `{ canRewind: false, error: 'malformed rewind response' }`
 *  so the client always has something safe to render. */
export function coerceRewindResult(v: unknown): RewindFilesResult {
  if (typeof v !== 'object' || v === null) {
    return { canRewind: false, error: 'malformed rewind response' }
  }
  const r = v as Record<string, unknown>
  const out: RewindFilesResult = { canRewind: r.canRewind === true }
  if (typeof r.error === 'string' && r.error) out.error = r.error
  if (Array.isArray(r.filesChanged)) {
    const files = r.filesChanged.filter((f): f is string => typeof f === 'string' && !!f)
    if (files.length > 0) out.filesChanged = files
  }
  if (typeof r.insertions === 'number' && Number.isFinite(r.insertions)) out.insertions = r.insertions
  if (typeof r.deletions === 'number' && Number.isFinite(r.deletions)) out.deletions = r.deletions
  return out
}
