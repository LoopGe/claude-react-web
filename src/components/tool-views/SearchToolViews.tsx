// Read / Grep / Glob / WebFetch / WebSearch tool_use views — all
// lightweight "title + chip row" cards with no or minimal body, sharing
// the same visual vocabulary (pattern in quotes, modifier chips).
//
// Extracted from ToolUseBlock.tsx for modularity.

import { memo } from 'react'
import { ToolCard } from '../ToolCard'
import { IconExternalLink, IconFileText, IconFolderSearch, IconGlobe, IconSearch, IconWebSearch } from '../icons/ToolIcons'
import { formatJson } from '../../utils/format'
import { truncate } from '../../utils/text'
import type { ToolViewProps } from './shared'
import { FilePathTitle, CopyablePathChip, isSafeUrl } from './shared'

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * File-path header (filename + grey dir) plus a "lines N–M" / "pages X–Y"
 * chip when offset/limit/pages are set. Reads have no body — the file path
 * + range is the entire useful payload at the tool_use stage.
 */
export const ReadToolView = memo(function ReadToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const filePath = typeof input.file_path === 'string' ? input.file_path : null
  const offset = typeof input.offset === 'number' ? input.offset : null
  const limit = typeof input.limit === 'number' ? input.limit : null
  const pages = typeof input.pages === 'string' ? input.pages : null

  if (!filePath) return <div className="tool-input">{formatJson(input)}</div>

  // offset is 0-indexed (per Read tool spec), but humans expect 1-indexed
  // line numbers, so display as offset+1 .. offset+limit.
  let rangeText: string | null = null
  if (offset != null && limit != null) {
    rangeText = `lines ${offset + 1}–${offset + limit}`
  } else if (offset != null) {
    rangeText = `from line ${offset + 1}`
  } else if (limit != null) {
    rangeText = `first ${limit} lines`
  }
  if (pages) rangeText = rangeText ? `${rangeText} · pages ${pages}` : `pages ${pages}`

  return (
    <ToolCard
      icon={<IconFileText />}
      title={<FilePathTitle path={filePath} />}
      chips={rangeText ? <span className="tool-chip">{rangeText}</span> : null}
      toolUseId={toolUseId}
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
      className="tool-card-read"
    />
  )
})

// ---------------------------------------------------------------------------
// Grep
// ---------------------------------------------------------------------------

/**
 * Pattern in quotes (the most important bit visually) plus modifier chips
 * for glob/type/path/output_mode and the case/multiline/-n flags. Order
 * mirrors how a human reads `rg "pattern" --glob='*.tsx' src/`.
 */
export const GrepToolView = memo(function GrepToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const pattern = typeof input.pattern === 'string' ? input.pattern : null
  if (!pattern) return <div className="tool-input">{formatJson(input)}</div>

  const path = typeof input.path === 'string' ? input.path : null
  const glob = typeof input.glob === 'string' ? input.glob : null
  const type = typeof input.type === 'string' ? input.type : null
  const outputMode = typeof input.output_mode === 'string' ? input.output_mode : null
  const caseInsensitive = input['-i'] === true
  const multiline = input.multiline === true
  const headLimit = typeof input.head_limit === 'number' ? input.head_limit : null
  const before = typeof input['-B'] === 'number' ? (input['-B'] as number) : null
  const after = typeof input['-A'] === 'number' ? (input['-A'] as number) : null
  const context = typeof input['-C'] === 'number' ? (input['-C'] as number) : null

  const chips = (
    <>
      {(glob || type) && (
        <span className="tool-chip tool-chip-accent">
          {glob ? `glob:${glob}` : `type:${type}`}
        </span>
      )}
      {path && <CopyablePathChip path={path} />}
      {outputMode && outputMode !== 'files_with_matches' && (
        <span className="tool-chip">{outputMode}</span>
      )}
      {caseInsensitive && <span className="tool-chip" title="Case insensitive">-i</span>}
      {multiline && <span className="tool-chip" title="Multiline mode">multiline</span>}
      {context != null
        ? <span className="tool-chip">±{context}</span>
        : (before != null || after != null) && (
            <span className="tool-chip">
              {before != null ? `-B${before}` : ''}
              {before != null && after != null ? ' ' : ''}
              {after != null ? `-A${after}` : ''}
            </span>
          )}
      {headLimit != null && <span className="tool-chip">head:{headLimit}</span>}
    </>
  )

  return (
    <ToolCard
      icon={<IconSearch />}
      title={<code className="grep-tool-pattern">&ldquo;{pattern}&rdquo;</code>}
      chips={chips}
      toolUseId={toolUseId}
      copyValue={() => pattern}
      copyLabel="Copy pattern"
      className="tool-card-grep"
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    />
  )
})

