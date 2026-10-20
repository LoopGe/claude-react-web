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

/** Upper bound on how long the git-snapshot debounce may keep deferring a
 *  group's broadcast. DEBOUNCE_MS alone is trailing-only, so a continuous
 *  stream of mutating tool results (a long Bash/Edit loop) would starve the
 *  chip until the stream stops; with this cap it refreshes at least every
 *  3 s while the stream runs. */
export const GIT_BROADCAST_MAX_WAIT_MS = 3_000

/** How long SessionManager.delete() queues on the session's op lock before
 *  it runs anyway. A locked setter awaits an in-band SDK control request
 *  that has no deadline; if the CLI never answers, the lock is never
 *  released, and delete is the user's escape hatch. Set above the slowest
 *  legitimate locked op (fork's snapshot capture is capped at 15 s), so
 *  delete only overtakes a holder that is actually wedged. */
export const DELETE_LOCK_MAX_WAIT_MS = 20_000

/** How long setModel() waits before re-issuing a model switch the CLI could
 *  not CONFIRM (its pre-switch entitlement probe exceeded the CLI's own ~5 s
 *  deadline, answering "Couldn't confirm model … with the API. Try again"),
 *  and the only failure class that is retried — the CLI's wording carries the
 *  retry instruction, and the app cannot see the probe's structure.
 *
 *  Measured on a slow gateway (state dir logs, 2026-10-19): all four observed
 *  failures landed at 5013–5033 ms (the CLI's deadline), while successful
 *  switches took 6 ms–4428 ms; every manual re-attempt of the SAME model
 *  succeeded seconds later, so the failure is throughput, not entitlement.
 *  Waiting a moment hands the probe a fresh window. One retry, not a ladder:
 *  no observed failure needed more, and each attempt costs up to ~5 s. */
export const MODEL_SWITCH_RETRY_DELAY_MS = 1_500

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
