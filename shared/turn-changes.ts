/**
 * Per-turn changed-file summary: the files one top-level turn changed, the
 * line counts derived from the session snapshot trees or from the whole-file
 * copies captured around file-tool edits, and the wire shapes that serve it.
 *
 * Server and client share these types; the server keeps the snapshot sources
 * (tree ids / copy paths) in its sidecar and strips them before serving.
 */

/** How a listed file changed relative to the turn-start snapshot. */
export type TurnChangedFileStatus = 'added' | 'deleted' | 'modified'

/** One file changed during a turn. */
export interface TurnChangedFile {
  /** Path relative to the session cwd when inside it, otherwise absolute. Slash-separated. */
  path: string
  /** Sort key and label; slash-separated, may start with `../` for files above the cwd. */
  display: string
  status: TurnChangedFileStatus
  /** Lines added; zero for a binary or oversized file. */
  additions: number
  /** Lines deleted; zero for a binary or oversized file. */
  deletions: number
  /** Present when either side is binary. */
  binary?: true
  /** Present when a captured side exceeded the byte cap; listed without counts. */
  oversized?: true
}

/** Files changed during one top-level turn. */
export interface TurnChangesSummary {
  /** The `result` frame that closed the turn; the client's card anchor. */
  resultUuid: string
  /** The uuid of the turn's last main-thread assistant message. */
  assistantUuid: string
  /** Changed files in `display` order, capped at {@link TURN_CHANGES_MAX_FILES}. */
  files: TurnChangedFile[]
  /** Complete changed-file count, including files omitted by the cap. */
  total: number
  /** Lines added over every changed file. */
  added: number
  /** Lines deleted over every changed file. */
  deleted: number
}

/** Response of `GET /sessions/:id/turn-changes`. */
export interface TurnChangesPayload {
  available: boolean
  summary?: TurnChangesSummary
}

/** Context shown around a turn modification. Independent from body clipping. */
export type TurnDiffViewMode = 'changes' | 'full-file'

export interface TurnDiffOptions {
  /** Return the complete generated patch instead of the preview line cap. */
  full?: boolean
  /** Three context lines around changes, or the complete file. Defaults to changes. */
  view?: TurnDiffViewMode
}

/** Response of `GET /sessions/:id/turn-diff`. */
export interface TurnDiffPayload {
  available: boolean
  /** Unified-diff body (git-style headers + hunks). Context size follows `view`;
   *  the body is clipped unless `full=1`. */
  patch?: string
  /** True when the patch body was clipped. */
  truncated?: boolean
  /** Unclipped line count of the patch body. */
  totalLines?: number
  /** Why no patch is served. */
  reason?: 'missing' | 'binary' | 'oversized'
}

/** Maximum files carried by one summary; `total` still reports the full count. */
export const TURN_CHANGES_MAX_FILES = 500

/** Inclusive byte cap for a captured copy and for reading one back. */
export const TURN_CHANGES_MAX_FILE_BYTES = 2 * 1024 * 1024

/** Live frame: one turn's summary is ready. Rides the session message-status channel. */
export interface WsTurnChanges {
  kind: 'turn-changes'
  sessionId: string
  summary: TurnChangesSummary
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/**
 * Validate one changed-file record crossing the wire.
 * @param value - decoded JSON.
 * @returns whether the record carries a path, display label, status, and counts.
 */
export function isTurnChangedFile(value: unknown): value is TurnChangedFile {
  if (!isRecord(value)) return false
  const { path, display, status, additions, deletions, binary, oversized } = value
  return typeof path === 'string' && path.length > 0
    && typeof display === 'string' && display.length > 0
    && (status === 'added' || status === 'deleted' || status === 'modified')
    && isNonNegativeInteger(additions) && isNonNegativeInteger(deletions)
    && (binary === undefined || binary === true)
    && (oversized === undefined || oversized === true)
}

/**
 * Validate a summary crossing the wire.
 * @param value - decoded JSON.
 * @returns whether the value identifies the turn and carries a complete file list.
 */
export function isTurnChangesSummary(value: unknown): value is TurnChangesSummary {
  if (!isRecord(value)) return false
  const { resultUuid, assistantUuid, files, total, added, deleted } = value
  return typeof resultUuid === 'string' && resultUuid.length > 0
    && typeof assistantUuid === 'string' && assistantUuid.length > 0
    && isNonNegativeInteger(total) && isNonNegativeInteger(added) && isNonNegativeInteger(deleted)
    && Array.isArray(files) && files.every(isTurnChangedFile)
}