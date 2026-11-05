// Resource address grammar for the resource pane (docs/resource-tabs-research.md §11).
//
//   crw-resource://<protocol>/<segment>/<segment>…[?<key>=<value>&…]
//
// The BUILDER is the only normalizing producer: it resolves separators, `.` and
// `..` lexically (clamped at the root), spells path segments as individual
// `/`-separated pieces, and canonicalizes the query (sorted keys). The PARSER
// deliberately does not normalize: identity is the verbatim address string, so
// a hand-written `..` address is a distinct resource. Both live in `shared/`
// because the server (future routes) and the client must agree on the grammar,
// exactly like `shared/send-body.ts`.

const SCHEME = 'crw-resource://'

/** Protocol segment: lower-case ASCII, digits and dashes. `file`, `diff`,
 *  `snapshot-diff`, `mcp-app`, … */
const PROTOCOL_RE = /^[a-z][a-z0-9-]*$/

export interface ParsedResourceAddress {
  /** The address's protocol (also the tab kind, unless the caller overrides). */
  protocol: string
  /** Decoded path segments after the protocol. Empty segments are preserved so
   *  a POSIX absolute path keeps its leading `/` when rejoined. */
  segments: string[]
  /** Decoded query values, protocol-owned. */
  query: Record<string, string>
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const at = value.indexOf(separator)
  return at === -1 ? [value, undefined] : [value.slice(0, at), value.slice(at + 1)]
}

/** Encode one path segment. `:` is restored literally so a Windows drive letter
 *  stays readable (`C:` rather than `C%3A`); everything else goes through
 *  `encodeURIComponent`, which encodes `/`, spaces, `#`, `?`, `%` and unicode. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/** Build an address from already-ordered segments. Query keys are sorted so the
 *  same logical query always produces the same string. */
export function buildResourceAddress(
  protocol: string,
  segments: string[],
  query: Record<string, string> = {},
): string {
  const path = segments.map(encodeSegment).join('/')
  const keys = Object.keys(query).sort()
  const queryString = keys
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`)
    .join('&')
  return `${SCHEME}${protocol}/${path}${queryString ? `?${queryString}` : ''}`
}

/** Parse an address. Returns null for a foreign scheme, a malformed protocol,
 *  a fragment, or an undecodable percent escape. Unknown protocols are NOT
 *  rejected here — the registry decides whether anything can open them. */
export function parseResourceAddress(address: string): ParsedResourceAddress | null {
  if (!address.startsWith(SCHEME)) return null
  // No fragments: the builder never emits `#` (it encodes it as %23), so a
  // literal one means the string was not built by the builder.
  if (address.includes('#')) return null
  const rest = address.slice(SCHEME.length)
  const [pathPart, queryPart] = splitOnce(rest, '?')
  const rawSegments = pathPart.split('/')
  if (rawSegments.length < 2) return null
  const protocol = rawSegments[0]
  if (!PROTOCOL_RE.test(protocol)) return null
  try {
    const segments = rawSegments.slice(1).map((segment) => decodeURIComponent(segment))
    const query: Record<string, string> = {}
    if (queryPart !== undefined) {
      for (const pair of queryPart.split('&')) {
        if (!pair) continue
        const [key, value = ''] = splitOnce(pair, '=')
        query[decodeURIComponent(key)] = decodeURIComponent(value)
      }
    }
    return { protocol, segments, query }
  } catch {
    return null
  }
}

/** Lexically normalize an absolute path: `\` → `/`, drop `.` and empty
 *  segments, resolve `..` by popping (a pop at the root is a no-op, so the
 *  result cannot escape the root). The drive letter (if any) is preserved. */
function normalizeAbsolutePath(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  // UNC (`\\server\share\…` → `//server/share/…`): the double leading slash IS
  // the path's root marker; collapsing it would turn the share into a bogus
  // POSIX root.
  const isUnc = slashed.startsWith('//')
  const drive = /^([A-Za-z]):\//.exec(slashed)?.[1]
  const isPosixAbsolute = !isUnc && slashed.startsWith('/')
  const rest = drive ? slashed.slice(drive.length + 1) : isUnc ? slashed.slice(2) : slashed
  const parts: string[] = []
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  const joined = parts.join('/')
  if (drive) return `${drive}:/${joined}`
  if (isUnc) return `//${joined}`
  if (isPosixAbsolute) return `/${joined}`
  return joined
}

