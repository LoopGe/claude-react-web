// Shared server-side constants.

/** Hard cap on stdout/stderr buffered from a single child-process invocation
 *  (git, npm, skill imports). 16 MiB is generous for diffs, logs, and clone
 *  progress; pathological cases are caught by truncation passes in the
 *  respective callers. */
export const MAX_BUFFER_BYTES = 16 * 1024 * 1024
