// Shared server-side constants.

/** Hard cap on stdout/stderr buffered from a single child-process invocation
 *  (git, npm, skill imports). 16 MiB is generous for diffs, logs, and clone
 *  progress; pathological cases are caught by truncation passes in the
 *  respective callers. */
export const MAX_BUFFER_BYTES = 16 * 1024 * 1024

/** Total-bytes budget for one skill import (all files summed). Deliberately
 *  NOT an alias of MAX_BUFFER_BYTES: the two only coincidentally share
 *  16 MiB, and retuning one must not silently move the other's 413
 *  threshold. */
export const MAX_SKILL_IMPORT_TOTAL_BYTES = 16 * 1024 * 1024

/** Shared 500 ms write-coalescing debounce. Used by the JSON file stores'
 *  debounced flush and by the per-repo-group git-snapshot broadcast — same
 *  "settle briefly before hitting disk/network" window. */
export const DEBOUNCE_MS = 500

/** Default cap (bytes) on untracked files captured by the file-snapshot
 *  sidecar. Backs the `fileSnapshotsMaxUntrackedBytes` config default and
 *  the SnapshotService / shadow-git fallbacks, so the default cannot drift
 *  between the config layer and the capture layer. */
export const DEFAULT_MAX_UNTRACKED_BYTES = 2 * 1024 * 1024

/** Per-file unified-diff line cap. Beyond this the tail is dropped and
 *  `truncated: true` is set so the UI can show a clipped marker. Shared by
 *  git.ts's diff surfaces and the snapshot shadow-git patch path so both
 *  clip at the same length. */
export const MAX_DIFF_LINES = 500

/** Preview cap (chars) for interpolated payloads in log/error lines —
 *  request/response bodies, rpc dumps, fetched text. Long enough to carry
 *  the diagnosis, short enough to keep log lines scannable. */
export const LOG_PREVIEW_CAP = 200
/** Preview cap (chars) for error-detail text embedded in HttpError messages
 *  and classifier prompt previews. */
export const ERROR_DETAIL_CAP = 300
/** Preview cap (chars) for shell commands / SHAs quoted in logs and errors. */
export const COMMAND_PREVIEW_CAP = 80