/** Build a `file` address for an absolute path. The path's `/`-split segments
 *  become address segments; a POSIX path therefore carries an empty first
 *  segment (`…/file/<sid>//repo/a.ts`) which round-trips back to `/repo/a.ts`. */
export function fileResource(sessionId: string, absPath: string): string {
  const segments = normalizeAbsolutePath(absPath).split('/')
  return buildResourceAddress('file', [sessionId, ...segments])
}

/** Decode a `file` address. Only the protocol's shape is checked here; whether
 *  the file can actually be read is the provider's business. */
export function parseFileResource(
  address: string,
): { sessionId: string; path: string } | null {
  const parsed = parseResourceAddress(address)
  if (!parsed || parsed.protocol !== 'file') return null
  const [sessionId, ...rest] = parsed.segments
  if (!sessionId) return null
  const path = rest.join('/')
  if (!path) return null
  return { sessionId, path }
}

export type DiffBasis =
  | { type: 'worktree' }
  | { type: 'staged' }
  | { type: 'commit'; sha: string }
  | { type: 'range'; from: string; to: string; mergeBase: boolean }

export interface DiffResource {
  sessionId: string
  /** Working directory the git route runs in (a worktree path for Worktree views). */
  cwd: string
  /** Repo-relative path (the same spelling the git routes take). */
  path: string
  basis: DiffBasis
}

export interface SnapshotDiffResource {
  sessionId: string
  /** The user-message id whose snapshot anchor the diff starts from. */
  messageId: string
}

/** Human label for a diff basis, used in the body header and descriptions. */
export function diffBasisLabel(basis: DiffBasis): string {
  switch (basis.type) {
    case 'worktree':
      return 'worktree'
    case 'staged':
      return 'staged'
    case 'commit':
      return `commit ${basis.sha.slice(0, 8)}`
    case 'range':
      return `${basis.from} → ${basis.to}${basis.mergeBase ? '' : ' (tip)'}`
  }
}

/** Diff addresses keep the path as the trailing segments and the basis in the
 *  query: branch refs may contain `/`, so the doc's path-encoded basis would be
 *  ambiguous. The query is canonicalized by the builder. */
export function diffResource(resource: DiffResource): string {
  const { sessionId, cwd, path, basis } = resource
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean)
  const query: Record<string, string> = { basis: basis.type, cwd }
  if (basis.type === 'commit') query.sha = basis.sha
  if (basis.type === 'range') {
    query.from = basis.from
    query.to = basis.to
    query.mode = basis.mergeBase ? 'mergeBase' : 'tip'
  }
  return buildResourceAddress('diff', [sessionId, ...segments], query)
}

export function parseDiffResource(address: string): DiffResource | null {
  const parsed = parseResourceAddress(address)
  if (!parsed || parsed.protocol !== 'diff') return null
  const [sessionId, ...rest] = parsed.segments
  const path = rest.join('/')
  const cwd = parsed.query.cwd
  if (!sessionId || !path || !cwd) return null
  switch (parsed.query.basis) {
    case 'worktree':
      return { sessionId, cwd, path, basis: { type: 'worktree' } }
    case 'staged':
      return { sessionId, cwd, path, basis: { type: 'staged' } }
    case 'commit': {
      const sha = parsed.query.sha
      if (!sha) return null
      return { sessionId, cwd, path, basis: { type: 'commit', sha } }
    }
    case 'range': {
      const { from, to, mode } = parsed.query
      if (!from || !to || (mode !== 'mergeBase' && mode !== 'tip')) return null
      return {
        sessionId,
        cwd,
        path,
        basis: { type: 'range', from, to, mergeBase: mode === 'mergeBase' },
      }
    }
    default:
      return null
  }
}

export function snapshotDiffResource(sessionId: string, messageId: string): string {
  return buildResourceAddress('snapshot-diff', [sessionId, messageId])
}

export function parseSnapshotDiffResource(address: string): SnapshotDiffResource | null {
  const parsed = parseResourceAddress(address)
  if (!parsed || parsed.protocol !== 'snapshot-diff') return null
  if (parsed.segments.length !== 2) return null
  const [sessionId, messageId] = parsed.segments
  if (!sessionId || !messageId) return null
  return { sessionId, messageId }
}

export interface TaskResource {
  sessionId: string
  taskId: string
}

