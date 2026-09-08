// Shared infrastructure for per-tool tool_use views: the ToolViewProps
// contract, the URL-safety allowlist, and the click-to-copy-path helpers
// used by every file-touching / path-bearing view (Edit, Write, Read,
// NotebookEdit, Grep, Glob).
//
// Extracted from ToolUseBlock.tsx for modularity — see that file's header
// comment for the overall dispatch design.

import { type MouseEventHandler } from 'react'
import { useSessionCwd } from '../../hooks/useSessionCwd'
import { useCopy } from '../../hooks/useCopy'
import { splitFilePath, shortenDir } from '../../utils/file-display'
import { resolveAbsolutePath } from '../../utils/paths'

// Per-tool input view. Each view receives the raw tool_use input (loosely
// type because SDK schemas drift) and falls back to formatJson internally
// when the shape is unexpected. `toolName` is forwarded so a single view
// can serve more than one tool (e.g. BashToolView covers both Bash and
// PowerShell, branching on the name to swap the prompt glyph).
// `toolUseId` is threaded so ToolCard can look up live status.
export type ToolViewProps = {
  input?: Record<string, unknown>
  toolName?: string
  toolUseId?: string
  searchQuery?: string
  /** Active match index for the tool_result body (forwarded to ToolCard). */
  activeMatchIdx?: number
  /** Active match index for the diff body (Edit/Write/NotebookEdit input) —
   *  the Nth match within this tool_use's indexed diff text. Forwarded to
   *  DiffChunk/ExpandableDiff, which rebase it per line. */
  diffActiveMatchIdx?: number
}

export const MAX_PREVIEW_LINES = 20

/**
 * Allowlist-based URL safety check for tool_use-supplied URLs we render as
 * <a href>. The model's input is *not* trusted output — a `javascript:` or
 * `data:` URL would execute on click (rel="noopener noreferrer" doesn't
 * block dangerous schemes, only window.opener leakage). We only let
 * regular web/email/file-transfer schemes through; anything else falls
 * back to a plain <code> render so the user can still see what was asked
 * for without one click compromising the page.
 */
const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'ftp:', 'ftps:'])
export function isSafeUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol.toLowerCase()
    return SAFE_URL_SCHEMES.has(protocol)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// File-path header (shared)
// ---------------------------------------------------------------------------

/** Shared click-to-copy-the-absolute-path behaviour for path-bearing tool
 *  cards. Resolves `path` against the session cwd, wires the clipboard copy
 *  + 2s "copied" feedback, and returns the hover `title` and a click handler
 *  that stops propagation (so the click doesn't bubble into card chrome).
 *
 *  Used by both FilePathTitle (file tools) and CopyablePathChip (Grep/Glob
 *  search scope) so the two paths can't drift on tooltip wording, resolution,
 *  or stopPropagation semantics. */
export function useCopyablePath(path: string): {
  copied: boolean
  title: string
  onClick: MouseEventHandler<HTMLButtonElement>
} {
  const cwd = useSessionCwd()
  const { copied, copy } = useCopy()
  const absPath = resolveAbsolutePath(cwd, path)
  return {
    copied,
    title: copied ? 'Copied!' : `Click to copy path\n${absPath}`,
    onClick: (e) => {
      e.stopPropagation()
      copy(() => absPath)
    },
  }
}

/** A two-line file-path display used as the *title* of file-touching tool
 *  cards (Edit, Write, Read, NotebookEdit).  Bold filename on top, muted
 *  parent dir below — so the user's eye lands on the actual file name
 *  before processing the path context.
 *
 *  The directory uses middle-ellipsis truncation (see shortenDir) instead
 *  of CSS right-truncate, because the leaf folder is the most informative
 *  segment and `text-overflow: ellipsis` would clip it first.
 *
 *  The whole title is a click-to-copy button: one click copies the full
 *  absolute path (resolved against the session cwd — see useCopyablePath)
 *  to the clipboard, with a 2s "copied" affordance. The untruncated absolute
 *  path + the click hint are in the hover `title` so the user can preview
 *  exactly what they'll get before clicking.  */
export function FilePathTitle({
  path,
  badge,
}: {
  path: string
  badge?: string
}) {
  const { copied, title, onClick } = useCopyablePath(path)
  const { dir, base } = splitFilePath(path)
  const shortDir = dir ? shortenDir(dir, 48) : ''
  return (
    <button
      type="button"
      className={`tool-card-filepath${copied ? ' copied' : ''}`}
      title={title}
      onClick={onClick}
    >
      <span className="tool-card-filepath-base">{base || path}</span>
      {badge && <span className="tool-card-filepath-badge">{badge}</span>}
      {shortDir && <span className="tool-card-filepath-dir">{shortDir}</span>}
      {copied && <span className="tool-card-filepath-copied copied-pop">copied</span>}
    </button>
  )
}

/** A `in <path>` chip used by Grep / Glob whose `path` is a search scope
 *  (not a FilePathTitle). Click copies the resolved absolute path, mirroring
 *  FilePathTitle's click-to-copy semantics so every path-bearing tool card
 *  offers the same copy affordance. The path label stays visible during the
 *  2s "copied" feedback (the chip tints green + the tooltip flips to
 *  "Copied!") rather than being replaced — losing the path context the user
 *  is looking at would be worse than the feedback it signals. */
export function CopyablePathChip({ path }: { path: string }) {
  const { copied, title, onClick } = useCopyablePath(path)
  return (
    <button
      type="button"
      className={`tool-chip tool-chip-copyable${copied ? ' copied' : ''}`}
      title={title}
      onClick={onClick}
    >
      {`in ${path}`}
    </button>
  )
}