// ---------------------------------------------------------------------------
// Glob
// ---------------------------------------------------------------------------

/**
 * Pattern-only file matcher. Visually a stripped-down Grep — same row
 * layout, same chip vocabulary.
 */
export function GlobToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const pattern = typeof input.pattern === 'string' ? input.pattern : null
  if (!pattern) return <div className="tool-input">{formatJson(input)}</div>

  const path = typeof input.path === 'string' ? input.path : null

  return (
    <ToolCard
      icon={<IconFolderSearch />}
      title={<code className="grep-tool-pattern">{pattern}</code>}
      chips={path ? <CopyablePathChip path={path} /> : null}
      toolUseId={toolUseId}
      copyValue={() => pattern}
      copyLabel="Copy pattern"
      className="tool-card-glob"
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
    />
  )
}

// ---------------------------------------------------------------------------
// WebFetch
// ---------------------------------------------------------------------------

/**
 * URL on top as a real anchor so the user can click through; prompt as
 * a muted body line. The URL itself is the key information — what the
 * model wants from it is secondary.
 *
 * The link is hardcoded to noopener/noreferrer + _blank — opening into
 * the chat tab is never what the user wants here, and a webpage that
 * inherits this app's window context could read its origin.
 */
export function WebFetchToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const url = typeof input.url === 'string' ? input.url : null
  const prompt = typeof input.prompt === 'string' ? input.prompt : null
  if (!url) return <div className="tool-input">{formatJson(input)}</div>

  const safe = isSafeUrl(url)
  const titleNode = safe ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="web-tool-url"
      title={url}
      onClick={(e) => e.stopPropagation()}
    >
      {url}
      <IconExternalLink size={12} />
    </a>
  ) : (
    <>
      <code className="web-tool-url" title={url}>{url}</code>
      <span
        className="tool-chip"
        title="URL scheme is not in the http/https/mailto/ftp allowlist; rendered as plain text to avoid javascript: / data: URL execution."
      >
        unsafe scheme
      </span>
    </>
  )

  return (
    <ToolCard
      icon={<IconGlobe />}
      title={titleNode}
      toolUseId={toolUseId}
      copyValue={() => url}
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
      copyLabel="Copy URL"
      className="tool-card-web"
    >
      {prompt && (
        <div className="web-tool-prompt">
          <span className="web-tool-prompt-marker" aria-hidden>└─</span>
          <span>{truncate(prompt, 240)}</span>
        </div>
      )}
    </ToolCard>
  )
}

// ---------------------------------------------------------------------------
// WebSearch
// ---------------------------------------------------------------------------

/**
 * Query in quotes (mono), allowed/blocked domain filters as muted chips
 * — visually parallels Grep / Glob so the "I'm searching X with these
 *   modifiers" pattern reads consistently across tools.
 */
export function WebSearchToolView({ input, toolUseId, searchQuery, activeMatchIdx }: ToolViewProps) {
  if (!input || typeof input !== 'object') {
    return <div className="tool-input">{formatJson(input)}</div>
  }
  const query = typeof input.query === 'string' ? input.query : null
  if (!query) return <div className="tool-input">{formatJson(input)}</div>

  const allowed = Array.isArray(input.allowed_domains)
    ? (input.allowed_domains as string[]).filter((d) => typeof d === 'string')
    : []
  const blocked = Array.isArray(input.blocked_domains)
    ? (input.blocked_domains as string[]).filter((d) => typeof d === 'string')
    : []

  const chips = (
    <>
      {allowed.length > 0 && (
        <span className="tool-chip tool-chip-accent" title="Allowed domains">
          only: {allowed.join(', ')}
        </span>
      )}
      {blocked.length > 0 && (
        <span className="tool-chip" title="Blocked domains">
          block: {blocked.join(', ')}
        </span>
      )}
    </>
  )

  return (
    <ToolCard
      icon={<IconWebSearch />}
      title={<code className="grep-tool-pattern">&ldquo;{query}&rdquo;</code>}
      chips={chips}
      searchQuery={searchQuery}
      activeMatchIdx={activeMatchIdx}
      toolUseId={toolUseId}
      copyValue={() => query}
      copyLabel="Copy query"
      className="tool-card-websearch"
    />
  )
}