export interface SubagentResource {
  sessionId: string
  /** The Agent/Task tool_use id (the same key SubagentOverlay filters by). */
  toolUseId: string
}

export function taskResource(sessionId: string, taskId: string): string {
  return buildResourceAddress('task', [sessionId, taskId])
}

export function parseTaskResource(address: string): TaskResource | null {
  const parsed = parseResourceAddress(address)
  if (!parsed || parsed.protocol !== 'task') return null
  if (parsed.segments.length !== 2) return null
  const [sessionId, taskId] = parsed.segments
  if (!sessionId || !taskId) return null
  return { sessionId, taskId }
}

export function subagentResource(sessionId: string, toolUseId: string): string {
  return buildResourceAddress('subagent', [sessionId, toolUseId])
}

export function parseSubagentResource(address: string): SubagentResource | null {
  const parsed = parseResourceAddress(address)
  if (!parsed || parsed.protocol !== 'subagent') return null
  if (parsed.segments.length !== 2) return null
  const [sessionId, toolUseId] = parsed.segments
  if (!sessionId || !toolUseId) return null
  return { sessionId, toolUseId }
}

/** Display title derived from the address (never persisted, so it cannot drift
 *  from the identity). `file` → decoded basename; `diff` → basename + basis
 *  (same path with different bases must produce different chips);
 *  `snapshot-diff` → a short anchor label; other kinds → the last non-empty
 *  segment, falling back to the protocol. */
export function resourceTitle(address: string): string {
  const parsed = parseResourceAddress(address)
  if (!parsed) return address
  switch (parsed.protocol) {
    case 'file': {
      const rest = parsed.segments.slice(1).join('/')
      if (!rest) break
      const base = rest.split('/').filter(Boolean).pop()
      return base || parsed.protocol
    }
    case 'diff': {
      const diff = parseDiffResource(address)
      if (!diff) break
      const base = diff.path.split('/').filter(Boolean).pop() || diff.path
      return `${base} · ${diffBasisLabel(diff.basis)}`
    }
    case 'snapshot-diff': {
      const messageId = parsed.segments[1]
      if (!messageId) break
      return `Changes ${messageId.slice(0, 8)}`
    }
    case 'task': {
      const taskId = parsed.segments[1]
      if (!taskId) break
      return `Task ${taskId.slice(0, 8)}`
    }
    case 'subagent': {
      const toolUseId = parsed.segments[1]
      if (!toolUseId) break
      return `Agent ${toolUseId.slice(0, 8)}`
    }
  }
  return parsed.segments.filter(Boolean).pop() || parsed.protocol
}

/** Path segments used for chip labels (files)/segment trails (other kinds). */
export function resourcePathSegments(address: string): string[] {
  const parsed = parseResourceAddress(address)
  if (!parsed) return []
  switch (parsed.protocol) {
    case 'file':
      return parsed.segments.slice(1).join('/').split('/').filter(Boolean)
    case 'diff': {
      const diff = parseDiffResource(address)
      return diff ? diff.path.split('/').filter(Boolean) : []
    }
    case 'snapshot-diff': {
      const messageId = parsed.segments[1]
      return messageId ? [messageId] : []
    }
    case 'task':
    case 'subagent': {
      const id = parsed.segments[1]
      return id ? [id] : []
    }
    default:
      return parsed.segments.filter(Boolean)
  }
}

/** Human-readable description for a chip tooltip: the decoded path for files,
 *  the path + basis for diffs, the anchor for snapshot diffs, otherwise the
 *  decoded segment trail. */
export function resourceDescription(address: string): string {
  const parsed = parseResourceAddress(address)
  if (!parsed) return address
  switch (parsed.protocol) {
    case 'file': {
      const rest = parsed.segments.slice(1).join('/')
      return rest || address
    }
    case 'diff': {
      const diff = parseDiffResource(address)
      return diff ? `${diff.path} — ${diffBasisLabel(diff.basis)}` : address
    }
    case 'snapshot-diff': {
      const messageId = parsed.segments[1]
      return messageId ? `snapshot diff ${messageId}` : address
    }
    case 'task': {
      const taskId = parsed.segments[1]
      return taskId ? `task ${taskId}` : address
    }
    case 'subagent': {
      const toolUseId = parsed.segments[1]
      return toolUseId ? `agent ${toolUseId}` : address
    }
    default:
      return parsed.segments.filter(Boolean).join('/') || address
  }
}