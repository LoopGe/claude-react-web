// Root-scoped permission exemption for the native auto-memory store.
//
// The memory roots live OUTSIDE the session cwd, so the broker's acceptEdits
// in-cwd auto-approve never covers them and every "save what I learned" write
// would prompt (a background dream run would stall on a permission decision).
// These helpers decide whether a tool call targets the session's resolved
// memory roots so the broker can silently allow it.
//
// SECURITY: containment is REALPATH-based — deliberately stronger than the
// lexical checks elsewhere in the broker — so a symlink/junction inside a root
// cannot turn the allowance into an escape. Write isolation: a write is exempt
// ONLY inside `own`; the claude compat root NEVER grants a write exemption (the
// write helper does not even look at it). Fail-closed: any resolution failure
// (absent root, unresolvable path) returns false → the normal permission chain
// runs and the tool layer surfaces the real error.

import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { EDIT_TOOL_PATH_FIELD } from './accept-edits-bash.js'
import { createLogger } from './log.js'

const log = createLogger('memory-permission')

/** The session's resolved auto-memory roots (`Session.memoryRoots`, produced
 *  by `resolveMemoryRoots`). `own` is the CRW-managed writable store; `claude`
 *  is the CLI-managed read-only compat dir (null when absent). */
export interface MemoryRoots {
  own: string
  claude: string | null
}

/** Read tools whose target rides a path input field. Read uses `file_path`;
 *  Glob/Grep/LS use `path`. An absent path means a cwd-scoped search — NOT
 *  memory-root-targeted, so the helper returns false and the chain handles it. */
const READ_TOOL_PATH_FIELD: Record<string, string> = {
  Read: 'file_path',
  Glob: 'path',
  Grep: 'path',
  LS: 'path',
}

/** Containment on resolved paths. win32 paths are case-insensitive, so the
 *  comparison lowercases there (the native-host-auto-memory / file-read
 *  precedent) — a differently-cased alias must not slip through. */
function isAtOrBelow(dir: string, base: string): boolean {
  const d = process.platform === 'win32' ? dir.toLowerCase() : dir
  const b = process.platform === 'win32' ? base.toLowerCase() : base
  return d === b || d.startsWith(b.endsWith(sep) ? b : b + sep)
}

/** ENOENT/ENOTDIR are the expected absent states; anything else is a real
 *  failure that fails the exemption closed. */
function isAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** realpath of the nearest existing ancestor, with the not-yet-existing tail
 *  re-appended lexically (the native-host-auto-memory `realpathNearestExisting`
 *  precedent). A NEW memory file under an existing root resolves through the
 *  root's real path, so the write exemption covers first-time saves; a
 *  symlinked ancestor still resolves through the link, so an escape is caught
 *  before the absent tail is appended. */
async function realpathNearestExisting(p: string): Promise<string> {
  const tail: string[] = []
  let current = p
  for (;;) {
    try {
      const real = await realpath(current)
      return tail.length > 0 ? join(real, ...tail.reverse()) : real
    } catch (err) {
      if (!isAbsent(err)) throw err
      const up = dirname(current)
      if (up === current) throw err
      tail.push(basename(current))
      current = up
    }
  }
}

function pathField(input: unknown, field: string): string | null {
  const raw = (input as Record<string, unknown> | null | undefined)?.[field]
  return typeof raw === 'string' && raw ? raw : null
}

/** Resolve the target against the SESSION cwd — the same base the tool executes
 *  against (`resolveAgainstCwd(ctx.cwd, …)`) and the broker's acceptEdits
 *  convention (`isInScopePath` → `resolve(cwd, p)`). `resolve(cwd, raw)` anchors
 *  a relative path at cwd and leaves an absolute path unchanged, so the exemption
 *  judges the path actually written, not one anchored at `process.cwd()`. A
 *  relative path with no cwd to anchor it cannot be proven contained → null
 *  (fail-closed); an absolute path still resolves without a cwd. */
function targetPath(raw: string, cwd: string | undefined): string | null {
  if (cwd) return resolve(cwd, raw)
  return isAbsolute(raw) ? resolve(raw) : null
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Whether a file-editing tool call (Edit/Write/MultiEdit/NotebookEdit) targets
 *  a path inside the session's OWN memory root, by realpath containment. The
 *  claude compat root is deliberately never consulted — write isolation holds
 *  by construction. A new (absent) target under an existing root is exempt; an
 *  absent root or a symlink escape is not. `cwd` is the session working
 *  directory: relative path fields are anchored against it (the base the tool
 *  writes against), absolute fields are unchanged. */
export async function isMemoryRootWrite(
  toolName: string,
  input: unknown,
  roots: MemoryRoots | undefined,
  cwd?: string,
): Promise<boolean> {
  if (!roots) return false
  const field = EDIT_TOOL_PATH_FIELD[toolName]
  if (!field) return false
  const raw = pathField(input, field)
  if (!raw) return false
  const target = targetPath(raw, cwd)
  if (!target) return false
  try {
    const realRoot = await realpath(roots.own)
    const realTarget = await realpathNearestExisting(target)
    return isAtOrBelow(realTarget, realRoot)
  } catch (err) {
    log.debug(`memory write exemption declined for ${toolName}: ${errMessage(err)}`)
    return false
  }
}

/** Whether a read tool call (Read/Glob/Grep/LS) targets a path inside the
 *  session's own OR claude memory root, by realpath containment. Reads are
 *  read-only, so both roots are exempt; the target must exist (a read of an
 *  absent path is not exempt — the tool layer reports it). An absent path field
 *  (cwd-scoped search) is not memory-targeted. `cwd` anchors relative path
 *  fields against the session working directory (absolute fields unchanged). */
export async function isMemoryRootRead(
  toolName: string,
  input: unknown,
  roots: MemoryRoots | undefined,
  cwd?: string,
): Promise<boolean> {
  if (!roots) return false
  const field = READ_TOOL_PATH_FIELD[toolName]
  if (!field) return false
  const raw = pathField(input, field)
  if (!raw) return false
  const target = targetPath(raw, cwd)
  if (!target) return false
  for (const root of [roots.own, roots.claude]) {
    if (!root) continue
    try {
      const realRoot = await realpath(root)
      const realTarget = await realpath(target)
      if (isAtOrBelow(realTarget, realRoot)) return true
    } catch (err) {
      log.debug(`memory read exemption declined for ${toolName} against ${root}: ${errMessage(err)}`)
    }
  }
  return false
}