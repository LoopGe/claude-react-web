// Structured per-file diff from a snapshot anchor — the browser-safe shape of
// GET /sessions/:id/snapshot-diff (server/session-manager.ts snapshotDiff).

export interface SnapshotDiffFile {
  file: string
  status: 'added' | 'deleted' | 'modified'
  additions: number
  deletions: number
  /** Unified diff text; absent for binary files or an empty change. */
  patch?: string
}

export interface SnapshotDiffValue {
  diffs: SnapshotDiffFile[]
}

/** Appended by the server (`server/snapshot/shadow-git.ts` structuredDiff)
 *  when a patch is cut at MAX_DIFF_LINES. Keep in sync with that emitter. */
export const SNAPSHOT_PATCH_TRUNCATION_MARKER = '... (truncated)'